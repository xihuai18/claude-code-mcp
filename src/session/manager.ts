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
import { normalizePermissionUpdatedInput } from "../utils/permission-updated-input.js";
import { normalizeToolInput } from "../utils/normalize-tool-input.js";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const DEFAULT_RUNNING_SESSION_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours max for running sessions
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

const DEFAULT_EVENT_BUFFER_MAX_SIZE = 1000;
const DEFAULT_EVENT_BUFFER_HARD_MAX_SIZE = 2000;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_MAX_PENDING_PERMISSIONS_PER_SESSION = 64;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizePositiveNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

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
  private drainingSessions = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private sessionTtlMs = DEFAULT_SESSION_TTL_MS;
  private runningSessionMaxMs = DEFAULT_RUNNING_SESSION_MAX_MS;
  private platform: NodeJS.Platform;
  private maxSessions: number;
  private maxPendingPermissionsPerSession: number;
  private eventBufferMaxSize: number;
  private eventBufferHardMaxSize: number;
  private destroyed = false;

  constructor(opts?: {
    platform?: NodeJS.Platform;
    maxSessions?: number;
    maxPendingPermissionsPerSession?: number;
    eventBufferMaxSize?: number;
    eventBufferHardMaxSize?: number;
  }) {
    this.platform = opts?.platform ?? process.platform;
    const envRaw = process.env.CLAUDE_CODE_MCP_MAX_SESSIONS;
    const envParsed =
      typeof envRaw === "string" && envRaw.trim() !== "" ? Number.parseInt(envRaw, 10) : NaN;
    const configured = opts?.maxSessions ?? (Number.isFinite(envParsed) ? envParsed : undefined);
    this.maxSessions =
      typeof configured === "number"
        ? configured <= 0
          ? Number.POSITIVE_INFINITY
          : configured
        : DEFAULT_MAX_SESSIONS;

    const maxPendingEnvRaw = process.env.CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS;
    const maxPendingEnvParsed =
      typeof maxPendingEnvRaw === "string" && maxPendingEnvRaw.trim() !== ""
        ? Number.parseInt(maxPendingEnvRaw, 10)
        : NaN;
    const maxPendingConfigured =
      opts?.maxPendingPermissionsPerSession ??
      (Number.isFinite(maxPendingEnvParsed) ? maxPendingEnvParsed : undefined);
    this.maxPendingPermissionsPerSession =
      typeof maxPendingConfigured === "number"
        ? maxPendingConfigured <= 0
          ? Number.POSITIVE_INFINITY
          : maxPendingConfigured
        : DEFAULT_MAX_PENDING_PERMISSIONS_PER_SESSION;

    const configuredEventBufferMaxSize =
      normalizePositiveNumber(opts?.eventBufferMaxSize) ??
      parsePositiveInt(process.env.CLAUDE_CODE_MCP_EVENT_BUFFER_MAX_SIZE);
    const configuredEventBufferHardMaxSize =
      normalizePositiveNumber(opts?.eventBufferHardMaxSize) ??
      parsePositiveInt(process.env.CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE);

    this.eventBufferMaxSize = configuredEventBufferMaxSize ?? DEFAULT_EVENT_BUFFER_MAX_SIZE;
    const initialHardMaxSize =
      configuredEventBufferHardMaxSize ?? DEFAULT_EVENT_BUFFER_HARD_MAX_SIZE;
    this.eventBufferHardMaxSize = Math.max(this.eventBufferMaxSize, initialHardMaxSize);
    if (initialHardMaxSize < this.eventBufferMaxSize) {
      console.error(
        `[config] CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE (${initialHardMaxSize}) is smaller than maxSize (${this.eventBufferMaxSize}); clamped to ${this.eventBufferHardMaxSize}.`
      );
    }

    // Periodically clean up expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), DEFAULT_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  getSessionCount(): number {
    if (this.destroyed) return 0;
    return this.sessions.size;
  }

  getMaxSessions(): number {
    return this.maxSessions;
  }

  getMaxPendingPermissionsPerSession(): number {
    return this.maxPendingPermissionsPerSession;
  }

  getEventBufferConfig(): { maxSize: number; hardMaxSize: number } {
    return {
      maxSize: this.eventBufferMaxSize,
      hardMaxSize: this.eventBufferHardMaxSize,
    };
  }

  getSessionTtlMs(): number {
    return this.sessionTtlMs;
  }

  getRunningSessionMaxMs(): number {
    return this.runningSessionMaxMs;
  }

  hasCapacityFor(additionalSessions: number): boolean {
    if (this.destroyed) return false;
    if (additionalSessions <= 0) return true;
    return this.sessions.size + additionalSessions <= this.maxSessions;
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
    if (this.destroyed) {
      throw new Error("SessionManager is destroyed and no longer accepts new sessions.");
    }

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
        maxSize: this.eventBufferMaxSize,
        hardMaxSize: this.eventBufferHardMaxSize,
        nextId: 0,
      },
      pendingPermissions: new Map(),
    });
    return info;
  }

  get(sessionId: string): SessionInfo | undefined {
    if (this.destroyed) return undefined;
    return this.sessions.get(sessionId);
  }

  updateStatus(sessionId: string, status: SessionStatus): SessionInfo | undefined {
    return this.update(sessionId, { status });
  }

  list(): SessionInfo[] {
    if (this.destroyed) return [];
    return Array.from(this.sessions.values());
  }

  update(
    sessionId: string,
    patch: Partial<Omit<SessionInfo, "sessionId" | "createdAt" | "lastActiveAt">>
  ): SessionInfo | undefined {
    if (this.destroyed) return undefined;
    const info = this.sessions.get(sessionId);
    if (!info) return undefined;
    Object.assign(info, patch, { lastActiveAt: new Date().toISOString() });
    return info;
  }

  /**
   * Atomically transition a session's status from expectedStatus to "running".
   * This only covers synchronous state mutation within SessionManager.
   * Returns the session if successful, undefined if the session doesn't exist
   * or its current status doesn't match `expectedStatus`.
   */
  tryAcquire(
    sessionId: string,
    expectedStatus: SessionStatus,
    abortController: AbortController
  ): SessionInfo | undefined {
    if (this.destroyed) return undefined;
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
    if (this.destroyed) return false;
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    if (info.status !== "running" && info.status !== "waiting_permission") return false;

    if (info.status === "waiting_permission") {
      this.finishAllPending(
        sessionId,
        // `cancel()` already aborts the running query below. Avoid sending an additional
        // interrupt=true control response while the stream is being torn down, which can race
        // into SDK-level "Operation aborted" write errors on stdio clients.
        { behavior: "deny", message: "Session cancelled", interrupt: false },
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
    if (this.destroyed) return false;
    this.finishAllPending(
      sessionId,
      { behavior: "deny", message: "Session deleted", interrupt: true },
      "cleanup",
      { restoreRunning: false }
    );
    this.drainingSessions.delete(sessionId);
    this.runtime.delete(sessionId);
    return this.sessions.delete(sessionId);
  }

  setResult(sessionId: string, result: StoredAgentResult): void {
    if (this.destroyed) return;
    const state = this.runtime.get(sessionId);
    if (!state) return;
    state.storedResult = result;
  }

  getResult(sessionId: string): StoredAgentResult | undefined {
    if (this.destroyed) return undefined;
    return this.runtime.get(sessionId)?.storedResult;
  }

  setInitTools(sessionId: string, tools: string[]): void {
    if (this.destroyed) return;
    const state = this.runtime.get(sessionId);
    if (!state) return;
    state.initTools = tools;
  }

  getInitTools(sessionId: string): string[] | undefined {
    if (this.destroyed) return undefined;
    return this.runtime.get(sessionId)?.initTools;
  }

  pushEvent(
    sessionId: string,
    event: Omit<SessionEvent, "id" | "pinned"> & { pinned?: boolean }
  ): SessionEvent | undefined {
    if (this.destroyed) return undefined;
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
    if (this.destroyed) return undefined;
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
    if (this.destroyed) return { events: [], nextCursor: cursor ?? 0 };
    const state = this.runtime.get(sessionId);
    if (!state) return { events: [], nextCursor: cursor ?? 0 };
    return SessionManager.readEvents(state.buffer, cursor);
  }

  clearTerminalEvents(sessionId: string): void {
    if (this.destroyed) return;
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
    if (this.destroyed) return false;
    const state = this.runtime.get(sessionId);
    const info = this.sessions.get(sessionId);
    if (!state || !info) return false;
    if (info.status !== "running" && info.status !== "waiting_permission") {
      try {
        finish({
          behavior: "deny",
          message: `Session is not accepting permission requests (status: ${info.status}).`,
          interrupt: true,
        });
      } catch {
        // ignore finish errors
      }
      return false;
    }
    if (this.isDraining(sessionId)) {
      try {
        finish({
          behavior: "deny",
          message: "Session is finishing pending permission requests.",
          interrupt: true,
        });
      } catch {
        // ignore finish errors
      }
      return false;
    }

    if (!state.pendingPermissions.has(req.requestId)) {
      if (state.pendingPermissions.size >= this.maxPendingPermissionsPerSession) {
        const deny: PermissionResult = {
          behavior: "deny",
          message: "Too many pending permission requests for this session.",
          interrupt: false,
        };
        this.pushEvent(sessionId, {
          type: "permission_result",
          data: {
            requestId: req.requestId,
            toolName: req.toolName,
            behavior: "deny",
            source: "policy",
            message: deny.message,
            interrupt: deny.interrupt,
          },
          timestamp: new Date().toISOString(),
        });
        try {
          finish(deny);
        } catch {
          // ignore finish errors
        }
        return false;
      }
      const inferredExpiresAt = new Date(Date.now() + timeoutMs).toISOString();
      const record: PermissionRequestRecord = {
        ...req,
        timeoutMs,
        expiresAt: inferredExpiresAt,
      };

      const timeoutId = setTimeout(() => {
        this.finishRequest(
          sessionId,
          record.requestId,
          {
            behavior: "deny",
            message: `Permission request timed out after ${timeoutMs}ms.`,
            interrupt: false,
          },
          "timeout"
        );
      }, timeoutMs);

      state.pendingPermissions.set(record.requestId, { record, finish, timeoutId });
      info.status = "waiting_permission";
      info.lastActiveAt = new Date().toISOString();

      this.pushEvent(sessionId, {
        type: "permission_request",
        data: record,
        timestamp: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  getPendingPermissionCount(sessionId: string): number {
    if (this.destroyed) return 0;
    return this.runtime.get(sessionId)?.pendingPermissions.size ?? 0;
  }

  getEventCount(sessionId: string): number {
    if (this.destroyed) return 0;
    return this.runtime.get(sessionId)?.buffer.events.length ?? 0;
  }

  getCurrentCursor(sessionId: string): number | undefined {
    if (this.destroyed) return undefined;
    const state = this.runtime.get(sessionId);
    if (!state) return undefined;
    return state.buffer.nextId;
  }

  getRemainingTtlMs(sessionId: string): number | undefined {
    if (this.destroyed) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const lastActiveMs = Date.parse(session.lastActiveAt);
    if (!Number.isFinite(lastActiveMs)) return undefined;
    const limitMs =
      session.status === "running" || session.status === "waiting_permission"
        ? this.runningSessionMaxMs
        : this.sessionTtlMs;
    return Math.max(0, limitMs - (Date.now() - lastActiveMs));
  }

  getRuntimeToolStats(): {
    sessionsWithInitTools: number;
    runtimeDiscoveredUniqueCount: number;
  } {
    if (this.destroyed) {
      return { sessionsWithInitTools: 0, runtimeDiscoveredUniqueCount: 0 };
    }
    const unique = new Set<string>();
    let sessionsWithInitTools = 0;
    for (const state of this.runtime.values()) {
      if (!Array.isArray(state.initTools) || state.initTools.length === 0) continue;
      sessionsWithInitTools += 1;
      for (const tool of state.initTools) {
        if (typeof tool === "string" && tool.trim() !== "") {
          unique.add(tool);
        }
      }
    }
    return {
      sessionsWithInitTools,
      runtimeDiscoveredUniqueCount: unique.size,
    };
  }

  listPendingPermissions(sessionId: string): PermissionRequestRecord[] {
    if (this.destroyed) return [];
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
    if (this.destroyed) return false;
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
    if (finalResult.behavior === "allow") {
      const updatedInput = (finalResult as { updatedInput?: unknown }).updatedInput;
      const validRecord =
        updatedInput !== null &&
        updatedInput !== undefined &&
        typeof updatedInput === "object" &&
        !Array.isArray(updatedInput);
      if (!validRecord) {
        finalResult = {
          ...finalResult,
          updatedInput: normalizePermissionUpdatedInput(pending.record.input),
        };
      } else {
        // Caller-provided updatedInput should be normalized consistently with our tool input normalization.
        finalResult = {
          ...finalResult,
          updatedInput: normalizeToolInput(
            pending.record.toolName,
            updatedInput as Record<string, unknown>,
            this.platform
          ),
        };
      }
    }

    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    state.pendingPermissions.delete(requestId);

    const eventData: Record<string, unknown> = {
      requestId,
      toolName: pending.record.toolName,
      behavior: finalResult.behavior,
      source,
    };
    if (finalResult.behavior === "deny") {
      eventData.message = finalResult.message;
      eventData.interrupt = finalResult.interrupt;
    } else {
      const allow = finalResult as Record<string, unknown>;
      if (allow.updatedInput !== undefined) eventData.updatedInput = allow.updatedInput;
      if (allow.updatedPermissions !== undefined)
        eventData.updatedPermissions = allow.updatedPermissions;
    }

    this.pushEvent(sessionId, {
      type: "permission_result",
      data: eventData,
      timestamp: new Date().toISOString(),
    });

    try {
      pending.finish(finalResult);
    } catch {
      // ignore finish errors
    }

    if (
      info.status === "waiting_permission" &&
      state.pendingPermissions.size === 0 &&
      !this.isDraining(sessionId)
    ) {
      info.status = "running";
      info.lastActiveAt = new Date().toISOString();
    }

    return true;
  }

  finishAllPending(
    sessionId: string,
    result: PermissionResult,
    source: FinishSource,
    opts?: { restoreRunning?: boolean }
  ): void {
    if (this.destroyed) return;
    const state = this.runtime.get(sessionId);
    if (!state) return;
    if (state.pendingPermissions.size === 0) return;

    this.beginDraining(sessionId);
    try {
      // Drain until empty so requests created during finish callbacks are also resolved.
      while (state.pendingPermissions.size > 0) {
        const next = state.pendingPermissions.keys().next();
        if (next.done || typeof next.value !== "string") break;

        const requestId = next.value;
        const handled = this.finishRequest(sessionId, requestId, result, source);
        if (!handled) {
          const pending = state.pendingPermissions.get(requestId);
          if (pending?.timeoutId) clearTimeout(pending.timeoutId);
          state.pendingPermissions.delete(requestId);
          try {
            pending?.finish(result);
          } catch {
            // ignore finish errors
          }
        }
      }
    } finally {
      this.endDraining(sessionId);
    }

    const restoreRunning = opts?.restoreRunning ?? true;
    const info = this.sessions.get(sessionId);
    if (
      restoreRunning &&
      info &&
      info.status === "waiting_permission" &&
      state.pendingPermissions.size === 0
    ) {
      info.status = "running";
      info.lastActiveAt = new Date().toISOString();
    }
  }

  /** Remove sessions that have been idle for too long, or stuck running too long */
  private cleanup(): void {
    if (this.destroyed) return;
    const now = Date.now();
    for (const [id, info] of this.sessions) {
      const lastActive = new Date(info.lastActiveAt).getTime();
      if (Number.isNaN(lastActive)) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session expired", interrupt: true },
          "cleanup",
          { restoreRunning: false }
        );
        // Invalid timestamp — remove the session
        this.drainingSessions.delete(id);
        this.sessions.delete(id);
        this.runtime.delete(id);
      } else if (info.status === "running" && now - lastActive > this.runningSessionMaxMs) {
        // Stuck running session — abort and mark as cancelled (timeout).
        if (info.abortController) info.abortController.abort();
        info.cancelledAt = info.cancelledAt ?? new Date().toISOString();
        info.cancelledReason = info.cancelledReason ?? "Session timed out";
        info.cancelledSource = info.cancelledSource ?? "cleanup";
        info.status = "cancelled";
        info.lastActiveAt = new Date().toISOString();
      } else if (
        info.status === "waiting_permission" &&
        now - lastActive > this.runningSessionMaxMs
      ) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session timed out", interrupt: true },
          "cleanup",
          { restoreRunning: false }
        );
        if (info.abortController) info.abortController.abort();
        info.cancelledAt = info.cancelledAt ?? new Date().toISOString();
        info.cancelledReason = info.cancelledReason ?? "Session timed out";
        info.cancelledSource = info.cancelledSource ?? "cleanup";
        info.status = "cancelled";
        info.lastActiveAt = new Date().toISOString();
      } else if (
        info.status !== "running" &&
        info.status !== "waiting_permission" &&
        now - lastActive > this.sessionTtlMs
      ) {
        this.finishAllPending(
          id,
          { behavior: "deny", message: "Session expired", interrupt: true },
          "cleanup",
          { restoreRunning: false }
        );
        // Deleting current entries during Map iteration is safe in JavaScript.
        this.drainingSessions.delete(id);
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
    if (this.destroyed) return;
    clearInterval(this.cleanupTimer);
    for (const info of this.sessions.values()) {
      this.finishAllPending(
        info.sessionId,
        { behavior: "deny", message: "Server shutting down", interrupt: true },
        "destroy",
        { restoreRunning: false }
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
    this.drainingSessions.clear();
    this.runtime.clear();
    this.sessions.clear();
    this.destroyed = true;
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

    SessionManager.evictEventsToLimits(buffer, isActivePermissionRequest);

    return full;
  }

  private static evictEventsToLimits(
    buffer: EventBuffer,
    isActivePermissionRequest?: (requestId: string) => boolean
  ): void {
    if (buffer.events.length <= buffer.maxSize && buffer.events.length <= buffer.hardMaxSize) {
      return;
    }

    const droppedIds = new Set<number>();
    let remaining = buffer.events.length;

    const dropOldestMatching = (count: number, predicate: (e: SessionEvent) => boolean): number => {
      if (count <= 0) return 0;
      let dropped = 0;
      for (const event of buffer.events) {
        if (dropped >= count) break;
        if (droppedIds.has(event.id)) continue;
        if (!predicate(event)) continue;
        droppedIds.add(event.id);
        dropped += 1;
      }
      if (dropped > 0) {
        remaining -= dropped;
      }
      return dropped;
    };

    const isDroppablePermissionEvent = (event: SessionEvent): boolean => {
      if (event.type === "permission_result") return true;
      if (event.type !== "permission_request") return false;
      const requestId = (event.data as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId !== "string") return true;
      return isActivePermissionRequest ? !isActivePermissionRequest(requestId) : true;
    };

    // Soft limit: prefer dropping unpinned events first.
    let toDropForSoftLimit = remaining - buffer.maxSize;
    if (toDropForSoftLimit > 0) {
      toDropForSoftLimit -= dropOldestMatching(toDropForSoftLimit, (event) => !event.pinned);
    }
    if (toDropForSoftLimit > 0) {
      toDropForSoftLimit -= dropOldestMatching(toDropForSoftLimit, isDroppablePermissionEvent);
    }

    // Hard limit: only drop permission-related pinned events that are safe to evict.
    let toDropForHardLimit = remaining - buffer.hardMaxSize;
    if (toDropForHardLimit > 0) {
      toDropForHardLimit -= dropOldestMatching(toDropForHardLimit, isDroppablePermissionEvent);
    }

    if (droppedIds.size > 0) {
      buffer.events = buffer.events.filter((event) => !droppedIds.has(event.id));
    }
  }

  private static lowerBoundByEventId(events: SessionEvent[], startFrom: number): number {
    let left = 0;
    let right = events.length;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (events[mid]!.id < startFrom) left = mid + 1;
      else right = mid;
    }
    return left;
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
    const startIndex = SessionManager.lowerBoundByEventId(buffer.events, startFrom);
    const filtered = buffer.events.slice(startIndex);
    const nextCursor = filtered.length > 0 ? filtered[filtered.length - 1].id + 1 : startFrom;

    return { events: filtered, nextCursor, cursorResetTo };
  }

  private static clearTerminalEvents(buffer: EventBuffer): void {
    buffer.events = buffer.events.filter((e) => e.type !== "result" && e.type !== "error");
  }

  private isDraining(sessionId: string): boolean {
    return (this.drainingSessions.get(sessionId) ?? 0) > 0;
  }

  private beginDraining(sessionId: string): void {
    this.drainingSessions.set(sessionId, (this.drainingSessions.get(sessionId) ?? 0) + 1);
  }

  private endDraining(sessionId: string): void {
    const current = this.drainingSessions.get(sessionId) ?? 0;
    if (current <= 1) {
      this.drainingSessions.delete(sessionId);
      return;
    }
    this.drainingSessions.set(sessionId, current - 1);
  }
}
