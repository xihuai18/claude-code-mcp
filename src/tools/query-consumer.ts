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
import type { ToolDiscoveryCache } from "./tool-discovery.js";

export type ConsumeQueryMode = "start" | "resume" | "disk-resume";

// --- C1: Error classification and retry constants ---

const MAX_TRANSIENT_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

export type ErrorClass = "abort" | "transient" | "fatal";

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

type QueryLike = AsyncIterable<SDKMessage> & { close?: () => void; interrupt?: () => void };

export type ConsumeQueryParams =
  | {
      mode: "start";
      prompt: string;
      abortController: AbortController;
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

function sdkResultToAgentResult(result: SDKResultMessage): AgentResult {
  const base = {
    sessionId: result.session_id,
    durationMs: result.duration_ms,
    durationApiMs: result.duration_api_ms,
    numTurns: result.num_turns,
    totalCostUsd: result.total_cost_usd,
    stopReason: result.stop_reason,
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

  if (msg.type === "tool_use_summary") {
    return { type: "progress", data: { type: "tool_use_summary", summary: msg.summary } };
  }

  if (msg.type === "tool_progress") {
    return {
      type: "progress",
      data: {
        type: "tool_progress",
        tool_use_id: msg.tool_use_id,
        tool_name: msg.tool_name,
        elapsed_time_seconds: msg.elapsed_time_seconds,
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

  if (msg.type === "system" && msg.subtype === "task_notification") {
    return {
      type: "progress",
      data: {
        type: "task_notification",
        task_id: msg.task_id,
        status: msg.status,
        summary: msg.summary,
        output_file: msg.output_file,
      },
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

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const sessionId = await getSessionId();

    // Keep MCP permission behavior consistent with the SDK options semantics:
    // - disallowedTools: hard deny
    // - allowedTools: auto-allow (but still prompt if the SDK provides a blockedPath)
    // Note: we still pass allowedTools/disallowedTools to the SDK via options; this is a
    // defensive fast-path in case the SDK calls canUseTool for all tool uses.
    const sessionInfo = params.sessionManager.get(sessionId);
    if (sessionInfo) {
      if (
        Array.isArray(sessionInfo.disallowedTools) &&
        sessionInfo.disallowedTools.includes(toolName)
      ) {
        return { behavior: "deny", message: `Tool '${toolName}' is disallowed by session policy.` };
      }

      if (
        !options.blockedPath &&
        Array.isArray(sessionInfo.allowedTools) &&
        sessionInfo.allowedTools.includes(toolName)
      ) {
        return { behavior: "allow" };
      }
    }

    const requestId = `${options.toolUseID}:${toolName}:${Date.now()}:${Math.random()
      .toString(16)
      .slice(2)}`;
    const record: PermissionRequestRecord = {
      requestId,
      toolName,
      input,
      summary: summarizePermission(toolName, input),
      description: describeTool(toolName, params.toolCache),
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      toolUseID: options.toolUseID,
      agentID: options.agentID,
      suggestions: options.suggestions,
      createdAt: new Date().toISOString(),
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
        params.permissionRequestTimeoutMs
      );

      // If the session was deleted/missing, resolve immediately with deny
      // to prevent the Promise from hanging forever.
      if (!registered) {
        finish({ behavior: "deny", message: "Session no longer exists.", interrupt: true });
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
    activeQuery.interrupt?.();
  };

  const done = (async (): Promise<void> => {
    const preInit: SDKMessage[] = [];

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
      try {
        for await (const message of currentStream) {
          if (isSystemInitMessage(message)) {
            params.toolCache?.updateFromInit(message.tools);
            params.onInit?.(message);
            params.sessionManager.setInitTools(message.session_id, message.tools);

            activeSessionId = message.session_id;
            if (!sessionIdResolved && shouldWaitForInit) {
              sessionIdResolved = true;
              resolveSessionId(activeSessionId);
              if (initTimeoutId) clearTimeout(initTimeoutId);

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
            continue;
          }

          if (message.type === "result") {
            const sessionId = message.session_id ?? (await getSessionId());
            const agentResult = sdkResultToAgentResult(message);
            const stored: StoredAgentResult = {
              type: agentResult.isError ? "error" : "result",
              result: agentResult,
              createdAt: new Date().toISOString(),
            };
            params.sessionManager.setResult(sessionId, stored);

            // Keep only the most recent terminal event (sessions can have multiple replies).
            params.sessionManager.clearTerminalEvents(sessionId);
            params.sessionManager.pushEvent(sessionId, {
              type: agentResult.isError ? "error" : "result",
              data: agentResult,
              timestamp: new Date().toISOString(),
            });

            const current = params.sessionManager.get(sessionId);
            if (current && current.status !== "cancelled") {
              params.sessionManager.update(sessionId, {
                status: agentResult.isError ? "error" : "idle",
                totalTurns: agentResult.numTurns,
                totalCostUsd: agentResult.totalCostUsd,
                abortController: undefined,
              });
            } else if (current) {
              params.sessionManager.update(sessionId, {
                totalTurns: agentResult.numTurns,
                totalCostUsd: agentResult.totalCostUsd,
                abortController: undefined,
              });
            }

            return;
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

        // Stream ended normally without a result message
        if (shouldWaitForInit && !sessionIdResolved) {
          rejectSessionId(
            new Error(
              `Error [${ErrorCode.INTERNAL}]: query stream ended before receiving session init.`
            )
          );
        } else if (activeSessionId) {
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

          params.sessionManager.update(sessionId, { status: "error", abortController: undefined });
        }
        return; // fatal/abort exit
      } finally {
        if (initTimeoutId) clearTimeout(initTimeoutId);
      }
    }
  })();

  return { sdkSessionIdPromise, done, close, interrupt };
}
