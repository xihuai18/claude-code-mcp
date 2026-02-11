/**
 * claude_code tool - Start a new Claude Code agent session
 */
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "../session/manager.js";
import type {
  AgentResult,
  AgentDefinition,
  PermissionMode,
  EffortLevel,
  McpServerConfig,
  SandboxSettings,
  SettingSource,
} from "../types.js";
import { ErrorCode, DEFAULT_SETTING_SOURCES } from "../types.js";
import { enhanceWindowsError } from "../utils/windows.js";

export interface ClaudeCodeInput {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: PermissionMode;
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
  timeout?: number;
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
}

export async function executeClaudeCode(
  input: ClaudeCodeInput,
  sessionManager: SessionManager,
  serverCwd: string,
  allowBypass = false
): Promise<AgentResult> {
  const cwd = input.cwd !== undefined ? input.cwd : serverCwd;

  if (typeof cwd !== "string" || cwd.trim() === "") {
    return {
      sessionId: "",
      result: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  let sessionId = "";
  let resultText = "";
  let isError = false;
  let durationMs = 0;
  let durationApiMs: number | undefined;
  let numTurns = 0;
  let totalCostUsd = 0;
  let sessionTotalTurns: number | undefined;
  let sessionTotalCostUsd: number | undefined;
  let structuredOutput: unknown;
  let stopReason: string | null | undefined;
  let errorSubtype: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let permissionDenials: AgentResult["permissionDenials"] | undefined;
  let seenResult = false;
  let timedOut = false;

  // Security: block bypassPermissions unless explicitly allowed
  if (input.permissionMode === "bypassPermissions" && !allowBypass) {
    return {
      sessionId: "",
      result: `Error [${ErrorCode.PERMISSION_DENIED}]: bypassPermissions is disabled on this server. Use the claude_code_configure tool with action 'enable_bypass' to enable it.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  const abortController = new AbortController();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    if (input.timeout !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, input.timeout);
    }

    // Build options for the Agent SDK query()
    // Default to "dontAsk" permission mode in MCP context (non-interactive)
    const effectivePermissionMode = input.permissionMode ?? "dontAsk";

    const options: Partial<Options> = {
      cwd,
      abortController,
      permissionMode: effectivePermissionMode,
    };

    if (input.allowedTools !== undefined) options.allowedTools = input.allowedTools;
    if (input.disallowedTools !== undefined) options.disallowedTools = input.disallowedTools;
    if (input.maxTurns !== undefined) options.maxTurns = input.maxTurns;
    if (input.model !== undefined) options.model = input.model;
    if (input.maxBudgetUsd !== undefined) options.maxBudgetUsd = input.maxBudgetUsd;
    if (input.agents !== undefined) options.agents = input.agents as Options["agents"];
    if (input.effort !== undefined) options.effort = input.effort;
    if (input.betas !== undefined) options.betas = input.betas as Options["betas"];
    if (input.additionalDirectories !== undefined)
      options.additionalDirectories = input.additionalDirectories;
    if (input.outputFormat !== undefined) options.outputFormat = input.outputFormat;
    if (input.thinking !== undefined) options.thinking = input.thinking;
    if (input.tools !== undefined) options.tools = input.tools;
    if (input.persistSession !== undefined) options.persistSession = input.persistSession;
    if (input.pathToClaudeCodeExecutable !== undefined)
      options.pathToClaudeCodeExecutable = input.pathToClaudeCodeExecutable;
    if (input.agent !== undefined) options.agent = input.agent;
    if (input.mcpServers !== undefined)
      options.mcpServers = input.mcpServers as Options["mcpServers"];
    if (input.sandbox !== undefined) options.sandbox = input.sandbox;
    if (input.fallbackModel !== undefined) options.fallbackModel = input.fallbackModel;
    if (input.enableFileCheckpointing !== undefined)
      options.enableFileCheckpointing = input.enableFileCheckpointing;
    if (input.includePartialMessages !== undefined)
      options.includePartialMessages = input.includePartialMessages;
    if (input.strictMcpConfig !== undefined) options.strictMcpConfig = input.strictMcpConfig;
    if (input.settingSources !== undefined) options.settingSources = input.settingSources;
    else options.settingSources = DEFAULT_SETTING_SOURCES;
    if (input.debug !== undefined) options.debug = input.debug;
    if (input.debugFile !== undefined) options.debugFile = input.debugFile;
    if (input.env !== undefined) options.env = { ...process.env, ...input.env };

    if (effectivePermissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;

    // No placeholder session - we create the session only after receiving the init message
    for await (const message of query({
      prompt: input.prompt,
      options,
    })) {
      if (message.type === "system" && message.subtype === "init") {
        if (sessionId) continue;
        sessionId = message.session_id;
        sessionManager.create({
          sessionId,
          cwd,
          model: input.model,
          permissionMode: effectivePermissionMode,
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
      }

      if (message.type === "result") {
        if (seenResult) continue;
        seenResult = true;

        const result: SDKResultMessage = message;
        durationMs = result.duration_ms;
        durationApiMs = result.duration_api_ms;
        numTurns = result.num_turns;
        totalCostUsd = result.total_cost_usd;
        isError = result.is_error;
        stopReason = result.stop_reason;
        usage = result.usage;
        modelUsage = result.modelUsage;
        permissionDenials = result.permission_denials;

        if (result.subtype === "success") {
          resultText = result.result;
          structuredOutput = result.structured_output;
        } else {
          isError = true;
          errorSubtype = result.subtype;
          resultText =
            result.errors.map(String).join("\n") || `Error [${result.subtype}]: Unknown error`;
        }

        break;
      }
    }
  } catch (err: unknown) {
    isError = true;
    // Detect abort/cancellation errors
    const isAborted =
      abortController.signal.aborted ||
      err instanceof AbortError ||
      (err instanceof Error && err.name === "AbortError");
    if (isAborted) {
      resultText = timedOut
        ? `Error [${ErrorCode.TIMEOUT}]: Session timed out after ${input.timeout}ms.`
        : `Error [${ErrorCode.CANCELLED}]: Session was cancelled.`;
    } else {
      resultText = enhanceWindowsError(err instanceof Error ? err.message : String(err));
    }
    if (sessionId) {
      const current = sessionManager.get(sessionId);
      if (current) {
        // Don't overwrite terminal states; treat timeout as error (retryable)
        if (timedOut && current.status !== "cancelled" && current.status !== "error") {
          sessionManager.update(sessionId, { status: "error" });
        } else if (isAborted && current.status === "running") {
          sessionManager.update(sessionId, { status: "cancelled" });
        } else if (!isAborted && current.status !== "cancelled") {
          sessionManager.update(sessionId, { status: "error" });
        }
      }
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // Some SDK abort paths end the stream without throwing. Ensure aborts become TIMEOUT/CANCELLED,
  // not an INTERNAL "missing_result" error.
  if (!seenResult && !isError && abortController.signal.aborted) {
    isError = true;
    resultText = timedOut
      ? `Error [${ErrorCode.TIMEOUT}]: Session timed out after ${input.timeout}ms.`
      : `Error [${ErrorCode.CANCELLED}]: Session was cancelled.`;
  }

  if (sessionId && !seenResult && !isError) {
    isError = true;
    errorSubtype = errorSubtype ?? "missing_result";
    const noResultMsg = `Error [${ErrorCode.INTERNAL}]: No result message received from agent.`;
    resultText = resultText ? `${noResultMsg} Original: ${resultText}` : noResultMsg;
  }

  // Update session to idle (or error), clear abortController
  // Preserve "cancelled" status if session was cancelled during execution
  if (sessionId) {
    const current = sessionManager.get(sessionId);
    if (current && current.status !== "cancelled") {
      sessionManager.update(sessionId, {
        status: isError ? "error" : "idle",
        totalTurns: numTurns,
        totalCostUsd,
        abortController: undefined,
      });
      const updated = sessionManager.get(sessionId);
      sessionTotalTurns = updated?.totalTurns;
      sessionTotalCostUsd = updated?.totalCostUsd;
    } else if (current) {
      // Session was cancelled — just clear the abortController and update totals
      sessionManager.update(sessionId, {
        totalTurns: numTurns,
        totalCostUsd,
        abortController: undefined,
      });
      const updated = sessionManager.get(sessionId);
      sessionTotalTurns = updated?.totalTurns;
      sessionTotalCostUsd = updated?.totalCostUsd;
    }
  } else {
    // No session ID means something went wrong regardless of result content
    isError = true;
    const noInitMsg = timedOut
      ? `Error [${ErrorCode.TIMEOUT}]: Session timed out after ${input.timeout}ms (no session ID received).`
      : `Error [${ErrorCode.INTERNAL}]: No session ID received from agent.`;
    resultText = resultText ? `${noInitMsg} Original: ${resultText}` : noInitMsg;
  }

  return {
    sessionId,
    result: resultText,
    isError,
    durationMs,
    durationApiMs,
    numTurns,
    totalCostUsd,
    sessionTotalTurns,
    sessionTotalCostUsd,
    structuredOutput,
    stopReason,
    errorSubtype,
    usage,
    modelUsage,
    permissionDenials,
  };
}
