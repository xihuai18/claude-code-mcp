/**
 * claude_code_check tool - Poll session events and respond to permission requests (v2 baseline)
 */
import type { SessionManager } from "../session/manager.js";
import type {
  AgentResult,
  CheckAction,
  CheckResult,
  CheckResponseMode,
  PermissionDecision,
  PermissionResult,
  PermissionUpdate,
  SessionEventType,
  SessionStatus,
} from "../types.js";
import { ErrorCode } from "../types.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { discoverToolsFromInit } from "./tool-discovery.js";

export interface ClaudeCodeCheckInput {
  action: CheckAction;
  sessionId: string;
  cursor?: number;
  includeTools?: boolean;

  /**
   * Response shaping. Defaults to "minimal" to reduce payload size.
   * Use "full" to include verbose fields like usage/modelUsage.
   */
  responseMode?: CheckResponseMode;
  /** Max number of events to return per poll (pagination via nextCursor). */
  maxEvents?: number;
  /** Include the events array (default true). */
  includeEvents?: boolean;
  /** Include actions[] for pending permissions (default true). */
  includeActions?: boolean;
  /** Include top-level result when status is idle/error (default true). */
  includeResult?: boolean;
  /** Include AgentResult.usage (default: full=true, minimal=false). */
  includeUsage?: boolean;
  /** Include AgentResult.modelUsage (default: full=true, minimal=false). */
  includeModelUsage?: boolean;
  /** Include AgentResult.structuredOutput (default: full=true, minimal=false). */
  includeStructuredOutput?: boolean;
  /**
   * Include terminal result/error events in the events stream when top-level result is included.
   * Default: full=true, minimal=false (to avoid duplication).
   */
  includeTerminalEvents?: boolean;

  requestId?: string;
  decision?: PermissionDecision;
  denyMessage?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<Record<string, unknown>>;
  interrupt?: boolean;
}

export type ClaudeCodeCheckResult =
  | CheckResult
  | { sessionId: string; error: string; isError: true };

function pollIntervalForStatus(status: SessionStatus): number | undefined {
  if (status === "waiting_permission") return 1000;
  if (status === "running") return 3000;
  return undefined;
}

function toPermissionResult(params: {
  decision: PermissionDecision;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<Record<string, unknown>>;
  denyMessage?: string;
  interrupt?: boolean;
}): PermissionResult {
  if (params.decision === "allow") {
    return {
      behavior: "allow",
      updatedInput: params.updatedInput,
      updatedPermissions: params.updatedPermissions as unknown as PermissionUpdate[] | undefined,
    };
  }
  return {
    behavior: "deny",
    message: params.denyMessage ?? "Permission denied by caller",
    interrupt: params.interrupt,
  };
}

function toEvents(
  events: Array<{ id: number; type: SessionEventType; data: unknown; timestamp: string }>,
  opts: { includeUsage: boolean; includeModelUsage: boolean; includeStructuredOutput: boolean }
): CheckResult["events"] {
  return events.map((e) => {
    if ((e.type === "result" || e.type === "error") && isAgentResult(e.data)) {
      const redacted = redactAgentResult(e.data, opts);
      return { id: e.id, type: e.type, data: redacted, timestamp: e.timestamp };
    }
    return { id: e.id, type: e.type, data: e.data, timestamp: e.timestamp };
  });
}

function buildResult(
  sessionManager: SessionManager,
  toolCache: ToolDiscoveryCache | undefined,
  input: ClaudeCodeCheckInput
): CheckResult {
  const responseMode: CheckResponseMode = input.responseMode ?? "minimal";
  const includeTools = input.includeTools;
  const includeEvents = input.includeEvents ?? true;
  const includeActions = input.includeActions ?? true;
  const includeResult = input.includeResult ?? true;
  const includeUsage = input.includeUsage ?? responseMode === "full";
  const includeModelUsage = input.includeModelUsage ?? responseMode === "full";
  const includeStructuredOutput = input.includeStructuredOutput ?? responseMode === "full";
  const includeTerminalEvents = input.includeTerminalEvents ?? responseMode === "full";
  const maxEvents = input.maxEvents ?? (responseMode === "minimal" ? 200 : undefined);

  const sessionId = input.sessionId;
  const session = sessionManager.get(sessionId);
  const status: SessionStatus = session?.status ?? "error";

  const {
    events: rawEvents,
    nextCursor: rawNextCursor,
    cursorResetTo,
  } = sessionManager.readEvents(sessionId, input.cursor);

  let truncated = false;
  const truncatedFields: string[] = [];

  // Apply pagination by event count (caller should continue with nextCursor).
  const windowEvents =
    maxEvents !== undefined && rawEvents.length > maxEvents
      ? rawEvents.slice(0, maxEvents)
      : rawEvents;
  const nextCursor =
    maxEvents !== undefined && rawEvents.length > maxEvents
      ? windowEvents.length > 0
        ? windowEvents[windowEvents.length - 1].id + 1
        : rawNextCursor
      : rawNextCursor;
  if (maxEvents !== undefined && rawEvents.length > maxEvents) {
    truncated = true;
    truncatedFields.push("events");
  }

  const outputEvents = (() => {
    if (!includeEvents) return [] as typeof windowEvents;

    // Avoid duplicating terminal result/error both in events and top-level result.
    if (!includeTerminalEvents && includeResult && (status === "idle" || status === "error")) {
      return windowEvents.filter((e) => e.type !== "result" && e.type !== "error");
    }

    return windowEvents;
  })();

  const pending =
    status === "waiting_permission" ? sessionManager.listPendingPermissions(sessionId) : [];
  const stored =
    status === "idle" || status === "error" ? sessionManager.getResult(sessionId) : undefined;

  const initTools = includeTools ? sessionManager.getInitTools(sessionId) : undefined;
  const availableTools = includeTools && initTools ? discoverToolsFromInit(initTools) : undefined;

  return {
    sessionId,
    status,
    pollInterval: pollIntervalForStatus(status),
    cursorResetTo,
    truncated: truncated ? true : undefined,
    truncatedFields: truncatedFields.length > 0 ? truncatedFields : undefined,
    events: toEvents(outputEvents, { includeUsage, includeModelUsage, includeStructuredOutput }),
    nextCursor,
    availableTools,
    actions:
      includeActions && status === "waiting_permission"
        ? pending.map((req) => ({
            type: "permission" as const,
            requestId: req.requestId,
            toolName: req.toolName,
            input: req.input,
            summary: req.summary,
            decisionReason: req.decisionReason,
            blockedPath: req.blockedPath,
            toolUseID: req.toolUseID,
            agentID: req.agentID,
            suggestions: req.suggestions,
            description: req.description,
            createdAt: req.createdAt,
          }))
        : undefined,
    result:
      includeResult && stored?.result
        ? redactAgentResult(stored.result, {
            includeUsage,
            includeModelUsage,
            includeStructuredOutput,
          })
        : undefined,
    cancelledAt: session?.cancelledAt,
    cancelledReason: session?.cancelledReason,
    cancelledSource: session?.cancelledSource,
    lastEventId: sessionManager.getLastEventId(sessionId),
    lastToolUseId: session?.lastToolUseId,
  };
}

function isAgentResult(value: unknown): value is AgentResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.result === "string" &&
    typeof v.isError === "boolean" &&
    typeof v.durationMs === "number" &&
    typeof v.numTurns === "number" &&
    typeof v.totalCostUsd === "number"
  );
}

function redactAgentResult(
  result: AgentResult,
  opts: { includeUsage: boolean; includeModelUsage: boolean; includeStructuredOutput: boolean }
): AgentResult {
  const { usage, modelUsage, structuredOutput, ...rest } = result;

  return {
    ...rest,
    usage: opts.includeUsage ? usage : undefined,
    modelUsage: opts.includeModelUsage ? modelUsage : undefined,
    structuredOutput: opts.includeStructuredOutput ? structuredOutput : undefined,
  };
}

export function executeClaudeCodeCheck(
  input: ClaudeCodeCheckInput,
  sessionManager: SessionManager,
  toolCache?: ToolDiscoveryCache
): ClaudeCodeCheckResult {
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    return {
      sessionId: "",
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId must be a non-empty string.`,
      isError: true,
    };
  }

  const session = sessionManager.get(input.sessionId);
  if (!session) {
    return {
      sessionId: input.sessionId,
      error: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found or expired.`,
      isError: true,
    };
  }

  if (input.action === "poll") {
    return buildResult(sessionManager, toolCache, input);
  }

  // respond_permission
  if (typeof input.requestId !== "string" || input.requestId.trim() === "") {
    return {
      sessionId: input.sessionId,
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: requestId is required for respond_permission.`,
      isError: true,
    };
  }
  if (input.decision !== "allow" && input.decision !== "deny") {
    return {
      sessionId: input.sessionId,
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: decision must be 'allow' or 'deny'.`,
      isError: true,
    };
  }

  const ok = sessionManager.finishRequest(
    input.sessionId,
    input.requestId,
    toPermissionResult({
      decision: input.decision,
      updatedInput: input.updatedInput,
      updatedPermissions: input.updatedPermissions,
      denyMessage: input.denyMessage,
      interrupt: input.interrupt,
    }),
    "respond"
  );
  if (!ok) {
    return {
      sessionId: input.sessionId,
      error: `Error [${ErrorCode.PERMISSION_REQUEST_NOT_FOUND}]: requestId '${input.requestId}' not found (already finished or expired).`,
      isError: true,
    };
  }

  return buildResult(sessionManager, toolCache, input);
}
