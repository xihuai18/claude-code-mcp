/**
 * claude_code_session tool - Manage sessions (list, get, cancel)
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

export function executeClaudeCodeSession(
  input: ClaudeCodeSessionInput,
  sessionManager: SessionManager
): SessionResult {
  const toSessionJson = (s: SessionInfo) =>
    input.includeSensitive ? sessionManager.toSensitiveJSON(s) : sessionManager.toPublicJSON(s);

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
      const cancelled = sessionManager.cancel(input.sessionId);
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

    default:
      return {
        sessions: [],
        message: `Error [${ErrorCode.INVALID_ARGUMENT}]: Unknown action '${input.action}'. Use 'list', 'get', or 'cancel'.`,
        isError: true,
      };
  }
}
