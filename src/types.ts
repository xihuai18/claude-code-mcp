/**
 * Type definitions for claude-code-mcp
 *
 * Shared constants are defined as tuples so both Zod schemas and
 * TypeScript types can derive from the same source of truth.
 */

/** Permission modes supported by Claude Agent SDK */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "delegate",
  "dontAsk",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Effort levels */
export const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Subagent model options */
export const AGENT_MODELS = ["sonnet", "opus", "haiku", "inherit"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** Configure tool actions */
export const CONFIGURE_ACTIONS = ["enable_bypass", "disable_bypass", "get_config"] as const;
export type ConfigureAction = (typeof CONFIGURE_ACTIONS)[number];

/** Session management actions */
export const SESSION_ACTIONS = ["list", "get", "cancel"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** Session status */
export type SessionStatus = "idle" | "running" | "cancelled" | "error";

export type SystemPrompt = string | { type: "preset"; preset: "claude_code"; append?: string };

export type OutputFormat = { type: "json_schema"; schema: Record<string, unknown> };

export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "disabled" };

export type ToolsConfig = string[] | { type: "preset"; preset: "claude_code" };

/** Subagent definition */
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

/** Sandbox settings for command execution isolation */
export type SandboxSettings = Record<string, unknown>;

/** Setting source for controlling which filesystem settings are loaded */
export type SettingSource = "user" | "project" | "local";

/** Session metadata stored by the session manager */
export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
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
  /** Main-thread agent name */
  agent?: string;
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
  /** Sandbox settings for command execution isolation */
  sandbox?: SandboxSettings;
  /** Fallback model if the primary model fails */
  fallbackModel?: string;
  /** Enable file checkpointing to track file changes */
  enableFileCheckpointing?: boolean;
  /** Include partial/streaming message events */
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
  abortController?: AbortController;
}

/** Session metadata safe to return by default (redacts paths and prompts) */
export interface PublicSessionInfo {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
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

/** Error codes for structured error responses */
export enum ErrorCode {
  INVALID_ARGUMENT = "INVALID_ARGUMENT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_BUSY = "SESSION_BUSY",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
  INTERNAL = "INTERNAL",
}
