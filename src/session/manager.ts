/**
 * Session Manager - tracks and manages Claude Code agent sessions
 */
import type {
  EventBuffer,
  FinishFn,
  FinishSource,
  PermissionRequestRecord,
  PermissionResult,
  PublicSessionInfo,
  SensitiveSessionInfo,
  SessionInfo,
  PermissionMode,
  SessionEvent,
  SessionStatus,
  StoredAgentResult,
} from "../types.js";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const DEFAULT_RUNNING_SESSION_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours max for running sessions
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

const DEFAULT_EVENT_BUFFER_MAX_SIZE = 1000;
const DEFAULT_EVENT_BUFFER_HARD_MAX_SIZE = 2000;

type PendingPermission = {
  record: PermissionRequestRecord;
  finish: FinishFn;
  timeoutId?: ReturnType<typeof setTimeout>;
};

type SessionRuntimeState = {
  buffer: EventBuffer;
  pendingPermissions: Map<string, PendingPermission>;
  storedResult?: StoredAgentResult;
  initTools?: string[];
};

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private runtime = new Map<string, SessionRuntimeState>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  private runningSessionMaxMs = DEFAULT_RUNNING_SESSION_MAX_MS;

  constructor() {
    // Periodically clean up expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  create(params: {
    sessionId: string;
    cwd: string;
    model?: string;
    permissionMode?: PermissionMode;
    allowedTools?: SessionInfo["allowedTools"];
    disallowedTools?: SessionInfo["disallowedTools"];
    tools?: SessionInfo["tools"];
    maxTurns?: SessionInfo["maxTurns"];
    systemPrompt?: SessionInfo["systemPrompt"];
    agents?: SessionInfo["agents"];
    maxBudgetUsd?: SessionInfo["maxBudgetUsd"];
    effort?: SessionInfo["effort"];
    betas?: SessionInfo["betas"];
    additionalDirectories?: SessionInfo["additionalDirectories"];
    outputFormat?: SessionInfo["outputFormat"];
    thinking?: SessionInfo["thinking"];
    persistSession?: SessionInfo["persistSession"];
    pathToClaudeCodeExecutable?: SessionInfo["pathToClaudeCodeExecutable"];
    agent?: SessionInfo["agent"];
    mcpServers?: SessionInfo["mcpServers"];
    sandbox?: SessionInfo["sandbox"];
    fallbackModel?: SessionInfo["fallbackModel"];
    enableFileCheckpointing?: SessionInfo["enableFileCheckpointing"];
    includePartialMessages?: SessionInfo["includePartialMessages"];
    strictMcpConfig?: SessionInfo["strictMcpConfig"];
    settingSources?: SessionInfo["settingSources"];
    debug?: SessionInfo["debug"];
    debugFile?: SessionInfo["debugFile"];
    env?: SessionInfo["env"];
    abortController?: AbortController;
  }): SessionInfo {
    const now = new Date().toISOString();
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      throw new Error(`Session '${params.sessionId}' already exists (status: ${existing.status})`);
    }
    const info: SessionInfo = {
      sessionId: params.sessionId,
      status: "running",
      createdAt: now,
      lastActiveAt: now,
      totalTurns: 0,
      totalCostUsd: 0,
      cwd: params.cwd,
      model: params.model,
      permissionMode: params.permissionMode ?? "default",
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
      tools: params.tools,
      maxTurns: params.maxTurns,
      systemPrompt: params.systemPrompt,
      agents: params.agents,
      maxBudgetUsd: params.maxBudgetUsd,
      effort: params.effort,
      betas: params.betas,
      additionalDirectories: params.additionalDirectories,
      outputFormat: params.outputFormat,
      thinking: params.thinking,
      persistSession: params.persistSession,
      pathToClaudeCodeExecutable: params.pathToClaudeCodeExecutable,
      agent: params.agent,
      mcpServers: params.mcpServers,
      sandbox: params.sandbox,
      fallbackModel: params.fallbackModel,
      enableFileCheckpointing: params.enableFileCheckpointing,
      includePartialMessages: params.includePartialMessages,
      strictMcpConfig: params.strictMcpConfig,
      settingSources: params.settingSources,
      debug: params.debug,
      debugFile: params.debugFile,
      env: params.env,
      abortController: params.abortController,
    };
    this.sessions.set(params.sessionId, info);
    this.runtime.set(params.sessionId, {
      buffer: {
        events: [],
        maxSize: DEFAULT_EVENT_BUFFER_MAX_SIZE,
        hardMaxSize: DEFAULT_EVENT_BUFFER_HARD_MAX_SIZE,
        nextId: 0,
      },
      pendingPermissions: new Map(),
    });
    return info;
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionInfo | undefined {
    return this.update(sessionId, { status });
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  update(
    sessionId: string,
    patch: Partial<Omit<SessionInfo, "sessionId" | "createdAt" | "lastActiveAt">>
  ): SessionInfo | undefined {
    const info = this.sessions.get(sessionId);
    if (!info) return undefined;
    Object.assign(info, patch, { lastActiveAt: new Date().toISOString() });
    return info;
  }

  /**
   * Atomically transition a session from an expected status to "running".
   * Returns the session if successful, undefined if the session doesn't exist
   * or its current status doesn't match `expectedStatus`.
   */
  tryAcquire(
    sessionId: string,
    expectedStatus: SessionStatus,
    abortController: AbortController
  ): SessionInfo | undefined {
    if (expectedStatus !== "idle" && expectedStatus !== "error") return undefined;
    const info = this.sessions.get(sessionId);
    if (!info || info.status !== expectedStatus) return undefined;
    info.status = "running";
    info.abortController = abortController;
    info.lastActiveAt = new Date().toISOString();
    // M5 fix: clear stale result/error events at the idle/error → running
    // transition so the new run's event stream starts clean.
    this.clearTerminalEvents(sessionId);
    return info;
  }

  cancel(sessionId: string, opts?: { reason?: string; source?: string }): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    if (info.status !== "running" && info.status !== "waiting_permission") return false;

    if (info.status === "waiting_permission") {
      this.finishAllPending(
        sessionId,
        { behavior: "deny", message: "Session cancelled", interrupt: true },
        "cancel"
      );
    }
    if (info.abortController) {
      info.abortController.abort();
    }
    info.status = "cancelled";
    info.cancelledAt = new Date().toISOString();
    info.cancelledReason = opts?.reason ?? "Session cancelled";
    info.cancelledSource = opts?.source ?? "cancel";
    info.lastActiveAt = new Date().toISOString();
    return true;
  }

  delete(sessionId: string): boolean {
    this.finishAllPending(
      sessionId,
      { behavior: "deny", message: "Session deleted", interrupt: true },
      "cleanup"
    );
    this.runtime.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  setResult(sessionId: string, result: StoredAgentResult): void {
    const state = this.runtime.get(sessionId);
    if (!state) return;
    state.storedResult = result;
  }

  getResult(sessionId: string): StoredAgentResult | undefined {
    return this.runtime.get(sessionId)?.storedResult;
  }

  setInitTools(sessionId: string, tools: string[]): void {
    const state = this.runtime.get(sessionId);
    if (!state) return;
    state.initTools = tools;
  }

  getInitTools(sessionId: string): string[] | undefined {
    return this.runtime.get(sessionId)?.initTools;
  }

  pushEvent(
    sessionId: string,
    event: Omit<SessionEvent, "id" | "pinned"> & { pinned?: boolean }
  ): SessionEvent | undefined {
    const state = this.runtime.get(sessionId);
    if (!state) return undefined;
    const full = SessionManager.pushEvent(state.buffer, event, (requestId) =>
      state.pendingPermissions.has(requestId)
    );
    const info = this.sessions.get(sessionId);
    if (info) {
      info.lastActiveAt = new Date().toISOString();

      const data = event.data as Record<string, unknown> | null;
      const toolUseId =
        (typeof data?.tool_use_id === "string" && data.tool_use_id) ||
        (typeof data?.toolUseID === "string" && data.toolUseID) ||
        (typeof data?.parent_tool_use_id === "string" && data.parent_tool_use_id) ||
        undefined;
      if (toolUseId) info.lastToolUseId = toolUseId;
    }
    return full;
  }

  getLastEventId(sessionId: string): number | undefined {
    const state = this.runtime.get(sessionId);
    if (!state) return undefined;
    return state.buffer.nextId > 0 ? state.buffer.nextId - 1 : undefined;
  }

  readEvents(
    sessionId: string,
    cursor?: number
  ): {
    events: SessionEvent[];
    nextCursor: number;
    cursorResetTo?: number;
  } {
    const state = this.runtime.get(sessionId);
    if (!state) return { events: [], nextCursor: cursor ?? 0 };
    return SessionManager.readEvents(state.buffer, cursor);
  }

  clearTerminalEvents(sessionId: string): void {
    const state = this.runtime.get(sessionId);
    if (!state) return;
    SessionManager.clearTerminalEvents(state.buffer);
  }

  setPendingPermission(
    sessionId: string,
    req: PermissionRequestRecord,
    finish: FinishFn,
    timeoutMs: number
  ): boolean {
    const state = this.runtime.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (!state || !info) return false;

    if (!state.pendingPermissions.has(req.requestId)) {
      const timeoutId = setTimeout(() => {
        this.finishRequest(
          sessionId,
          req.requestId,
          {
            behavior: "deny",
            message: `Permission request timed out after ${timeoutMs}ms.`,
            interrupt: false,
          },
          "timeout"
        );
      }, timeoutMs);

      state.pendingPermissions.set(req.requestId, { record: req, finish, timeoutId });
      info.status = "waiting_permission";
      info.lastActiveAt = new Date().toISOString();

      this.pushEvent(sessionId, {
        type: "permission_request",
        data: req,
        timestamp: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  getPendingPermissionCount(sessionId: string): number {
    return this.runtime.get(sessionId)?.pendingPermissions.size ?? 0;
  }

  listPendingPermissions(sessionId: string): PermissionRequestRecord[] {
    const state = this.runtime.get(sessionId);
    if (!state) return [];
    return Array.from(state.pendingPermissions.values())
      .map((p) => p.record)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  finishRequest(
    sessionId: string,
    requestId: string,
    result: PermissionResult,
    source: FinishSource
  ): boolean {
    const state = this.runtime.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (!state || !info) return false;

    const pending = state.pendingPermissions.get(requestId);
    if (!pending) return false;

    let finalResult = result;
    if (finalResult.behavior === "allow") {
      const disallowed = info.disallowedTools;
      if (
        Array.isArray(disallowed) &&
        disallowed.includes(pending.record.toolName) &&
        pending.record.toolName.trim() !== ""
      ) {
        finalResult = {
          behavior: "deny",
          message: `Tool '${pending.record.toolName}' is disallowed by session policy.`,
          interrupt: false,
        };
      }
    }

    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    state.pendingPermissions.delete(requestId);

    this.pushEvent(sessionId, {
      type: "permission_result",
      data: { requestId, behavior: finalResult.behavior, source },
      timestamp: new Date().toISOString(),
    });

    try {
      pending.finish(finalResult);
    } catch {
      // ignore finish errors
    }

    if (info.status === "waiting_permission" && state.pendingPermissions.size === 0) {
      info.status = "running";
      info.lastActiveAt = new Date().toISOString();
    }

    return true;
  }

  finishAllPending(sessionId: string, result: PermissionResult, source: FinishSource): void {
    const state = this.runtime.get(sessionId);
    if (!state) return;
    for (const requestId of Array.from(state.pendingPermissions.keys())) {
      this.finishRequest(sessionId, requestId, result, source);
    }
  }

  /** Remove sessions that have been idle for too long, or stuck running too long */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, info] of this.sessions) {
      const lastActive = new Date(info.lastActiveAt).getTime();
      if (Number.isNaN(lastActive)) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session expired", interrupt: true },
          "cleanup"
        );
        // Invalid timestamp — remove the session
        this.sessions.delete(id);
        this.runtime.delete(id);
      } else if (info.status === "running" && now - lastActive > this.runningSessionMaxMs) {
        // Stuck running session — abort and mark as error
        if (info.abortController) info.abortController.abort();
        info.status = "error";
        info.lastActiveAt = new Date().toISOString();
      } else if (
        info.status === "waiting_permission" &&
        now - lastActive > this.runningSessionMaxMs
      ) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session timed out", interrupt: true },
          "cleanup"
        );
        if (info.abortController) info.abortController.abort();
        info.status = "error";
        info.lastActiveAt = new Date().toISOString();
      } else if (
        info.status !== "running" &&
        info.status !== "waiting_permission" &&
        now - lastActive > this.sessionTtlMs
      ) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session expired", interrupt: true },
          "cleanup"
        );
        this.sessions.delete(id);
        this.runtime.delete(id);
      }
    }
  }

  /**
   * Serialize session info for external consumption.
   * Prefer explicit serializers below. This method is kept for backward compatibility
   * but returns the redacted public shape.
   */
  toJSON(info: SessionInfo): PublicSessionInfo {
    return this.toPublicJSON(info);
  }

  /** Serialize session info when includeSensitive=true (still excludes secrets like env) */
  toSensitiveJSON(info: SessionInfo): SensitiveSessionInfo {
    const base = this.toPublicJSON(info);
    return {
      ...base,
      cwd: info.cwd,
      systemPrompt: info.systemPrompt,
      agents: info.agents,
      additionalDirectories: info.additionalDirectories,
    };
  }

  /** Serialize session info for listing/inspection (redacts sensitive fields) */
  toPublicJSON(info: SessionInfo): PublicSessionInfo {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      abortController: _abortController,
      cwd: _cwd,
      systemPrompt: _systemPrompt,
      agents: _agents,
      additionalDirectories: _additionalDirectories,
      pathToClaudeCodeExecutable: _pathToClaudeCodeExecutable,
      mcpServers: _mcpServers,
      sandbox: _sandbox,
      settingSources: _settingSources,
      debugFile: _debugFile,
      env: _env,
      ...rest
    } = info;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    return rest;
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    for (const info of this.sessions.values()) {
      this.finishAllPending(
        info.sessionId,
        { behavior: "deny", message: "Server shutting down", interrupt: true },
        "destroy"
      );
      // M6 fix: explicitly abort any session that has an active consumer,
      // regardless of whether it is "running" or "waiting_permission".
      if (
        (info.status === "running" || info.status === "waiting_permission") &&
        info.abortController
      ) {
        info.abortController.abort();
      }
      info.status = "cancelled";
      info.cancelledAt = info.cancelledAt ?? new Date().toISOString();
      info.cancelledReason = info.cancelledReason ?? "Server shutting down";
      info.cancelledSource = info.cancelledSource ?? "destroy";
      info.lastActiveAt = new Date().toISOString();
    }
    // Don't clear immediately — in-flight operations may still reference sessions.
    // Sessions will be garbage-collected when the process exits.
  }

  private static pushEvent(
    buffer: EventBuffer,
    event: Omit<SessionEvent, "id" | "pinned"> & { pinned?: boolean },
    isActivePermissionRequest?: (requestId: string) => boolean
  ): SessionEvent {
    const pinned =
      event.pinned ??
      (event.type === "permission_request" ||
        event.type === "permission_result" ||
        event.type === "result" ||
        event.type === "error");

    const full: SessionEvent = {
      id: buffer.nextId++,
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
      pinned,
    };

    buffer.events.push(full);

    while (buffer.events.length > buffer.maxSize) {
      const idx = buffer.events.findIndex((e) => !e.pinned);
      if (idx !== -1) {
        buffer.events.splice(idx, 1);
        continue;
      }

      // If everything is pinned, prefer dropping old permission-related events first.
      const pinnedDropIdx = buffer.events.findIndex((e) => {
        if (e.type === "permission_result") return true;
        if (e.type === "permission_request") {
          const requestId = (e.data as { requestId?: unknown } | null)?.requestId;
          if (typeof requestId !== "string") return true;
          return isActivePermissionRequest ? !isActivePermissionRequest(requestId) : true;
        }
        return false;
      });
      if (pinnedDropIdx === -1) break;
      buffer.events.splice(pinnedDropIdx, 1);
    }

    while (buffer.events.length > buffer.hardMaxSize) {
      const idx = buffer.events.findIndex((e) => {
        if (e.type === "permission_request") {
          const requestId = (e.data as { requestId?: unknown } | null)?.requestId;
          if (typeof requestId !== "string") return true;
          return isActivePermissionRequest ? !isActivePermissionRequest(requestId) : true;
        }
        if (e.type === "permission_result") return true;
        return false;
      });
      if (idx === -1) break;
      buffer.events.splice(idx, 1);
    }

    return full;
  }

  private static readEvents(
    buffer: EventBuffer,
    cursor?: number
  ): { events: SessionEvent[]; nextCursor: number; cursorResetTo?: number } {
    let cursorResetTo: number | undefined;
    if (cursor != null) {
      const earliest = buffer.events[0]?.id;
      if (earliest != null && earliest > cursor) cursorResetTo = earliest;
      if (earliest == null && buffer.nextId > cursor) cursorResetTo = buffer.nextId;
    }

    const startFrom = cursorResetTo ?? cursor ?? 0;
    const filtered = buffer.events.filter((e) => e.id >= startFrom);
    const nextCursor = filtered.length > 0 ? filtered[filtered.length - 1].id + 1 : startFrom;

    return { events: filtered, nextCursor, cursorResetTo };
  }

  private static clearTerminalEvents(buffer: EventBuffer): void {
    buffer.events = buffer.events.filter((e) => e.type !== "result" && e.type !== "error");
  }
}
