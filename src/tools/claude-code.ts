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

/** Low-frequency / SDK-passthrough options grouped under `advanced`. */
export interface ClaudeCodeAdvancedOptions {
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  persistSession?: boolean;
  sessionInitTimeoutMs?: number;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  pathToClaudeCodeExecutable?: string;
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
}

export interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  model?: string;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  /** Timeout waiting for permission decision (default 60000ms) */
  permissionRequestTimeoutMs?: number;
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
  const cwd = input.cwd !== undefined ? input.cwd : serverCwd;

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      sessionId: "",
      status: "error",
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
    };
  }

  const abortController = new AbortController();
  const adv = input.advanced ?? {};

  const permissionRequestTimeoutMs = input.permissionRequestTimeoutMs ?? 60_000;
  const sessionInitTimeoutMs = adv.sessionInitTimeoutMs ?? 10_000;

  // Flatten top-level + advanced into a single object for buildOptions / sessionManager.
  const flat = {
    cwd,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    maxTurns: input.maxTurns,
    model: input.model,
    systemPrompt: input.systemPrompt,
    ...adv,
  };

  try {
    const handle = consumeQuery({
      mode: "start",
      prompt: input.prompt,
      abortController,
      options: buildOptions(flat),
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
          tools: adv.tools,
          maxTurns: input.maxTurns,
          systemPrompt: input.systemPrompt,
          agents: adv.agents as Record<string, AgentDefinition> | undefined,
          maxBudgetUsd: adv.maxBudgetUsd,
          effort: adv.effort,
          betas: adv.betas,
          additionalDirectories: adv.additionalDirectories,
          outputFormat: adv.outputFormat,
          thinking: adv.thinking,
          persistSession: adv.persistSession,
          pathToClaudeCodeExecutable: adv.pathToClaudeCodeExecutable,
          agent: adv.agent,
          mcpServers: adv.mcpServers,
          sandbox: adv.sandbox,
          fallbackModel: adv.fallbackModel,
          enableFileCheckpointing: adv.enableFileCheckpointing,
          includePartialMessages: adv.includePartialMessages,
          strictMcpConfig: adv.strictMcpConfig,
          settingSources: adv.settingSources ?? DEFAULT_SETTING_SOURCES,
          debug: adv.debug,
          debugFile: adv.debugFile,
          env: adv.env,
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
