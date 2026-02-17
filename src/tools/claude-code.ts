/**
 * claude_code tool - Start a new Claude Code agent session
 */
import { existsSync, statSync } from "node:fs";
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  SandboxSettings,
  SessionStartResult,
  SettingSource,
  ThinkingConfig,
} from "../types.js";
import { ErrorCode } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { computeResumeToken, getResumeSecret } from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions } from "../utils/build-options.js";
import { toSessionCreateParams } from "../utils/session-create.js";
import {
  normalizeWindowsPathArray,
  normalizeWindowsPathLike,
} from "../utils/normalize-windows-path.js";

/**
 * Low-frequency / SDK-passthrough options grouped under `advanced`.
 * `effort` and `thinking` are promoted to top-level (advanced aliases are kept for compatibility).
 */
export interface ClaudeCodeAdvancedOptions {
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  persistSession?: boolean;
  sessionInitTimeoutMs?: number;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  maxBudgetUsd?: number;
  /** @deprecated Use top-level `effort` instead. */
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** @deprecated Use top-level `thinking` instead. */
  thinking?: ThinkingConfig;
  pathToClaudeCodeExecutable?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: SandboxSettings;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  includePartialMessages?: boolean;
  strictMcpConfig?: boolean;
  strictAllowedTools?: boolean;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  env?: Record<string, string | undefined>;
}

export interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  strictAllowedTools?: boolean;
  maxTurns?: number;
  model?: string;
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;
  /** @deprecated Use `advanced.sessionInitTimeoutMs` instead. */
  sessionInitTimeoutMs?: number;
  /** Low-frequency SDK options. All fields are optional and have sensible defaults. */
  advanced?: ClaudeCodeAdvancedOptions;
}

export type ClaudeCodeStartResult =
  | SessionStartResult
  | { sessionId: string; status: "error"; error: string };

export async function executeClaudeCode(
  input: ClaudeCodeInput,
  sessionManager: SessionManager,
  serverCwd: string,
  toolCache?: ToolDiscoveryCache,
  requestSignal?: AbortSignal
): Promise<ClaudeCodeStartResult> {
  const cwdProvided = input.cwd !== undefined;
  const cwd = cwdProvided ? input.cwd : serverCwd;

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      sessionId: "",
      status: "error",
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
    };
  }
  const normalizedCwd = normalizeWindowsPathLike(cwd);
  if (cwdProvided && !existsSync(normalizedCwd)) {
    return {
      sessionId: "",
      status: "error",
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd path does not exist: ${normalizedCwd}`,
    };
  }
  if (cwdProvided) {
    try {
      if (!statSync(normalizedCwd).isDirectory()) {
        return {
          sessionId: "",
          status: "error",
          error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a directory: ${normalizedCwd}`,
        };
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? ` (${err.message})` : "";
      return {
        sessionId: "",
        status: "error",
        error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd is not accessible: ${normalizedCwd}${detail}`,
      };
    }
  }

  if (!sessionManager.hasCapacityFor(1)) {
    return {
      sessionId: "",
      status: "error",
      error: `Error [${ErrorCode.RESOURCE_EXHAUSTED}]: Too many sessions (limit: ${sessionManager.getMaxSessions()}).`,
    };
  }

  const abortController = new AbortController();
  const adv = input.advanced ?? {};

  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = adv.sessionInitTimeoutMs ?? input.sessionInitTimeoutMs ?? 10_000;
  const compatWarnings: string[] = [];
  if (input.sessionInitTimeoutMs !== undefined) {
    compatWarnings.push(
      "Top-level sessionInitTimeoutMs for claude_code is a compatibility alias; prefer advanced.sessionInitTimeoutMs."
    );
  }
  if (
    input.sessionInitTimeoutMs !== undefined &&
    adv.sessionInitTimeoutMs !== undefined &&
    input.sessionInitTimeoutMs !== adv.sessionInitTimeoutMs
  ) {
    compatWarnings.push(
      `Both advanced.sessionInitTimeoutMs (${adv.sessionInitTimeoutMs}) and top-level sessionInitTimeoutMs (${input.sessionInitTimeoutMs}) were provided; using advanced.sessionInitTimeoutMs.`
    );
  }

  // Flatten top-level + advanced into a single object for buildOptions / sessionManager.
  const flat = {
    cwd: normalizedCwd,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    strictAllowedTools: input.strictAllowedTools ?? adv.strictAllowedTools,
    maxTurns: input.maxTurns,
    model: input.model,
    systemPrompt: input.systemPrompt,
    ...adv,
    effort: input.effort ?? adv.effort,
    thinking: input.thinking ?? adv.thinking,
  };
  const normalizedFlat = {
    ...flat,
    cwd: normalizeWindowsPathLike(flat.cwd),
    additionalDirectories:
      flat.additionalDirectories !== undefined
        ? normalizeWindowsPathArray(flat.additionalDirectories)
        : undefined,
    debugFile: flat.debugFile !== undefined ? normalizeWindowsPathLike(flat.debugFile) : undefined,
    pathToClaudeCodeExecutable:
      flat.pathToClaudeCodeExecutable !== undefined
        ? normalizeWindowsPathLike(flat.pathToClaudeCodeExecutable)
        : undefined,
  };

  try {
    const handle = consumeQuery({
      mode: "start",
      prompt: input.prompt,
      abortController,
      options: buildOptions(normalizedFlat),
      permissionRequestTimeoutMs,
      sessionInitTimeoutMs,
      sessionManager,
      toolCache,
      onInit: (init) => {
        // Idempotent: on transient retry the SDK may re-send init for the same session.
        if (sessionManager.get(init.session_id)) return;
        sessionManager.create(
          toSessionCreateParams({
            sessionId: init.session_id,
            source: normalizedFlat,
            permissionMode: "default",
            abortController,
            queryInterrupt: () => {
              handle.interrupt();
            },
          })
        );
      },
    });

    const sessionId = await raceWithAbort(handle.sdkSessionIdPromise, requestSignal, () =>
      abortController.abort()
    );

    const resumeSecret = getResumeSecret();
    return {
      sessionId,
      status: "running",
      pollInterval: 3000,
      resumeToken: resumeSecret ? computeResumeToken(sessionId, resumeSecret) : undefined,
      compatWarnings: compatWarnings.length > 0 ? compatWarnings : undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sessionId: "",
      status: "error",
      error: message.includes("Error [") ? message : `Error [${ErrorCode.INTERNAL}]: ${message}`,
    };
  }
}
