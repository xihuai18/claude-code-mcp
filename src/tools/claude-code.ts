/**
 * claude_code tool - Start a new Claude Code agent session
 */
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  SandboxSettings,
  SessionStartResult,
  SettingSource,
} from "../types.js";
import { ErrorCode, DEFAULT_SETTING_SOURCES } from "../types.js";
import { consumeQuery } from "./query-consumer.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { computeResumeToken, getResumeSecret } from "../utils/resume-token.js";
import { raceWithAbort } from "../utils/race-with-abort.js";
import { buildOptions } from "../utils/build-options.js";

export interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  model?: string;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  agents?: Record<string, AgentDefinition>;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  persistSession?: boolean;
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
  /** Timeout waiting for system/init (default 10000ms) */
  sessionInitTimeoutMs?: number;
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;
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
  const cwd = input.cwd !== undefined ? input.cwd : serverCwd;

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      sessionId: "",
      status: "error",
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
    };
  }

  const abortController = new AbortController();

  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = input.sessionInitTimeoutMs ?? 10_000;

  try {
    const handle = consumeQuery({
      mode: "start",
      prompt: input.prompt,
      abortController,
      options: buildOptions({ ...input, cwd }),
      permissionRequestTimeoutMs,
      sessionInitTimeoutMs,
      sessionManager,
      toolCache,
      onInit: (init) => {
        // Idempotent: on transient retry the SDK may re-send init for the same session.
        if (sessionManager.get(init.session_id)) return;
        sessionManager.create({
          sessionId: init.session_id,
          cwd,
          model: input.model,
          permissionMode: "default",
          allowedTools: input.allowedTools,
          disallowedTools: input.disallowedTools,
          tools: input.tools,
          maxTurns: input.maxTurns,
          systemPrompt: input.systemPrompt,
          agents: input.agents as Record<string, AgentDefinition> | undefined,
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
