/**
 * Type definitions for claude-code-mcp
 *
 * Shared constants are defined as tuples so both Zod schemas and
 * TypeScript types can derive from the same source of truth.
 */

import type {
  PermissionResult as SDKPermissionResult,
  PermissionUpdate as SDKPermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

/** Permission modes supported by Claude Agent SDK */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "delegate", "dontAsk"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Effort levels */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Subagent model options */
export const AGENT_MODELS = ["sonnet", "opus", "haiku", "inherit"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** Session management actions */
export const SESSION_ACTIONS = ["list", "get", "cancel"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** Session status */
export type SessionStatus = "idle" | "running" | "waiting_permission" | "cancelled" | "error";

export type SystemPrompt = string | { type: "preset"; preset: "claude_code"; append?: string };

export type OutputFormat = { type: "json_schema"; schema: Record<string, unknown> };

export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

export type ToolsConfig = string[] | { type: "preset"; preset: "claude_code" };

/** Subagent definition (mirrors the Zod schema in server.ts) */
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: AgentModel;
  maxTurns?: number;
  mcpServers?: (string | Record<string, unknown>)[];
  skills?: string[];
  criticalSystemReminder_EXPERIMENTAL?: string;
}

/** MCP server configuration for the SDK */
export type McpServerConfig = Record<string, unknown>;

/** Sandbox configuration for isolating shell command execution */
export type SandboxSettings = Record<string, unknown>;

/** Setting source for controlling which filesystem settings are loaded */
export type SettingSource = "user" | "project" | "local";

/** Default setting sources — load all filesystem settings for ease of use */
export const DEFAULT_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];

/** Session metadata stored by the session manager */
export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  cancelledSource?: string;
  totalTurns: number;
  totalCostUsd: number;
  cwd: string;
  model?: string;
  pathToClaudeCodeExecutable?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  maxTurns?: number;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  persistSession?: boolean;
  /** Primary agent name (from 'agents' definitions) */
  agent?: string;
  /** MCP server configurations (key: server name, value: server config) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Sandbox configuration for isolating shell command execution */
  sandbox?: SandboxSettings;
  /** Fallback model if the primary model fails or is unavailable */
  fallbackModel?: string;
  /** Enable file checkpointing to track file changes */
  enableFileCheckpointing?: boolean;
  /** When true, includes intermediate streaming messages in the response */
  includePartialMessages?: boolean;
  /** Enforce strict validation of MCP server configurations */
  strictMcpConfig?: boolean;
  /** Control which filesystem settings are loaded */
  settingSources?: SettingSource[];
  /** Enable debug mode */
  debug?: boolean;
  /** Write debug logs to a specific file path */
  debugFile?: string;
  /** Environment variables passed to the Claude Code process */
  env?: Record<string, string | undefined>;
  /** Last seen tool use id (best-effort) */
  lastToolUseId?: string;
  abortController?: AbortController;
}

/** Session metadata safe to return by default (redacts paths and prompts) */
export interface PublicSessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
  cancelledSource?: string;
  totalTurns: number;
  totalCostUsd: number;
  model?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  persistSession?: boolean;
  agent?: string;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  includePartialMessages?: boolean;
  strictMcpConfig?: boolean;
  debug?: boolean;
  lastToolUseId?: string;
}

/** Session metadata returned when includeSensitive=true (still excludes secrets like env) */
export interface SensitiveSessionInfo extends PublicSessionInfo {
  cwd: string;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  additionalDirectories?: string[];
}

/** Result returned from a claude_code or claude_code_reply call */
export interface AgentResult {
  sessionId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  durationApiMs?: number;
  numTurns: number;
  totalCostUsd: number;
  sessionTotalTurns?: number;
  sessionTotalCostUsd?: number;
  structuredOutput?: unknown;
  stopReason?: string | null;
  errorSubtype?: string;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permissionDenials?: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }>;
}

export const CHECK_ACTIONS = ["poll", "respond_permission"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];

export const CHECK_RESPONSE_MODES = ["minimal", "full"] as const;
export type CheckResponseMode = (typeof CHECK_RESPONSE_MODES)[number];

export type PermissionDecision = "allow" | "deny";

/**
 * Permission updates suggested by the SDK (shape is SDK-defined and may evolve).
 * We treat it as opaque JSON and forward it to callers.
 */
export type PermissionUpdate = SDKPermissionUpdate;
export type PermissionResult = SDKPermissionResult;

export interface ToolInfo {
  name: string;
  description: string;
  category?: string;
}

export type SessionEventType =
  | "output"
  | "progress"
  | "permission_request"
  | "permission_result"
  | "result"
  | "error";

export interface SessionEvent {
  id: number;
  type: SessionEventType;
  data: unknown;
  timestamp: string;
  pinned: boolean;
}

export interface EventBuffer {
  events: SessionEvent[];
  maxSize: number;
  hardMaxSize: number;
  nextId: number;
}

export interface PermissionRequestRecord {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID: string;
  agentID?: string;
  suggestions?: PermissionUpdate[];
  description?: string;
  createdAt: string;
}

export type FinishFn = (result: PermissionResult) => void;

export type FinishSource = "respond" | "timeout" | "cancel" | "cleanup" | "destroy" | "signal";

export interface SessionStartResult {
  sessionId: string;
  status: "running";
  pollInterval: number;
  resumeToken?: string;
}

export type StoredAgentResult =
  | { type: "result"; result: AgentResult; createdAt: string }
  | { type: "error"; result: AgentResult; createdAt: string };

export interface CheckResult {
  sessionId: string;
  status: SessionStatus;
  pollInterval?: number;
  cursorResetTo?: number;
  truncated?: boolean;
  truncatedFields?: string[];
  events: Array<{
    id: number;
    type: SessionEventType;
    data: unknown;
    timestamp: string;
  }>;
  nextCursor?: number;
  availableTools?: ToolInfo[];
  actions?: Array<{
    type: "permission";
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    summary: string;
    decisionReason?: string;
    blockedPath?: string;
    toolUseID: string;
    agentID?: string;
    suggestions?: PermissionUpdate[];
    description?: string;
    createdAt: string;
  }>;
  result?: AgentResult;
  cancelledAt?: string;
  cancelledReason?: string;
  cancelledSource?: string;
  lastEventId?: number;
  lastToolUseId?: string;
}

/** Error codes for structured error responses */
export enum ErrorCode {
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_BUSY = "SESSION_BUSY",
  PERMISSION_REQUEST_NOT_FOUND = "PERMISSION_REQUEST_NOT_FOUND",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  INTERNAL = "INTERNAL",
}
