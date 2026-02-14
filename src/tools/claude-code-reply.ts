/**
 * claude_code_reply tool - Continue an existing Claude Code session (async)
 */
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
import { DEFAULT_SETTING_SOURCES, ErrorCode } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { computeResumeToken, getResumeSecret } from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions } from "../utils/build-options.js";

export interface ClaudeCodeReplyInput {
  sessionId: string;
  prompt: string;
  forkSession?: boolean;
  /**
   * Resume token returned by claude_code / claude_code_reply. Required for disk resume fallback.
   */
  resumeToken?: string;

  /**
   * Optional overrides used for "disk resume" when the in-memory session is missing.
   * Enabled only when `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`.
   */
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  maxTurns?: number;
  model?: string;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  persistSession?: boolean;
  resumeSessionAt?: string;
  pathToClaudeCodeExecutable?: string;
  agent?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: SandboxSettings;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  includePartialMessages?: boolean;
  strictMcpConfig?: boolean;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  env?: Record<string, string | undefined>;

  /** Timeout waiting for fork init (default 10000ms, only used when forkSession=true) */
  sessionInitTimeoutMs?: number;
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;
}

export type ClaudeCodeReplyStartResult =
  | SessionStartResult
  | { sessionId: string; status: "error"; error: string };

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

function buildOptionsFromDiskResume(input: ClaudeCodeReplyInput): ReturnType<typeof buildOptions> {
  if (input.cwd === undefined || typeof input.cwd !== "string" || input.cwd.trim() === "") {
    throw new Error(`Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be provided for disk resume.`);
  }
  return buildOptions(input as Parameters<typeof buildOptions>[0]);
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
    const allowDiskResume = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME === "1";
    if (!allowDiskResume) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
      };
    }

    const resumeSecret = getResumeSecret();
    if (!resumeSecret) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Disk resume is enabled but CLAUDE_CODE_MCP_RESUME_SECRET is not set.`,
      };
    }
    if (typeof input.resumeToken !== "string" || input.resumeToken.trim() === "") {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: resumeToken is required for disk resume fallback.`,
      };
    }
    const expectedToken = computeResumeToken(input.sessionId, resumeSecret);
    if (input.resumeToken !== expectedToken) {
      return {
        sessionId: input.sessionId,
        status: "error",
        error: `Error [${ErrorCode.PERMISSION_DENIED}]: Invalid resumeToken for session '${input.sessionId}'.`,
      };
    }

    try {
      const abortController = new AbortController();
      const options = buildOptionsFromDiskResume(input);

      sessionManager.create({
        sessionId: input.sessionId,
        cwd: options.cwd ?? input.cwd ?? "",
        model: input.model,
        permissionMode: "default",
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
        tools: input.tools,
        maxTurns: input.maxTurns,
        systemPrompt: input.systemPrompt,
        agents: input.agents,
        maxBudgetUsd: input.maxBudgetUsd,
        effort: input.effort,
        betas: input.betas,
        additionalDirectories: input.additionalDirectories,
        outputFormat: input.outputFormat,
        thinking: input.thinking,
        persistSession: input.persistSession,
        pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
        agent: input.agent,
        mcpServers: input.mcpServers,
        sandbox: input.sandbox,
        fallbackModel: input.fallbackModel,
        enableFileCheckpointing: input.enableFileCheckpointing,
        includePartialMessages: input.includePartialMessages,
        strictMcpConfig: input.strictMcpConfig,
        settingSources: input.settingSources ?? DEFAULT_SETTING_SOURCES,
        debug: input.debug,
        debugFile: input.debugFile,
        env: input.env,
        abortController,
      });

      try {
        consumeQuery({
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
        sessionManager.update(input.sessionId, { status: "error", abortController: undefined });
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
        sessionManager.update(input.sessionId, { status: "error", abortController: undefined });
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

  const options = buildOptions(existing);
  if (input.forkSession) options.forkSession = true;

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

        if (!sessionManager.get(init.session_id)) {
          sessionManager.create({
            sessionId: init.session_id,
            cwd: existing.cwd,
            model: existing.model,
            permissionMode: "default",
            allowedTools: existing.allowedTools,
            disallowedTools: existing.disallowedTools,
            tools: existing.tools,
            maxTurns: existing.maxTurns,
            systemPrompt: existing.systemPrompt,
            agents: existing.agents,
            maxBudgetUsd: existing.maxBudgetUsd,
            effort: existing.effort,
            betas: existing.betas,
            additionalDirectories: existing.additionalDirectories,
            outputFormat: existing.outputFormat,
            thinking: existing.thinking,
            persistSession: existing.persistSession,
            pathToClaudeCodeExecutable: existing.pathToClaudeCodeExecutable,
            agent: existing.agent,
            mcpServers: existing.mcpServers,
            sandbox: existing.sandbox,
            fallbackModel: existing.fallbackModel,
            enableFileCheckpointing: existing.enableFileCheckpointing,
            includePartialMessages: existing.includePartialMessages,
            strictMcpConfig: existing.strictMcpConfig,
            settingSources: existing.settingSources ?? DEFAULT_SETTING_SOURCES,
            debug: existing.debug,
            debugFile: existing.debugFile,
            env: existing.env,
            abortController,
          });
        }

        // Restore original session state (fork should not affect the original session).
        sessionManager.update(input.sessionId, {
          status: originalStatus,
          abortController: undefined,
        });
      },
    });

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
      sessionManager.update(input.sessionId, { status: "error", abortController: undefined });
    }
    return {
      sessionId: input.sessionId,
      status: "error",
      error: errorText,
    };
  }
}
