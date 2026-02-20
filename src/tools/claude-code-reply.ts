/**
 * claude_code_reply tool - Continue an existing Claude Code session (async)
 */
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  OutputFormat,
  SandboxSettings,
  SessionStartResult,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  ToolsConfig,
} from "../types.js";
import { ErrorCode } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import {
  computeResumeToken,
  getResumeSecret,
  getResumeSecrets,
  isValidResumeToken,
} from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions } from "../utils/build-options.js";
import type { OptionSource } from "../utils/build-options.js";
import { toSessionCreateParams } from "../utils/session-create.js";
import { normalizeWindowsPathLike } from "../utils/normalize-windows-path.js";

/** Disk resume fallback configuration — only used when the in-memory session is missing. */
export interface DiskResumeConfig {
  resumeToken?: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  persistSession?: boolean;
  maxTurns?: number;
  model?: string;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  resumeSessionAt?: string;
  pathToClaudeCodeExecutable?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: SandboxSettings;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  includePartialMessages?: boolean;
  promptSuggestions?: boolean;
  strictMcpConfig?: boolean;
  strictAllowedTools?: boolean;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  env?: Record<string, string | undefined>;
}

export interface ClaudeCodeReplyInput {
  sessionId: string;
  prompt: string;
  forkSession?: boolean;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;

  /** Timeout waiting for fork init (default 10000ms, only used when forkSession=true) */
  sessionInitTimeoutMs?: number;
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;

  /**
   * Disk resume fallback configuration. Only used when `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`
   * and the in-memory session is missing. Contains resumeToken + all session config overrides.
   */
  diskResumeConfig?: DiskResumeConfig;
}

export type ClaudeCodeReplyStartResult =
  | SessionStartResult
  | { sessionId: string; status: "error"; error: string };

function normalizeAndAssertCwd(cwd: string, contextLabel: string): string {
  const normalizedCwd = normalizeWindowsPathLike(cwd);
  const resolvedCwd = resolvePortableTmpAlias(normalizedCwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} path does not exist: ${resolvedCwd}`
    );
  }
  try {
    const stat = statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      throw new Error(
        `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} must be a directory: ${resolvedCwd}`
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Error [")) throw err;
    const detail = err instanceof Error ? ` (${err.message})` : "";
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: ${contextLabel} is not accessible: ${resolvedCwd}${detail}`
    );
  }
  return resolvedCwd;
}

function resolvePortableTmpAlias(cwd: string): string {
  if (process.platform !== "win32") return cwd;

  const normalized = cwd.replace(/\\/g, "/");
  if (normalized === "/tmp") return os.tmpdir();
  if (normalized.startsWith("/tmp/")) {
    return path.join(os.tmpdir(), normalized.slice("/tmp/".length));
  }
  return cwd;
}

function toStartError(
  sessionId: string,
  err: unknown
): {
  agentResult: {
    sessionId: string;
    result: string;
    isError: true;
    durationMs: 0;
    numTurns: 0;
    totalCostUsd: 0;
  };
  errorText: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const errorText = message.includes("Error [")
    ? message
    : `Error [${ErrorCode.INTERNAL}]: ${message}`;
  return {
    agentResult: {
      sessionId,
      result: errorText,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    },
    errorText,
  };
}

function buildOptionsFromDiskResume(dr: DiskResumeConfig): ReturnType<typeof buildOptions> {
  if (dr.cwd === undefined || typeof dr.cwd !== "string" || dr.cwd.trim() === "") {
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be provided for disk resume.`);
  }
  const normalizedCwd = normalizeAndAssertCwd(dr.cwd, "disk resume cwd");
  return buildOptions({
    ...dr,
    cwd: normalizedCwd,
  } as Parameters<typeof buildOptions>[0]);
}

export async function executeClaudeCodeReply(
  input: ClaudeCodeReplyInput,
  sessionManager: SessionManager,
  toolCache?: ToolDiscoveryCache,
  requestSignal?: AbortSignal
): Promise<ClaudeCodeReplyStartResult> {
  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = input.sessionInitTimeoutMs ?? 10_000;

  const existing = sessionManager.get(input.sessionId);
  if (!existing) {
    if (!sessionManager.hasCapacityFor(1)) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.RESOURCE_EXHAUSTED}]: Too many sessions (limit: ${sessionManager.getMaxSessions()}).`,
      };
    }

    const allowDiskResume = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME === "1";
    if (!allowDiskResume) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
      };
    }

    const resumeSecrets = getResumeSecrets();
    const resumeSecret = resumeSecrets[0];
    if (!resumeSecret) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Disk resume is enabled but CLAUDE_CODE_MCP_RESUME_SECRET is not set.`,
      };
    }

    const dr = input.diskResumeConfig ?? {};
    if (typeof dr.resumeToken !== "string" || dr.resumeToken.trim() === "") {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: resumeToken is required for disk resume fallback.`,
      };
    }
    if (!isValidResumeToken(input.sessionId, dr.resumeToken, resumeSecrets)) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Invalid resumeToken for session '${input.sessionId}'.`,
      };
    }

    try {
      const abortController = new AbortController();
      const options = buildOptionsFromDiskResume(dr);
      if (input.effort !== undefined) options.effort = input.effort;
      if (input.thinking !== undefined) options.thinking = input.thinking;

      const { resumeToken: _resumeToken, ...rest } = dr;
      void _resumeToken;
      const source: OptionSource = {
        ...(rest as OptionSource),
        cwd: options.cwd ?? dr.cwd ?? "",
        additionalDirectories:
          (options.additionalDirectories as string[] | undefined) ??
          (rest as OptionSource).additionalDirectories,
        debugFile: (options.debugFile as string | undefined) ?? (rest as OptionSource).debugFile,
        pathToClaudeCodeExecutable:
          (options.pathToClaudeCodeExecutable as string | undefined) ??
          (rest as OptionSource).pathToClaudeCodeExecutable,
        effort: input.effort ?? (rest as OptionSource).effort,
        thinking: input.thinking ?? (rest as OptionSource).thinking,
      };
      sessionManager.create(
        toSessionCreateParams({
          sessionId: input.sessionId,
          source,
          permissionMode: "default",
          abortController,
        })
      );

      try {
        const handle = consumeQuery({
          mode: "disk-resume",
          sessionId: input.sessionId,
          prompt: input.prompt,
          abortController,
          options,
          permissionRequestTimeoutMs,
          sessionInitTimeoutMs,
          sessionManager,
          toolCache,
        });
        sessionManager.update(input.sessionId, {
          queryInterrupt: () => {
            handle.interrupt();
          },
        });
      } catch (err: unknown) {
        const { agentResult, errorText } = toStartError(input.sessionId, err);
        sessionManager.setResult(input.sessionId, {
          type: "error",
          result: agentResult,
          createdAt: new Date().toISOString(),
        });
        sessionManager.pushEvent(input.sessionId, {
          type: "error",
          data: agentResult,
          timestamp: new Date().toISOString(),
        });
        sessionManager.update(input.sessionId, {
          status: "error",
          abortController: undefined,
          queryInterrupt: undefined,
        });
        return { sessionId: input.sessionId, status: "error", error: errorText };
      }

      return {
        sessionId: input.sessionId,
        status: "running",
        pollInterval: 3000,
        resumeToken: computeResumeToken(input.sessionId, resumeSecret),
      };
    } catch (err: unknown) {
      const { agentResult, errorText } = toStartError(input.sessionId, err);
      if (sessionManager.get(input.sessionId)) {
        sessionManager.setResult(input.sessionId, {
          type: "error",
          result: agentResult,
          createdAt: new Date().toISOString(),
        });
        sessionManager.pushEvent(input.sessionId, {
          type: "error",
          data: agentResult,
          timestamp: new Date().toISOString(),
        });
        sessionManager.update(input.sessionId, {
          status: "error",
          abortController: undefined,
          queryInterrupt: undefined,
        });
      }
      return {
        sessionId: input.sessionId,
        status: "error",
        error: errorText,
      };
    }
  }

  if (existing.status === "running" || existing.status === "waiting_permission") {
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: ${existing.status}).`,
    };
  }

  if (existing.status === "cancelled") {
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.CANCELLED}]: Session '${input.sessionId}' has been cancelled and cannot be resumed.`,
    };
  }

  const originalStatus = existing.status;
  const abortController = new AbortController();
  const acquired = sessionManager.tryAcquire(input.sessionId, originalStatus, abortController);
  if (!acquired) {
    const current = sessionManager.get(input.sessionId);
    return {
      sessionId: input.sessionId,
      status: "error",
      error: current
        ? `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: ${current.status}).`
        : `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
    };
  }

  const session = acquired;
  const normalizedCwd = normalizeAndAssertCwd(session.cwd, "session cwd");
  const options = buildOptions(session);
  options.cwd = normalizedCwd;
  if (input.forkSession) options.forkSession = true;

  if (input.forkSession && !sessionManager.hasCapacityFor(1)) {
    sessionManager.update(input.sessionId, { status: originalStatus, abortController: undefined });
    return {
      sessionId: input.sessionId,
      status: "error",
      error: `Error [${ErrorCode.RESOURCE_EXHAUSTED}]: Too many sessions (limit: ${sessionManager.getMaxSessions()}).`,
    };
  }

  const sourceOverrides: Pick<OptionSource, "effort" | "thinking"> = {
    effort: input.effort ?? session.effort,
    thinking: input.thinking ?? session.thinking,
  };
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.thinking !== undefined) options.thinking = input.thinking;
  if (!input.forkSession && (input.effort !== undefined || input.thinking !== undefined)) {
    const patch: Partial<Pick<OptionSource, "effort" | "thinking">> = {};
    if (input.effort !== undefined) patch.effort = input.effort;
    if (input.thinking !== undefined) patch.thinking = input.thinking;
    sessionManager.update(input.sessionId, patch);
  }

  try {
    const handle = consumeQuery({
      mode: "resume",
      sessionId: input.sessionId,
      prompt: input.prompt,
      abortController,
      options,
      permissionRequestTimeoutMs,
      sessionInitTimeoutMs,
      waitForInitSessionId: !!input.forkSession,
      sessionManager,
      toolCache,
      onInit: (init) => {
        if (!input.forkSession) return;
        if (init.session_id === input.sessionId) return;

        // Restore original session state as soon as we have the fork's session ID.
        // Forking should not affect the original session (including its AbortController).
        sessionManager.update(input.sessionId, {
          status: originalStatus,
          abortController: undefined,
          queryInterrupt: undefined,
        });

        if (!sessionManager.get(init.session_id)) {
          sessionManager.create(
            toSessionCreateParams({
              sessionId: init.session_id,
              source: { ...session, ...sourceOverrides },
              permissionMode: "default",
              abortController,
              queryInterrupt: () => {
                handle.interrupt();
              },
            })
          );
        }
      },
    });
    if (!input.forkSession) {
      sessionManager.update(input.sessionId, {
        queryInterrupt: () => {
          handle.interrupt();
        },
      });
    }

    const sessionId = input.forkSession
      ? await raceWithAbort(handle.sdkSessionIdPromise, requestSignal, () =>
          abortController.abort()
        )
      : input.sessionId;
    if (input.forkSession && sessionId === input.sessionId) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.INTERNAL}]: Fork requested but no new session ID received from agent.`,
      };
    }

    const resumeSecret = getResumeSecret();
    return {
      sessionId,
      status: "running",
      pollInterval: 3000,
      resumeToken: resumeSecret ? computeResumeToken(sessionId, resumeSecret) : undefined,
    };
  } catch (err: unknown) {
    const { agentResult, errorText } = toStartError(input.sessionId, err);
    if (input.forkSession) {
      sessionManager.update(input.sessionId, {
        status: originalStatus,
        abortController: undefined,
        queryInterrupt: undefined,
      });
    } else {
      sessionManager.setResult(input.sessionId, {
        type: "error",
        result: agentResult,
        createdAt: new Date().toISOString(),
      });
      sessionManager.pushEvent(input.sessionId, {
        type: "error",
        data: agentResult,
        timestamp: new Date().toISOString(),
      });
      sessionManager.update(input.sessionId, {
        status: "error",
        abortController: undefined,
        queryInterrupt: undefined,
      });
    }
    return {
      sessionId: input.sessionId,
      status: "error",
      error: errorText,
    };
  }
}
