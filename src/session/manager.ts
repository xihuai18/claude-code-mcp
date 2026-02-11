/**
 * Session Manager - tracks and manages Claude Code agent sessions
 */
import type { PublicSessionInfo, SessionInfo, PermissionMode, SessionStatus } from "../types.js";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const DEFAULT_RUNNING_SESSION_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours max for running sessions
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private sessionTtlMs: number;
  private runningSessionMaxMs: number;

  constructor(opts?: {
    sessionTtlMs?: number;
    runningSessionMaxMs?: number;
    cleanupIntervalMs?: number;
  }) {
    this.sessionTtlMs =
      opts?.sessionTtlMs !== undefined ? opts.sessionTtlMs : DEFAULT_SESSION_TTL_MS;
    this.runningSessionMaxMs =
      opts?.runningSessionMaxMs !== undefined
        ? opts.runningSessionMaxMs
        : DEFAULT_RUNNING_SESSION_MAX_MS;
    const cleanupIntervalMs =
      opts?.cleanupIntervalMs !== undefined ? opts.cleanupIntervalMs : DEFAULT_CLEANUP_INTERVAL_MS;

    // Periodically clean up expired sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
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
    return info;
  }

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
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
    return info;
  }

  cancel(sessionId: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    if (info.status !== "running") return false;
    if (info.abortController) {
      info.abortController.abort();
    }
    info.status = "cancelled";
    info.lastActiveAt = new Date().toISOString();
    return true;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Remove sessions that have been idle for too long, or stuck running too long */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, info] of this.sessions) {
      const lastActive = new Date(info.lastActiveAt).getTime();
      if (Number.isNaN(lastActive)) {
        // Invalid timestamp — remove the session
        this.sessions.delete(id);
      } else if (info.status === "running" && now - lastActive > this.runningSessionMaxMs) {
        // Stuck running session — abort and mark as error
        if (info.abortController) info.abortController.abort();
        info.status = "error";
        info.lastActiveAt = new Date().toISOString();
      } else if (info.status !== "running" && now - lastActive > this.sessionTtlMs) {
        this.sessions.delete(id);
      }
    }
  }

  /** Serialize session info for external consumption (strip internal fields) */
  toJSON(info: SessionInfo): Omit<SessionInfo, "abortController"> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { abortController: _, ...rest } = info;
    return rest;
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
      if (info.status === "running" && info.abortController) {
        info.abortController.abort();
      }
      info.status = "cancelled";
    }
    // Don't clear immediately — in-flight operations may still reference sessions.
    // Sessions will be garbage-collected when the process exits.
  }
}
