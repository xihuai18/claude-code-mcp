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
  PermissionRequestRecord,
  PermissionResult,
  PermissionUpdate,
  SessionInfo,
  SessionEventType,
  SessionStatus,
} from "../types.js";
import { ErrorCode } from "../types.js";
import type { ToolDiscoveryCache } from "./tool-discovery.js";
import { discoverToolsFromInit } from "./tool-discovery.js";

/** Fine-grained poll control options (most callers just use responseMode). */
export interface PollOptions {
  includeTools?: boolean;
  includeEvents?: boolean;
  includeActions?: boolean;
  includeResult?: boolean;
  includeUsage?: boolean;
  includeModelUsage?: boolean;
  includeStructuredOutput?: boolean;
  includeTerminalEvents?: boolean;
  includeProgressEvents?: boolean;
  maxBytes?: number;
}

/** Advanced permission response options. */
export interface PermissionResponseOptions {
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<Record<string, unknown>>;
}

export interface ClaudeCodeCheckInput {
  action: CheckAction;
  sessionId: string;
  cursor?: number;

  /**
   * Response shaping. Defaults to "minimal" to reduce payload size.
   * Use "full" to include verbose fields like usage/modelUsage.
   * Use "delta_compact" for high-frequency status polling.
   */
  responseMode?: CheckResponseMode;
  /** Max number of events to return per poll (pagination via nextCursor). */
  maxEvents?: number;

  /** Fine-grained poll control. Overrides responseMode defaults for individual fields. */
  pollOptions?: PollOptions;

  requestId?: string;
  decision?: PermissionDecision;
  denyMessage?: string;
  interrupt?: boolean;

  /** Advanced permission response options (only with decision='allow'/'allow_for_session'). */
  permissionOptions?: PermissionResponseOptions;
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
  if (params.decision === "allow" || params.decision === "allow_for_session") {
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

function appendAllowForSessionUpdate(
  updates: Array<Record<string, unknown>> | undefined,
  toolName: string | undefined
): Array<Record<string, unknown>> | undefined {
  const normalizedToolName = toolName?.trim();
  if (!normalizedToolName) return updates;
  return [
    ...(updates ?? []),
    {
      type: "addRules",
      behavior: "allow",
      destination: "session",
      rules: [{ toolName: normalizedToolName }],
    },
  ];
}

/**
 * Slim down an assistant output event's message object in minimal mode.
 * Strips verbose API fields (usage, model, id, type, stop_sequence) and
 * cache_control metadata from content blocks, keeping only the essentials.
 */
function slimAssistantData(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (d.type !== "assistant") return data;

  const msg = d.message;
  if (!msg || typeof msg !== "object") return data;
  const m = msg as Record<string, unknown>;

  // Strip verbose fields from the message object
  const slimmed: Record<string, unknown> = {};
  if (m.role !== undefined) slimmed.role = m.role;
  if (m.stop_reason !== undefined) slimmed.stop_reason = m.stop_reason;

  // Slim content blocks: remove cache_control and other metadata
  if (Array.isArray(m.content)) {
    slimmed.content = (m.content as Array<Record<string, unknown>>).map((block) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cache_control, ...rest } = block;
      return rest;
    });
  }

  return {
    type: d.type,
    message: slimmed,
    ...(d.parent_tool_use_id ? { parent_tool_use_id: d.parent_tool_use_id } : {}),
    ...(d.error ? { error: d.error } : {}),
  };
}

function toEvents(
  events: Array<{ id: number; type: SessionEventType; data: unknown; timestamp: string }>,
  opts: {
    includeUsage: boolean;
    includeModelUsage: boolean;
    includeStructuredOutput: boolean;
    slim: boolean;
  }
): CheckResult["events"] {
  return events.map((e) => {
    if ((e.type === "result" || e.type === "error") && isAgentResult(e.data)) {
      const redacted = redactAgentResult(e.data, opts);
      return { id: e.id, type: e.type, data: redacted, timestamp: e.timestamp };
    }
    // In minimal mode, slim down assistant output events
    if (opts.slim && e.type === "output") {
      return { id: e.id, type: e.type, data: slimAssistantData(e.data), timestamp: e.timestamp };
    }
    return { id: e.id, type: e.type, data: e.data, timestamp: e.timestamp };
  });
}

function uniqSorted(values: string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const filtered = values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(filtered)).sort((a, b) => a.localeCompare(b));
}

function detectPathCompatibilityWarnings(session: SessionInfo | undefined): string[] {
  if (!session) return [];
  const cwd = session.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") return [];

  const warnings: string[] = [];
  if (process.platform === "win32" && cwd.startsWith("/") && !cwd.startsWith("//")) {
    warnings.push(
      `cwd '${cwd}' looks POSIX-style on Windows. Consider using a Windows path (e.g. C:\\\\repo) to avoid path compatibility issues.`
    );
  }
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(cwd)) {
    warnings.push(
      `cwd '${cwd}' looks Windows-style on ${process.platform}. This may indicate cross-platform path mismatch (for example WSL boundary).`
    );
  }
  if (process.platform !== "win32" && cwd.startsWith("\\\\")) {
    warnings.push(
      `cwd '${cwd}' looks like a Windows UNC path on ${process.platform}. Confirm MCP client/server run on the same platform.`
    );
  }

  // Check additionalDirectories for POSIX paths on Windows
  if (process.platform === "win32" && Array.isArray(session.additionalDirectories)) {
    for (const dir of session.additionalDirectories) {
      if (typeof dir === "string" && dir.startsWith("/") && !dir.startsWith("//")) {
        warnings.push(
          `additionalDirectories contains POSIX-style path '${dir}' on Windows. Consider using a Windows path to avoid path compatibility issues.`
        );
      }
    }
  }

  return warnings;
}

function isPosixHomePath(value: string): boolean {
  return /^\/home\/[^/\s]+(?:\/|$)/.test(value);
}

function extractPosixHomePath(value: string): string | undefined {
  const match = value.match(/\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?/);
  return match?.[0];
}

function detectPendingPermissionPathWarnings(
  pending: PermissionRequestRecord[],
  session: SessionInfo | undefined
): string[] {
  if (process.platform !== "win32" || pending.length === 0) return [];

  const cwd = session?.cwd;
  const cwdHint =
    typeof cwd === "string" && cwd.trim() !== "" ? ` under cwd '${cwd}'` : " under the current cwd";

  const warnings: string[] = [];
  for (const req of pending) {
    const candidates: string[] = [];
    if (typeof req.blockedPath === "string") candidates.push(req.blockedPath);
    const filePath = req.input.file_path;
    if (typeof filePath === "string") candidates.push(filePath);

    // Check additional path-like fields in req.input (avoid content/body fields that may contain false positives)
    const pathFields = [
      "path",
      "directory",
      "folder",
      "cwd",
      "dest",
      "destination",
      "source",
      "target",
    ];
    for (const field of pathFields) {
      const val = req.input[field];
      if (typeof val === "string") candidates.push(val);
    }
    // Also check command field for embedded POSIX home paths.
    const command = req.input.command;
    if (typeof command === "string") {
      const embeddedPath = extractPosixHomePath(command);
      if (embeddedPath) candidates.push(embeddedPath);
    }

    const badPath = candidates.find((p) => isPosixHomePath(p));
    if (!badPath) continue;
    warnings.push(
      `Permission request '${req.requestId}' uses POSIX home path '${badPath}' on Windows. Prefer an absolute Windows path${cwdHint} to avoid out-of-bounds permission prompts.`
    );
  }
  return warnings;
}

function computeToolValidation(
  session: SessionInfo | undefined,
  initTools: string[] | undefined
): { summary?: CheckResult["toolValidation"]; warnings: string[] } {
  if (!session) return { summary: undefined, warnings: [] };
  const allowedTools = uniqSorted(session.allowedTools);
  const disallowedTools = uniqSorted(session.disallowedTools);
  const warnings: string[] = [];
  if (allowedTools.length > 0 && session.strictAllowedTools !== true) {
    warnings.push(
      "allowedTools currently acts as pre-approval only. Set strictAllowedTools=true to enforce a strict allowlist."
    );
  }
  if (allowedTools.length === 0 && disallowedTools.length === 0) {
    return { summary: undefined, warnings };
  }

  if (!Array.isArray(initTools) || initTools.length === 0) {
    return {
      summary: {
        runtimeToolsKnown: false,
        unknownAllowedTools: [],
        unknownDisallowedTools: [],
      },
      warnings: [
        ...warnings,
        "Runtime tool list is not available yet; unknown allowedTools/disallowedTools names cannot be validated until system/init tools arrive.",
      ],
    };
  }

  const runtime = new Set(
    initTools
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const unknownAllowedTools = allowedTools.filter((name) => !runtime.has(name));
  const unknownDisallowedTools = disallowedTools.filter((name) => !runtime.has(name));
  if (unknownAllowedTools.length > 0) {
    warnings.push(
      `Unknown allowedTools (not present in runtime tools): ${unknownAllowedTools.join(", ")}.`
    );
  }
  if (unknownDisallowedTools.length > 0) {
    warnings.push(
      `Unknown disallowedTools (not present in runtime tools): ${unknownDisallowedTools.join(", ")}.`
    );
  }
  return {
    summary: {
      runtimeToolsKnown: true,
      unknownAllowedTools,
      unknownDisallowedTools,
    },
    warnings,
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function capEventsByBytes<T>(events: T[], maxBytes?: number): { events: T[]; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || typeof maxBytes !== "number" || maxBytes <= 0) {
    return { events, truncated: false };
  }
  const budget = Math.floor(maxBytes);
  const kept: T[] = [];
  let bytes = 2; // "[]"
  for (const evt of events) {
    const evtBytes = byteLength(evt);
    const separatorBytes = kept.length === 0 ? 0 : 1; // ","
    if (bytes + separatorBytes + evtBytes > budget) break;
    kept.push(evt);
    bytes += separatorBytes + evtBytes;
  }
  return { events: kept, truncated: kept.length < events.length };
}

function buildResult(
  sessionManager: SessionManager,
  toolCache: ToolDiscoveryCache | undefined,
  input: ClaudeCodeCheckInput
): CheckResult {
  const responseMode: CheckResponseMode = input.responseMode ?? "minimal";
  const compactMode = responseMode === "delta_compact";
  const po = input.pollOptions ?? {};
  const includeTools = po.includeTools;
  const includeEvents = po.includeEvents ?? !compactMode;
  const includeActions = po.includeActions ?? true;
  const includeResult = po.includeResult ?? !compactMode;
  const includeUsage = po.includeUsage ?? responseMode === "full";
  const includeModelUsage = po.includeModelUsage ?? responseMode === "full";
  const includeStructuredOutput = po.includeStructuredOutput ?? responseMode === "full";
  const includeTerminalEvents = po.includeTerminalEvents ?? responseMode === "full";
  const includeProgressEvents = po.includeProgressEvents ?? responseMode === "full";
  const maxBytes = po.maxBytes;
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
  let nextCursor =
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

    let filtered = windowEvents;

    // Avoid duplicating terminal result/error both in events and top-level result.
    if (!includeTerminalEvents && includeResult && (status === "idle" || status === "error")) {
      filtered = filtered.filter((e) => e.type !== "result" && e.type !== "error");
    }

    // In minimal mode, filter out noisy progress events (tool_progress, auth_status).
    if (!includeProgressEvents) {
      filtered = filtered.filter((e) => {
        if (e.type !== "progress") return true;
        const d = e.data as Record<string, unknown> | null;
        const progressType = d?.type;
        return progressType !== "tool_progress" && progressType !== "auth_status";
      });
    }

    return filtered;
  })();

  const pending =
    status === "waiting_permission" ? sessionManager.listPendingPermissions(sessionId) : [];
  const stored =
    status === "idle" || status === "error" ? sessionManager.getResult(sessionId) : undefined;

  const initTools = sessionManager.getInitTools(sessionId);
  const availableTools = includeTools && initTools ? discoverToolsFromInit(initTools) : undefined;
  const toolValidation = computeToolValidation(session, initTools);
  const compatWarnings = Array.from(
    new Set([
      ...toolValidation.warnings,
      ...detectPathCompatibilityWarnings(session),
      ...detectPendingPermissionPathWarnings(pending, session),
    ])
  );

  const shapedEvents = toEvents(outputEvents, {
    includeUsage,
    includeModelUsage,
    includeStructuredOutput,
    slim: responseMode === "minimal" || responseMode === "delta_compact",
  });
  const cappedEvents = capEventsByBytes(shapedEvents, maxBytes);
  if (cappedEvents.truncated) {
    truncated = true;
    truncatedFields.push("events_bytes");
    nextCursor =
      cappedEvents.events.length > 0
        ? cappedEvents.events[cappedEvents.events.length - 1].id + 1
        : (cursorResetTo ?? input.cursor ?? 0);
  }

  return {
    sessionId,
    status,
    pollInterval: pollIntervalForStatus(status),
    cursorResetTo,
    truncated: truncated ? true : undefined,
    truncatedFields: truncatedFields.length > 0 ? truncatedFields : undefined,
    events: cappedEvents.events,
    nextCursor,
    availableTools,
    toolValidation: toolValidation.summary,
    compatWarnings: compatWarnings.length > 0 ? compatWarnings : undefined,
    actions:
      includeActions && status === "waiting_permission"
        ? pending.map((req) => {
            const expiresMs = req.expiresAt ? Date.parse(req.expiresAt) : Number.NaN;
            const remainingMs = Number.isFinite(expiresMs)
              ? Math.max(0, expiresMs - Date.now())
              : undefined;
            return {
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
              timeoutMs: req.timeoutMs,
              expiresAt: req.expiresAt,
              remainingMs,
            };
          })
        : undefined,
    result:
      includeResult && stored?.result
        ? redactAgentResult(stored.result, {
            includeUsage,
            includeModelUsage,
            includeStructuredOutput,
            slim: responseMode === "minimal" || responseMode === "delta_compact",
          })
        : undefined,
    cancelledAt: session?.cancelledAt,
    cancelledReason: session?.cancelledReason,
    cancelledSource: session?.cancelledSource,
    lastEventId: responseMode === "full" ? sessionManager.getLastEventId(sessionId) : undefined,
    lastToolUseId: responseMode === "full" ? session?.lastToolUseId : undefined,
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
  opts: {
    includeUsage: boolean;
    includeModelUsage: boolean;
    includeStructuredOutput: boolean;
    slim?: boolean;
  }
): AgentResult {
  const {
    usage,
    modelUsage,
    structuredOutput,
    durationApiMs,
    sessionTotalTurns,
    sessionTotalCostUsd,
    ...rest
  } = result;

  return {
    ...rest,
    durationApiMs: opts.slim ? undefined : durationApiMs,
    sessionTotalTurns: opts.slim ? undefined : sessionTotalTurns,
    sessionTotalCostUsd: opts.slim ? undefined : sessionTotalCostUsd,
    usage: opts.includeUsage ? usage : undefined,
    modelUsage: opts.includeModelUsage ? modelUsage : undefined,
    structuredOutput: opts.includeStructuredOutput ? structuredOutput : undefined,
  };
}

export function executeClaudeCodeCheck(
  input: ClaudeCodeCheckInput,
  sessionManager: SessionManager,
  toolCache?: ToolDiscoveryCache,
  requestSignal?: AbortSignal
): ClaudeCodeCheckResult {
  if (requestSignal?.aborted) {
    return {
      sessionId: input.sessionId ?? "",
      error: `Error [${ErrorCode.CANCELLED}]: request was cancelled.`,
      isError: true,
    };
  }

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
  if (
    input.decision !== "allow" &&
    input.decision !== "deny" &&
    input.decision !== "allow_for_session"
  ) {
    return {
      sessionId: input.sessionId,
      error: `Error [${ErrorCode.INVALID_ARGUMENT}]: decision must be 'allow', 'deny', or 'allow_for_session'.`,
      isError: true,
    };
  }

  const pendingRequest =
    input.decision === "allow_for_session"
      ? sessionManager.getPendingPermission(input.sessionId, input.requestId)
      : undefined;
  const updatedPermissions =
    input.decision === "allow_for_session"
      ? appendAllowForSessionUpdate(
          input.permissionOptions?.updatedPermissions,
          pendingRequest?.toolName
        )
      : input.permissionOptions?.updatedPermissions;

  const ok = sessionManager.finishRequest(
    input.sessionId,
    input.requestId,
    toPermissionResult({
      decision: input.decision,
      updatedInput: input.permissionOptions?.updatedInput,
      updatedPermissions,
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

  if (input.decision === "allow_for_session" && pendingRequest?.toolName) {
    sessionManager.allowToolForSession(input.sessionId, pendingRequest.toolName);
  }

  return buildResult(sessionManager, toolCache, input);
}
