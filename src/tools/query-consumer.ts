import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "../session/manager.js";
import type {
  AgentResult,
  PermissionRequestRecord,
  PermissionResult,
  StoredAgentResult,
} from "../types.js";
import { ErrorCode } from "../types.js";
import { enhanceWindowsError } from "../utils/windows.js";
import { normalizePermissionUpdatedInput } from "../utils/permission-updated-input.js";
import { normalizeToolInput } from "../utils/normalize-tool-input.js";
import {
  findUnsupportedPosixPathInToolInput,
  isUnsupportedPosixAbsolutePath,
} from "../utils/normalize-windows-path.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";

export type ConsumeQueryMode = "start" | "resume" | "disk-resume";

// --- C1: Error classification and retry constants ---

const MAX_TRANSIENT_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

const DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60_000;

export const MAX_PREINIT_BUFFER_MESSAGES = 200;

export type ErrorClass = "abort" | "transient" | "fatal";

export function clampPermissionRequestTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_PERMISSION_REQUEST_TIMEOUT_MS;
  return Math.min(ms, MAX_PERMISSION_REQUEST_TIMEOUT_MS);
}

export function classifyError(err: unknown, abortSignal: AbortSignal): ErrorClass {
  if (abortSignal.aborted) return "abort";
  if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
    return "abort";
  }
  if (
    err instanceof Error &&
    (err.message.includes("ECONNRESET") ||
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("ECONNREFUSED") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("EAI_AGAIN") ||
      err.message.includes("EPIPE") ||
      err.message.includes("stream ended unexpectedly") ||
      err.message.includes("socket hang up"))
  ) {
    return "transient";
  }
  return "fatal";
}

type QueryLike = AsyncIterable<SDKMessage> & {
  close?: () => void;
  interrupt?: () => void | Promise<void>;
};

export type ConsumeQueryParams =
  | {
      mode: "start";
      prompt: string;
      abortController: AbortController;
      /** For tests only: override platform-dependent behavior. */
      platform?: NodeJS.Platform;
      options: Partial<Options>;
      permissionRequestTimeoutMs: number;
      sessionInitTimeoutMs: number;
      sessionManager: SessionManager;
      toolCache?: ToolDiscoveryCache;
      onInit?: (init: SDKSystemMessage) => void;
    }
  | {
      mode: "resume" | "disk-resume";
      sessionId: string;
      prompt: string;
      abortController: AbortController;
      /** For tests only: override platform-dependent behavior. */
      platform?: NodeJS.Platform;
      options: Partial<Options>;
      permissionRequestTimeoutMs: number;
      sessionInitTimeoutMs: number;
      waitForInitSessionId?: boolean;
      sessionManager: SessionManager;
      toolCache?: ToolDiscoveryCache;
      onInit?: (init: SDKSystemMessage) => void;
    };

export type ConsumeQueryHandle = {
  sdkSessionIdPromise: Promise<string>;
  done: Promise<void>;
  close: () => void;
  interrupt: () => void;
};

function isSystemInitMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system" && msg.subtype === "init";
}

function summarizePermission(toolName: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input ?? {}).slice(0, 5);
  const suffix = keys.length > 0 ? ` (keys: ${keys.join(", ")})` : "";
  return `${toolName} permission request${suffix}`;
}

function describeTool(toolName: string, toolCache?: ToolDiscoveryCache): string | undefined {
  const tools = toolCache?.getTools();
  const found = tools?.find((t) => t.name === toolName);
  return found?.description;
}

function normalizePolicyToolNames(tools: string[] | undefined): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter((tool) => tool !== "");
}

function sdkResultToAgentResult(result: SDKResultMessage): AgentResult {
  const sessionTotalTurns = (result as unknown as { session_total_turns?: unknown })
    .session_total_turns;
  const sessionTotalCostUsd = (result as unknown as { session_total_cost_usd?: unknown })
    .session_total_cost_usd;

  const base = {
    sessionId: result.session_id,
    durationMs: result.duration_ms,
    durationApiMs: result.duration_api_ms,
    numTurns: result.num_turns,
    totalCostUsd: result.total_cost_usd,
    sessionTotalTurns: typeof sessionTotalTurns === "number" ? sessionTotalTurns : undefined,
    sessionTotalCostUsd: typeof sessionTotalCostUsd === "number" ? sessionTotalCostUsd : undefined,
    stopReason: result.stop_reason,
    fastModeState: result.fast_mode_state,
    usage: result.usage,
    modelUsage: result.modelUsage,
    permissionDenials: result.permission_denials,
  };

  if (result.subtype === "success") {
    return {
      ...base,
      result: result.result,
      structuredOutput: result.structured_output,
      isError: false,
    };
  }

  const errors =
    Array.isArray(result.errors) && result.errors.length > 0
      ? result.errors.map(String).join("\n")
      : `Error [${result.subtype}]: Unknown error`;

  return {
    ...base,
    result: errors,
    isError: true,
    errorSubtype: result.subtype,
  };
}

function errorToAgentResult(sessionId: string, err: unknown): AgentResult {
  const message =
    err instanceof Error ? enhanceWindowsError(err.message) : enhanceWindowsError(String(err));
  return {
    sessionId,
    result: `Error [${ErrorCode.INTERNAL}]: ${message}`,
    isError: true,
    durationMs: 0,
    numTurns: 0,
    totalCostUsd: 0,
  };
}

function messageToEvent(msg: SDKMessage): { type: "output" | "progress"; data: unknown } | null {
  if (msg.type === "assistant") {
    return {
      type: "output",
      data: {
        type: "assistant",
        message: msg.message,
        parent_tool_use_id: msg.parent_tool_use_id,
        error: msg.error,
      },
    };
  }

  if (msg.type === "stream_event") {
    return {
      type: "output",
      data: {
        type: "stream_event",
        event: msg.event,
        parent_tool_use_id: msg.parent_tool_use_id,
      },
    };
  }

  if (msg.type === "tool_use_summary") {
    return { type: "progress", data: { type: "tool_use_summary", summary: msg.summary } };
  }

  if (msg.type === "system" && msg.subtype === "local_command_output") {
    return {
      type: "output",
      data: {
        type: "local_command_output",
        content: msg.content,
      },
    };
  }

  if (msg.type === "tool_progress") {
    return {
      type: "progress",
      data: {
        type: "tool_progress",
        tool_use_id: msg.tool_use_id,
        tool_name: msg.tool_name,
        parent_tool_use_id: msg.parent_tool_use_id,
        elapsed_time_seconds: msg.elapsed_time_seconds,
        task_id: msg.task_id,
      },
    };
  }

  if (msg.type === "auth_status") {
    return {
      type: "progress",
      data: {
        type: "auth_status",
        isAuthenticating: msg.isAuthenticating,
        output: msg.output,
        error: msg.error,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "status") {
    return {
      type: "progress",
      data: { type: "status", status: msg.status, permissionMode: msg.permissionMode },
    };
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    return {
      type: "progress",
      data: {
        type: "compact_boundary",
        compact_metadata: msg.compact_metadata,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "hook_started") {
    return {
      type: "progress",
      data: {
        type: "hook_started",
        hook_id: msg.hook_id,
        hook_name: msg.hook_name,
        hook_event: msg.hook_event,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "hook_progress") {
    return {
      type: "progress",
      data: {
        type: "hook_progress",
        hook_id: msg.hook_id,
        hook_name: msg.hook_name,
        hook_event: msg.hook_event,
        stdout: msg.stdout,
        stderr: msg.stderr,
        output: msg.output,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "hook_response") {
    return {
      type: "progress",
      data: {
        type: "hook_response",
        hook_id: msg.hook_id,
        hook_name: msg.hook_name,
        hook_event: msg.hook_event,
        output: msg.output,
        stdout: msg.stdout,
        stderr: msg.stderr,
        exit_code: msg.exit_code,
        outcome: msg.outcome,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "files_persisted") {
    return {
      type: "progress",
      data: {
        type: "files_persisted",
        files: msg.files,
        failed: msg.failed,
        processed_at: msg.processed_at,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "api_retry") {
    return {
      type: "progress",
      data: {
        type: "api_retry",
        attempt: msg.attempt,
        max_retries: msg.max_retries,
        retry_delay_ms: msg.retry_delay_ms,
        error_status: msg.error_status,
        error: msg.error,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "task_started") {
    return {
      type: "progress",
      data: {
        type: "task_started",
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        description: msg.description,
        task_type: msg.task_type,
        prompt: msg.prompt,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "task_progress") {
    return {
      type: "progress",
      data: {
        type: "task_progress",
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        description: msg.description,
        usage: msg.usage,
        last_tool_name: msg.last_tool_name,
        summary: msg.summary,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "task_notification") {
    return {
      type: "progress",
      data: {
        type: "task_notification",
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        status: msg.status,
        summary: msg.summary,
        output_file: msg.output_file,
        usage: msg.usage,
      },
    };
  }

  if (msg.type === "system" && msg.subtype === "elicitation_complete") {
    return {
      type: "progress",
      data: {
        type: "elicitation_complete",
        mcp_server_name: msg.mcp_server_name,
        elicitation_id: msg.elicitation_id,
      },
    };
  }

  if (msg.type === "rate_limit_event" || msg.type === "prompt_suggestion") {
    const rest = { ...(msg as unknown as Record<string, unknown>) };
    delete rest.type;
    delete rest.uuid;
    delete rest.session_id;
    return {
      type: "progress",
      data: { type: msg.type, ...rest },
    };
  }

  return null;
}

export function consumeQuery(params: ConsumeQueryParams): ConsumeQueryHandle {
  let resolveSessionId!: (id: string) => void;
  let rejectSessionId!: (err: Error) => void;
  const sdkSessionIdPromise = new Promise<string>((resolve, reject) => {
    resolveSessionId = resolve;
    rejectSessionId = reject;
  });
  const waitForInitSessionId =
    params.mode !== "start" ? (params.waitForInitSessionId ?? false) : false;
  const shouldWaitForInit = params.mode === "start" || waitForInitSessionId;

  let sessionIdResolved = false;
  let activeSessionId = "";
  if (params.mode !== "start" && !waitForInitSessionId) {
    sessionIdResolved = true;
    activeSessionId = params.sessionId;
    resolveSessionId(activeSessionId);
  }

  const getSessionId = async (): Promise<string> => {
    if (activeSessionId) return activeSessionId;
    activeSessionId = await sdkSessionIdPromise;
    return activeSessionId;
  };

  let initTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const permissionRequestTimeoutMs = clampPermissionRequestTimeoutMs(
    params.permissionRequestTimeoutMs
  );

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const sessionId = await getSessionId();
    const normalizedToolName = toolName.trim();
    const normalizedInput = normalizeToolInput(toolName, input, params.platform);
    const unsupportedPath = findUnsupportedPosixPathInToolInput(normalizedInput, params.platform);
    if (unsupportedPath) {
      return {
        behavior: "deny",
        message: `Tool '${normalizedToolName || toolName}' requested unsupported POSIX path '${
          unsupportedPath
        }' on Windows.`,
        interrupt: false,
      };
    }
    if (
      typeof options.blockedPath === "string" &&
      isUnsupportedPosixAbsolutePath(options.blockedPath, params.platform)
    ) {
      return {
        behavior: "deny",
        message: `Tool '${normalizedToolName || toolName}' requested blocked path '${options.blockedPath}' that is unsupported on Windows.`,
        interrupt: false,
      };
    }

    // Keep MCP permission behavior consistent with the SDK options semantics:
    // - disallowedTools: hard deny
    // - allowedTools: auto-allow (but still prompt if the SDK provides a blockedPath)
    // Note: we still pass allowedTools/disallowedTools to the SDK via options; this is a
    // defensive fast-path in case the SDK calls canUseTool for all tool uses.
    const sessionInfo = params.sessionManager.get(sessionId);
    if (sessionInfo) {
      const disallowedTools = normalizePolicyToolNames(sessionInfo.disallowedTools);
      const allowedTools = normalizePolicyToolNames(sessionInfo.allowedTools);
      if (normalizedToolName !== "" && disallowedTools.includes(normalizedToolName)) {
        return {
          behavior: "deny",
          message: `Tool '${normalizedToolName}' is disallowed by session policy.`,
        };
      }

      if (
        sessionInfo.strictAllowedTools === true &&
        normalizedToolName !== "" &&
        allowedTools.length > 0 &&
        !allowedTools.includes(normalizedToolName)
      ) {
        return {
          behavior: "deny",
          message: `Tool '${normalizedToolName}' is not in allowedTools under strictAllowedTools policy.`,
          interrupt: false,
        };
      }

      if (
        !options.blockedPath &&
        normalizedToolName !== "" &&
        allowedTools.includes(normalizedToolName)
      ) {
        return {
          behavior: "allow",
          updatedInput: normalizePermissionUpdatedInput(normalizedInput),
        };
      }
    }

    const requestId = `${options.toolUseID}:${toolName}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    const createdAt = new Date().toISOString();
    const timeoutMs = permissionRequestTimeoutMs;
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    const record: PermissionRequestRecord = {
      requestId,
      toolName,
      input: normalizedInput,
      summary: options.title ?? summarizePermission(toolName, normalizedInput),
      title: options.title,
      displayName: options.displayName,
      description: options.description ?? describeTool(toolName, params.toolCache),
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      toolUseID: options.toolUseID,
      agentID: options.agentID,
      suggestions: options.suggestions,
      createdAt,
      timeoutMs,
      expiresAt,
    };

    return await new Promise<PermissionResult>((resolve) => {
      let finished = false;
      const abortListener = () => {
        params.sessionManager.finishRequest(
          sessionId,
          requestId,
          { behavior: "deny", message: "Session cancelled", interrupt: true },
          "signal"
        );
      };
      const finish: (result: PermissionResult) => void = (result) => {
        if (finished) return;
        finished = true;
        options.signal.removeEventListener("abort", abortListener);
        resolve(result);
      };

      const registered = params.sessionManager.setPendingPermission(
        sessionId,
        record,
        finish,
        permissionRequestTimeoutMs
      );

      // If the session was deleted/missing, resolve immediately with deny
      // to prevent the Promise from hanging forever.
      if (!registered) {
        finish({
          behavior: "deny",
          message: "Session no longer exists.",
          interrupt: true,
        });
        return;
      }

      options.signal.addEventListener("abort", abortListener, { once: true });

      // M1 fix: if the signal was already aborted before we registered the
      // listener, the "abort" event won't fire.  Check synchronously so the
      // Promise resolves immediately instead of waiting for the timeout.
      if (options.signal.aborted) {
        abortListener();
      }
    });
  };

  const options: Partial<Options> = {
    ...params.options,
    abortController: params.abortController,
    permissionMode: "default",
    canUseTool,
  };

  const startQuery = (opts: Partial<Options>): QueryLike =>
    query({
      prompt: params.prompt,
      options: opts,
    }) as unknown as QueryLike;

  if (params.mode === "resume" || params.mode === "disk-resume") {
    options.resume = params.sessionId;
  }

  let activeQuery: QueryLike = startQuery(options);

  const close = (): void => {
    try {
      activeQuery.close?.();
    } finally {
      params.abortController.abort();
    }
  };

  const interrupt = (): void => {
    try {
      void Promise.resolve(activeQuery.interrupt?.()).catch(() => {
        // Best-effort: interrupt failures should not crash the server.
      });
    } catch {
      // ignore interrupt errors
    }
  };

  const done = (async (): Promise<void> => {
    const preInit: SDKMessage[] = [];
    let preInitDropped = 0;

    if (shouldWaitForInit) {
      initTimeoutId = setTimeout(() => {
        close();
        rejectSessionId(
          new Error(
            `Error [${ErrorCode.TIMEOUT}]: session init timed out after ${params.sessionInitTimeoutMs}ms.`
          )
        );
      }, params.sessionInitTimeoutMs);
    }

    let retryCount = 0;
    let currentStream: QueryLike = activeQuery;

    // Outer loop: retries on transient errors (C1 fix)
    while (true) {
      let streamReceivedResult = false;
      try {
        for await (const message of currentStream) {
          if (isSystemInitMessage(message)) {
            params.toolCache?.updateFromInit(message.tools);
            params.onInit?.(message);
            params.sessionManager.setInitTools(message.session_id, message.tools);
            params.sessionManager.update(message.session_id, {
              model: message.model,
              permissionMode: message.permissionMode,
              fastModeState: message.fast_mode_state,
            });

            activeSessionId = message.session_id;
            if (!sessionIdResolved && shouldWaitForInit) {
              sessionIdResolved = true;
              resolveSessionId(activeSessionId);
              if (initTimeoutId) clearTimeout(initTimeoutId);

              if (preInitDropped > 0) {
                params.sessionManager.pushEvent(activeSessionId, {
                  type: "progress",
                  data: { type: "pre_init_dropped", dropped: preInitDropped },
                  timestamp: new Date().toISOString(),
                });
              }

              for (const buffered of preInit) {
                const event = messageToEvent(buffered);
                if (!event) continue;
                params.sessionManager.pushEvent(activeSessionId, {
                  type: event.type,
                  data: event.data,
                  timestamp: new Date().toISOString(),
                });
              }
              preInit.length = 0;
            }

            continue;
          }

          if (shouldWaitForInit && !sessionIdResolved) {
            preInit.push(message);
            if (preInit.length > MAX_PREINIT_BUFFER_MESSAGES) {
              preInit.shift();
              preInitDropped++;
            }
            continue;
          }

          if (message.type === "result") {
            streamReceivedResult = true;
            const sessionId = message.session_id ?? (await getSessionId());
            const agentResult = sdkResultToAgentResult(message);
            const current = params.sessionManager.get(sessionId);
            const previousTotalTurns = current?.totalTurns ?? 0;
            const previousTotalCostUsd = current?.totalCostUsd ?? 0;
            const computedTotalTurns = previousTotalTurns + agentResult.numTurns;
            const computedTotalCostUsd = previousTotalCostUsd + agentResult.totalCostUsd;
            const sessionTotalTurns =
              typeof agentResult.sessionTotalTurns === "number"
                ? Math.max(agentResult.sessionTotalTurns, computedTotalTurns)
                : computedTotalTurns;
            const sessionTotalCostUsd =
              typeof agentResult.sessionTotalCostUsd === "number"
                ? Math.max(agentResult.sessionTotalCostUsd, computedTotalCostUsd)
                : computedTotalCostUsd;
            const resultWithSessionTotals: AgentResult = {
              ...agentResult,
              sessionTotalTurns,
              sessionTotalCostUsd,
            };
            const stored: StoredAgentResult = {
              type: agentResult.isError ? "error" : "result",
              result: resultWithSessionTotals,
              createdAt: new Date().toISOString(),
            };
            params.sessionManager.setResult(sessionId, stored);

            // Keep only the most recent terminal event (sessions can have multiple replies).
            params.sessionManager.clearTerminalEvents(sessionId);
            params.sessionManager.pushEvent(sessionId, {
              type: agentResult.isError ? "error" : "result",
              data: resultWithSessionTotals,
              timestamp: new Date().toISOString(),
            });

            if (current && current.status !== "cancelled") {
              params.sessionManager.update(sessionId, {
                status: agentResult.isError ? "error" : "idle",
                totalTurns: sessionTotalTurns,
                totalCostUsd: sessionTotalCostUsd,
                fastModeState: agentResult.fastModeState,
                abortController: undefined,
                queryInterrupt: undefined,
              });
            } else if (current) {
              params.sessionManager.update(sessionId, {
                totalTurns: sessionTotalTurns,
                totalCostUsd: sessionTotalCostUsd,
                fastModeState: agentResult.fastModeState,
                abortController: undefined,
                queryInterrupt: undefined,
              });
            }

            continue;
          }

          const sessionId = message.session_id ?? (await getSessionId());
          const event = messageToEvent(message);
          if (event) {
            params.sessionManager.pushEvent(sessionId, {
              type: event.type,
              data: event.data,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Stream ended normally. If no result was received, convert to an explicit error.
        if (shouldWaitForInit && !sessionIdResolved) {
          rejectSessionId(
            new Error(
              `Error [${ErrorCode.INTERNAL}]: query stream ended before receiving session init.`
            )
          );
        } else if (activeSessionId && !streamReceivedResult) {
          const sessionId = activeSessionId;
          const current = params.sessionManager.get(sessionId);
          if (current && current.status !== "cancelled") {
            params.sessionManager.finishAllPending(
              sessionId,
              {
                behavior: "deny",
                message: "Session ended before permission was resolved.",
                interrupt: true,
              },
              "cleanup"
            );
            const agentResult = errorToAgentResult(
              sessionId,
              "No result message received from agent."
            );
            const stored: StoredAgentResult = {
              type: "error",
              result: agentResult,
              createdAt: new Date().toISOString(),
            };
            params.sessionManager.setResult(sessionId, stored);
            params.sessionManager.clearTerminalEvents(sessionId);
            params.sessionManager.pushEvent(sessionId, {
              type: "error",
              data: agentResult,
              timestamp: new Date().toISOString(),
            });
            params.sessionManager.update(sessionId, {
              status: "error",
              abortController: undefined,
              queryInterrupt: undefined,
            });
          }
        }
        return; // normal exit
      } catch (err: unknown) {
        const errClass = classifyError(err, params.abortController.signal);

        // Before init: no session to retry, just reject and bail.
        if (shouldWaitForInit && !sessionIdResolved) {
          rejectSessionId(
            new Error(
              errClass === "abort"
                ? `Error [${ErrorCode.CANCELLED}]: session was cancelled before init.`
                : `Error [${ErrorCode.INTERNAL}]: ${enhanceWindowsError(err instanceof Error ? err.message : String(err))}`
            )
          );
          return;
        }

        // If a result was already delivered, ignore trailing stream errors so that
        // post-result events (e.g. prompt_suggestion) don't turn the session into error.
        if (streamReceivedResult) {
          return;
        }

        if (!activeSessionId) return;
        const sessionId = activeSessionId;

        // C1: transient errors → resume retry with exponential backoff
        if (errClass === "transient" && retryCount < MAX_TRANSIENT_RETRIES) {
          retryCount++;
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount - 1);
          params.sessionManager.pushEvent(sessionId, {
            type: "progress",
            data: {
              type: "retry",
              attempt: retryCount,
              maxRetries: MAX_TRANSIENT_RETRIES,
              delayMs: delay,
              error: err instanceof Error ? err.message : String(err),
            },
            timestamp: new Date().toISOString(),
          });
          await new Promise<void>((r) => {
            const timer = setTimeout(r, delay);
            const onAbort = () => {
              clearTimeout(timer);
              r();
            };
            params.abortController.signal.addEventListener("abort", onAbort, { once: true });
          });
          if (params.abortController.signal.aborted) return;

          // Rebuild query with resume to continue from where we left off.
          // Pending permissions are lost; SDK will re-issue canUseTool calls.
          params.sessionManager.finishAllPending(
            sessionId,
            { behavior: "deny", message: "Retrying after transient error.", interrupt: false },
            "cleanup"
          );
          const retryOpts: Partial<Options> = {
            ...options,
            resume: sessionId,
          };
          currentStream = startQuery(retryOpts);
          activeQuery = currentStream;
          continue; // retry the while loop
        }

        // abort or fatal: record error and stop
        const current = params.sessionManager.get(sessionId);
        if (current && current.status !== "cancelled") {
          params.sessionManager.finishAllPending(
            sessionId,
            {
              behavior: "deny",
              message: "Session failed before permission was resolved.",
              interrupt: true,
            },
            "cleanup"
          );
          const agentResult =
            errClass === "abort"
              ? {
                  sessionId,
                  result: `Error [${ErrorCode.CANCELLED}]: Session was cancelled.`,
                  isError: true,
                  durationMs: 0,
                  numTurns: 0,
                  totalCostUsd: 0,
                }
              : errorToAgentResult(sessionId, err);

          params.sessionManager.setResult(sessionId, {
            type: "error",
            result: agentResult,
            createdAt: new Date().toISOString(),
          });

          params.sessionManager.clearTerminalEvents(sessionId);
          params.sessionManager.pushEvent(sessionId, {
            type: "error",
            data: agentResult,
            timestamp: new Date().toISOString(),
          });

          params.sessionManager.update(sessionId, {
            status: "error",
            abortController: undefined,
            queryInterrupt: undefined,
          });
        }
        return; // fatal/abort exit
      } finally {
        if (initTimeoutId) clearTimeout(initTimeoutId);
      }
    }
  })();

  return { sdkSessionIdPromise, done, close, interrupt };
}
