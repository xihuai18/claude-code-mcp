/**
 * claude_code_reply tool - Continue an existing Claude Code session
 */
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "../session/manager.js";
import type {
  AgentDefinition,
  AgentResult,
  EffortLevel,
  McpServerConfig,
  OutputFormat,
  PermissionMode,
  SandboxSettings,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  ToolsConfig,
} from "../types.js";
import { ErrorCode } from "../types.js";

export interface ClaudeCodeReplyInput {
  sessionId: string;
  prompt: string;
  forkSession?: boolean;
  timeout?: number;

  /**
   * Optional overrides used for "disk resume" when the in-memory session is missing.
   * Enabled only when `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`.
   */
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  permissionMode?: PermissionMode;
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
}

export async function executeClaudeCodeReply(
  input: ClaudeCodeReplyInput,
  sessionManager: SessionManager,
  allowBypass = false
): Promise<AgentResult> {
  const session = sessionManager.get(input.sessionId);
  if (!session) {
    const allowDiskResume = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME === "1";
    if (!allowDiskResume) {
      return {
        sessionId: input.sessionId,
        result: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
        isError: true,
        durationMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
      };
    }

    return executeClaudeCodeReplyDiskResume(input, sessionManager, allowBypass);
  }

  if (session.status === "running") {
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.SESSION_BUSY}]: Session is currently running. Wait for it to complete or cancel it.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  if (session.status === "cancelled") {
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.CANCELLED}]: Session '${input.sessionId}' has been cancelled and cannot be resumed.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  // Security: block resume/fork of bypassPermissions sessions when bypass is disabled
  if (session.permissionMode === "bypassPermissions" && !allowBypass) {
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.PERMISSION_DENIED}]: Cannot resume a bypassPermissions session while bypass is disabled. Use the claude_code_configure tool with action 'enable_bypass' first.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  // Atomically acquire the session (compare-and-set: idle/error → running)
  const originalStatus = session.status;
  const abortController = new AbortController();
  let timedOut = false;
  const acquired = sessionManager.tryAcquire(input.sessionId, originalStatus, abortController);
  if (!acquired) {
    const current = sessionManager.get(input.sessionId);
    if (!current) {
      return {
        sessionId: input.sessionId,
        result: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
        isError: true,
        durationMs: 0,
        numTurns: 0,
        totalCostUsd: 0,
      };
    }
    // Another concurrent call acquired it first, or status changed
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: ${current.status}).`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (input.timeout !== undefined) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, input.timeout);
  }

  let resultText = "";
  let isError = false;
  let durationMs = 0;
  let durationApiMs: number | undefined;
  let numTurns = 0;
  let totalCostUsd = 0;
  let sessionTotalTurns: number | undefined;
  let sessionTotalCostUsd: number | undefined;
  let newSessionId = input.sessionId;
  let structuredOutput: unknown;
  let stopReason: string | null | undefined;
  let errorSubtype: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let permissionDenials: AgentResult["permissionDenials"] | undefined;
  let seenResult = false;
  let forkSessionCreated = false;

  try {
    const options: Partial<Options> = {
      resume: input.sessionId,
      abortController,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
    };

    if (session.allowedTools !== undefined) options.allowedTools = session.allowedTools;
    if (session.disallowedTools !== undefined) options.disallowedTools = session.disallowedTools;
    if (session.maxTurns !== undefined) options.maxTurns = session.maxTurns;
    if (session.model !== undefined) options.model = session.model;
    if (session.maxBudgetUsd !== undefined) options.maxBudgetUsd = session.maxBudgetUsd;
    if (session.agents !== undefined) options.agents = session.agents as Options["agents"];
    if (session.effort !== undefined) options.effort = session.effort;
    if (session.betas !== undefined) options.betas = session.betas as Options["betas"];
    if (session.additionalDirectories !== undefined)
      options.additionalDirectories = session.additionalDirectories;
    if (session.outputFormat !== undefined) options.outputFormat = session.outputFormat;
    if (session.thinking !== undefined) options.thinking = session.thinking;
    if (session.tools !== undefined) options.tools = session.tools;
    if (session.systemPrompt !== undefined) options.systemPrompt = session.systemPrompt;
    if (session.persistSession !== undefined) options.persistSession = session.persistSession;
    if (session.pathToClaudeCodeExecutable !== undefined)
      options.pathToClaudeCodeExecutable = session.pathToClaudeCodeExecutable;
    if (session.agent !== undefined) options.agent = session.agent;
    if (session.mcpServers !== undefined)
      options.mcpServers = session.mcpServers as Options["mcpServers"];
    if (session.sandbox !== undefined) options.sandbox = session.sandbox;
    if (session.fallbackModel !== undefined) options.fallbackModel = session.fallbackModel;
    if (session.enableFileCheckpointing !== undefined)
      options.enableFileCheckpointing = session.enableFileCheckpointing;
    if (session.includePartialMessages !== undefined)
      options.includePartialMessages = session.includePartialMessages;
    if (session.strictMcpConfig !== undefined) options.strictMcpConfig = session.strictMcpConfig;
    if (session.settingSources !== undefined) options.settingSources = session.settingSources;
    if (session.debug !== undefined) options.debug = session.debug;
    if (session.debugFile !== undefined) options.debugFile = session.debugFile;
    if (session.env !== undefined) options.env = session.env;

    if (session.permissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    if (input.forkSession) {
      options.forkSession = true;
    }

    for await (const message of query({
      prompt: input.prompt,
      options,
    })) {
      // If forked, capture the new session ID
      if (input.forkSession && message.type === "system" && message.subtype === "init") {
        newSessionId = message.session_id;
        // Note: forked session shares abortController during this query() call.
        // This is correct — both run in the same SDK process. After completion,
        // each session's abortController is cleared independently.
        if (!forkSessionCreated && newSessionId !== input.sessionId) {
          sessionManager.create({
            sessionId: newSessionId,
            cwd: session.cwd,
            model: session.model,
            permissionMode: session.permissionMode,
            allowedTools: session.allowedTools,
            disallowedTools: session.disallowedTools,
            tools: session.tools,
            maxTurns: session.maxTurns,
            systemPrompt: session.systemPrompt,
            agents: session.agents,
            maxBudgetUsd: session.maxBudgetUsd,
            effort: session.effort,
            betas: session.betas,
            additionalDirectories: session.additionalDirectories,
            outputFormat: session.outputFormat,
            thinking: session.thinking,
            persistSession: session.persistSession,
            pathToClaudeCodeExecutable: session.pathToClaudeCodeExecutable,
            agent: session.agent,
            mcpServers: session.mcpServers,
            sandbox: session.sandbox,
            fallbackModel: session.fallbackModel,
            enableFileCheckpointing: session.enableFileCheckpointing,
            includePartialMessages: session.includePartialMessages,
            strictMcpConfig: session.strictMcpConfig,
            settingSources: session.settingSources,
            debug: session.debug,
            debugFile: session.debugFile,
            env: session.env,
            abortController,
          });
          forkSessionCreated = true;
        }
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
    const isAborted =
      abortController.signal.aborted ||
      err instanceof AbortError ||
      (err instanceof Error && err.name === "AbortError");
    if (isAborted) {
      resultText = timedOut
        ? `Error [${ErrorCode.TIMEOUT}]: Session timed out after ${input.timeout}ms.`
        : `Error [${ErrorCode.CANCELLED}]: Session was cancelled.`;
    } else {
      resultText = err instanceof Error ? err.message : String(err);
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

  if (!seenResult && !isError) {
    isError = true;
    errorSubtype = errorSubtype ?? "missing_result";
    const noResultMsg = `Error [${ErrorCode.INTERNAL}]: No result message received from agent.`;
    resultText = resultText ? `${noResultMsg} Original: ${resultText}` : noResultMsg;
  }

  // Update session state, clear abortController
  // Preserve "cancelled" status if session was cancelled during execution
  if (input.forkSession && newSessionId !== input.sessionId) {
    const forkedCurrent = sessionManager.get(newSessionId);
    if (forkedCurrent && forkedCurrent.status !== "cancelled") {
      sessionManager.update(newSessionId, {
        status: isError ? "error" : "idle",
        totalTurns: numTurns,
        totalCostUsd,
        abortController: undefined,
      });
      const updatedFork = sessionManager.get(newSessionId);
      sessionTotalTurns = updatedFork?.totalTurns;
      sessionTotalCostUsd = updatedFork?.totalCostUsd;
    } else if (forkedCurrent) {
      sessionManager.update(newSessionId, {
        totalTurns: numTurns,
        totalCostUsd,
        abortController: undefined,
      });
      const updatedFork = sessionManager.get(newSessionId);
      sessionTotalTurns = updatedFork?.totalTurns;
      sessionTotalCostUsd = updatedFork?.totalCostUsd;
    }
    // Restore original session to its pre-fork status (not always "idle")
    const origCurrent = sessionManager.get(input.sessionId);
    if (origCurrent && origCurrent.status !== "cancelled") {
      sessionManager.update(input.sessionId, {
        status: originalStatus,
        abortController: undefined,
      });
    } else if (origCurrent) {
      sessionManager.update(input.sessionId, {
        abortController: undefined,
      });
    }
  } else {
    const current = sessionManager.get(input.sessionId);
    if (current && current.status !== "cancelled") {
      sessionManager.update(input.sessionId, {
        status: isError ? "error" : "idle",
        totalTurns: (session.totalTurns ?? 0) + numTurns,
        totalCostUsd: (session.totalCostUsd ?? 0) + totalCostUsd,
        abortController: undefined,
      });
      const updated = sessionManager.get(input.sessionId);
      sessionTotalTurns = updated?.totalTurns;
      sessionTotalCostUsd = updated?.totalCostUsd;
    } else if (current) {
      sessionManager.update(input.sessionId, {
        totalTurns: (session.totalTurns ?? 0) + numTurns,
        totalCostUsd: (session.totalCostUsd ?? 0) + totalCostUsd,
        abortController: undefined,
      });
      const updated = sessionManager.get(input.sessionId);
      sessionTotalTurns = updated?.totalTurns;
      sessionTotalCostUsd = updated?.totalCostUsd;
    }
  }

  const targetSessionId = input.forkSession ? newSessionId : input.sessionId;

  // If fork was requested but no new session ID was received, flag as internal error
  if (input.forkSession && newSessionId === input.sessionId && !isError) {
    isError = true;
    const noForkMsg = `Error [${ErrorCode.INTERNAL}]: Fork requested but no new session ID received from agent.`;
    resultText = resultText ? `${noForkMsg} Original: ${resultText}` : noForkMsg;
  }

  return {
    sessionId: targetSessionId,
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

async function executeClaudeCodeReplyDiskResume(
  input: ClaudeCodeReplyInput,
  sessionManager: SessionManager,
  allowBypass: boolean
): Promise<AgentResult> {
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim() === "")) {
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  const effectivePermissionMode = input.permissionMode ?? "dontAsk";

  if (effectivePermissionMode === "bypassPermissions" && !allowBypass) {
    return {
      sessionId: input.sessionId,
      result: `Error [${ErrorCode.PERMISSION_DENIED}]: bypassPermissions is disabled on this server. Use the claude_code_configure tool with action 'enable_bypass' to enable it.`,
      isError: true,
      durationMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
    };
  }

  const abortController = new AbortController();
  let timedOut = false;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (input.timeout !== undefined) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, input.timeout);
  }

  let resultText = "";
  let isError = false;
  let durationMs = 0;
  let durationApiMs: number | undefined;
  let numTurns = 0;
  let totalCostUsd = 0;
  let sessionTotalTurns: number | undefined;
  let sessionTotalCostUsd: number | undefined;
  let newSessionId = input.sessionId;
  let structuredOutput: unknown;
  let stopReason: string | null | undefined;
  let errorSubtype: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let permissionDenials: AgentResult["permissionDenials"] | undefined;
  let seenResult = false;

  // Create a placeholder in-memory session for non-fork resumes to support cancellation/status.
  if (!input.forkSession) {
    const existing = sessionManager.get(input.sessionId);
    if (!existing) {
      const cwd = input.cwd ?? process.cwd();
      if (typeof cwd !== "string" || cwd.trim() === "") {
        return {
          sessionId: input.sessionId,
          result: `Error [${ErrorCode.INVALID_ARGUMENT}]: cwd must be a non-empty string.`,
          isError: true,
          durationMs: 0,
          numTurns: 0,
          totalCostUsd: 0,
        };
      }
      try {
        sessionManager.create({
          sessionId: input.sessionId,
          cwd,
          model: input.model,
          permissionMode: effectivePermissionMode,
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
          settingSources: input.settingSources,
          debug: input.debug,
          debugFile: input.debugFile,
          env: input.env,
          abortController,
        });
      } catch {
        // Another concurrent call may have created it; fall back to regular reply behavior.
        return executeClaudeCodeReply(input, sessionManager, allowBypass);
      }
    }
  }

  try {
    const options: Partial<Options> = {
      resume: input.sessionId,
      abortController,
      permissionMode: effectivePermissionMode,
    };

    if (input.cwd !== undefined) options.cwd = input.cwd;
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
    if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;
    if (input.persistSession !== undefined) options.persistSession = input.persistSession;
    if (input.resumeSessionAt !== undefined) options.resumeSessionAt = input.resumeSessionAt;
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
    if (input.debug !== undefined) options.debug = input.debug;
    if (input.debugFile !== undefined) options.debugFile = input.debugFile;
    if (input.env !== undefined) options.env = input.env;

    if (effectivePermissionMode === "bypassPermissions") {
      options.allowDangerouslySkipPermissions = true;
    }

    if (input.forkSession) {
      options.forkSession = true;
    }

    for await (const message of query({
      prompt: input.prompt,
      options,
    })) {
      if (message.type === "system" && message.subtype === "init") {
        // Security: block bypassPermissions if it was applied by the underlying CLI state
        if (message.permissionMode === "bypassPermissions" && !allowBypass) {
          isError = true;
          resultText = `Error [${ErrorCode.PERMISSION_DENIED}]: Cannot resume a bypassPermissions session while bypass is disabled. Use the claude_code_configure tool with action 'enable_bypass' first.`;
          abortController.abort();
          break;
        }

        if (input.forkSession) {
          newSessionId = message.session_id;
          if (newSessionId !== input.sessionId && !sessionManager.get(newSessionId)) {
            try {
              sessionManager.create({
                sessionId: newSessionId,
                cwd: message.cwd,
                model: message.model,
                permissionMode: effectivePermissionMode,
                allowedTools: input.allowedTools,
                disallowedTools: input.disallowedTools,
                tools: input.tools ?? message.tools,
                maxTurns: input.maxTurns,
                systemPrompt: input.systemPrompt,
                agents: input.agents,
                maxBudgetUsd: input.maxBudgetUsd,
                effort: input.effort,
                betas: input.betas ?? message.betas,
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
                settingSources: input.settingSources,
                debug: input.debug,
                debugFile: input.debugFile,
                env: input.env,
                abortController,
              });
            } catch {
              // If it already exists, treat as busy.
              isError = true;
              resultText = `Error [${ErrorCode.SESSION_BUSY}]: Session is not available (status: running).`;
              abortController.abort();
              break;
            }
          }
        } else {
          sessionManager.update(input.sessionId, {
            cwd: message.cwd,
            model: message.model,
            permissionMode: effectivePermissionMode,
            betas: input.betas ?? message.betas,
            tools: input.tools ?? message.tools,
          });
        }
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
    const isAborted =
      abortController.signal.aborted ||
      err instanceof AbortError ||
      (err instanceof Error && err.name === "AbortError");
    if (isAborted) {
      resultText = timedOut
        ? `Error [${ErrorCode.TIMEOUT}]: Session timed out after ${input.timeout}ms.`
        : `Error [${ErrorCode.CANCELLED}]: Session was cancelled.`;
    } else {
      resultText = err instanceof Error ? err.message : String(err);
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

  if (!seenResult && !isError) {
    isError = true;
    errorSubtype = errorSubtype ?? "missing_result";
    const noResultMsg = `Error [${ErrorCode.INTERNAL}]: No result message received from agent.`;
    resultText = resultText ? `${noResultMsg} Original: ${resultText}` : noResultMsg;
  }

  const targetSessionId = input.forkSession ? newSessionId : input.sessionId;

  // Update totals/status and clear abortController for tracked sessions.
  // Note: In disk-resume mode, the original session may not exist in memory (it was resumed
  // from disk). When forking, only the new forked session is tracked; the original session
  // has no in-memory state to clean up, which is the expected behavior.
  const tracked = sessionManager.get(targetSessionId);
  if (tracked) {
    const nextTurns = input.forkSession ? numTurns : (tracked.totalTurns ?? 0) + numTurns;
    const nextCost = input.forkSession ? totalCostUsd : (tracked.totalCostUsd ?? 0) + totalCostUsd;
    if (tracked.status !== "cancelled") {
      sessionManager.update(targetSessionId, {
        status: isError ? "error" : "idle",
        totalTurns: nextTurns,
        totalCostUsd: nextCost,
        abortController: undefined,
      });
    } else {
      sessionManager.update(targetSessionId, {
        totalTurns: nextTurns,
        totalCostUsd: nextCost,
        abortController: undefined,
      });
    }
    const updated = sessionManager.get(targetSessionId);
    sessionTotalTurns = updated?.totalTurns;
    sessionTotalCostUsd = updated?.totalCostUsd;
  }

  // If fork was requested but no new session ID was received, flag as internal error
  if (input.forkSession && newSessionId === input.sessionId && !isError) {
    isError = true;
    const noForkMsg = `Error [${ErrorCode.INTERNAL}]: Fork requested but no new session ID received from agent.`;
    resultText = resultText ? `${noForkMsg} Original: ${resultText}` : noForkMsg;
  }

  return {
    sessionId: targetSessionId,
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
