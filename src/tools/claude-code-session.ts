/**
 * claude_code_session tool - Manage sessions (list, get, cancel, interrupt)
 */
import type { SessionManager } from "../session/manager.js";
import type {
  PublicSessionInfo,
  SensitiveSessionInfo,
  SessionInfo,
  SessionAction,
} from "../types.js";
import { ErrorCode } from "../types.js";

export interface ClaudeCodeSessionInput {
  action: SessionAction;
  sessionId?: string;
  includeSensitive?: boolean;
}

export interface SessionResult {
  sessions: Array<PublicSessionInfo | SensitiveSessionInfo>;
  message?: string;
  isError?: boolean;
}

const ALWAYS_REDACTED_FIELDS = [
  "env",
  "mcpServers",
  "sandbox",
  "debugFile",
  "pathToClaudeCodeExecutable",
] as const;

const CONDITIONAL_REDACTED_FIELDS = [
  "cwd",
  "systemPrompt",
  "agents",
  "additionalDirectories",
] as const;

function buildRedactions(includeSensitive?: boolean): PublicSessionInfo["redactions"] {
  const redactions: PublicSessionInfo["redactions"] = [];
  for (const field of ALWAYS_REDACTED_FIELDS) {
    redactions?.push({ field, reason: "secret_or_internal" });
  }
  if (!includeSensitive) {
    for (const field of CONDITIONAL_REDACTED_FIELDS) {
      redactions?.push({ field, reason: "sensitive_by_default" });
    }
  }
  return redactions;
}

export function executeClaudeCodeSession(
  input: ClaudeCodeSessionInput,
  sessionManager: SessionManager,
  requestSignal?: AbortSignal
): SessionResult {
  if (requestSignal?.aborted) {
    return {
      sessions: [],
      message: `Error [${ErrorCode.CANCELLED}]: request was cancelled.`,
      isError: true,
    };
  }

  const toSessionJson = (s: SessionInfo): PublicSessionInfo | SensitiveSessionInfo => {
    const base = input.includeSensitive
      ? sessionManager.toSensitiveJSON(s)
      : sessionManager.toPublicJSON(s);
    const stored = sessionManager.getResult(s.sessionId);
    const lastError = stored?.type === "error" ? stored.result.result : undefined;
    const lastErrorAt = stored?.type === "error" ? stored.createdAt : undefined;
    return {
      ...base,
      pendingPermissionCount: sessionManager.getPendingPermissionCount(s.sessionId),
      eventCount: sessionManager.getEventCount(s.sessionId),
      currentCursor: sessionManager.getCurrentCursor(s.sessionId),
      lastEventId: sessionManager.getLastEventId(s.sessionId),
      ttlMs: sessionManager.getRemainingTtlMs(s.sessionId),
      lastError,
      lastErrorAt,
      redactions: buildRedactions(input.includeSensitive),
    };
  };

  switch (input.action) {
    case "list": {
      const sessions = sessionManager.list().map((s) => toSessionJson(s));
      return { sessions };
    }

    case "get": {
      if (!input.sessionId) {
        return {
          sessions: [],
          message: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId is required for 'get' action.`,
          isError: true,
        };
      }
      const session = sessionManager.get(input.sessionId);
      if (!session) {
        return {
          sessions: [],
          message: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found.`,
          isError: true,
        };
      }
      return { sessions: [toSessionJson(session)] };
    }

    case "cancel": {
      if (!input.sessionId) {
        return {
          sessions: [],
          message: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId is required for 'cancel' action.`,
          isError: true,
        };
      }
      const cancelled = sessionManager.cancel(input.sessionId, {
        reason: "Cancelled by caller",
        source: "claude_code_session",
      });
      if (!cancelled) {
        const session = sessionManager.get(input.sessionId);
        if (!session) {
          return {
            sessions: [],
            message: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found.`,
            isError: true,
          };
        }
        return {
          sessions: [toSessionJson(session)],
          message: `Error [${ErrorCode.INVALID_ARGUMENT}]: Session '${input.sessionId}' is not running (status: ${session.status}).`,
          isError: true,
        };
      }
      const updated = sessionManager.get(input.sessionId);
      return {
        sessions: updated ? [toSessionJson(updated)] : [],
        message: `Session '${input.sessionId}' cancelled.`,
      };
    }

    case "interrupt": {
      if (!input.sessionId) {
        return {
          sessions: [],
          message: `Error [${ErrorCode.INVALID_ARGUMENT}]: sessionId is required for 'interrupt' action.`,
          isError: true,
        };
      }
      const interrupted = sessionManager.interrupt(input.sessionId, {
        reason: "Interrupted by caller",
        source: "claude_code_session",
      });
      if (!interrupted) {
        const session = sessionManager.get(input.sessionId);
        if (!session) {
          return {
            sessions: [],
            message: `Error [${ErrorCode.SESSION_NOT_FOUND}]: Session '${input.sessionId}' not found.`,
            isError: true,
          };
        }
        return {
          sessions: [toSessionJson(session)],
          message: `Error [${ErrorCode.INVALID_ARGUMENT}]: Session '${input.sessionId}' is not running (status: ${session.status}).`,
          isError: true,
        };
      }
      const updated = sessionManager.get(input.sessionId);
      return {
        sessions: updated ? [toSessionJson(updated)] : [],
        message: `Session '${input.sessionId}' interrupted.`,
      };
    }

    default:
      return {
        sessions: [],
        message: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${input.action}'. Use 'list', 'get', 'cancel', or 'interrupt'.`,
        isError: true,
      };
  }
}
