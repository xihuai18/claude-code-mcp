/**
 * MCP Server definition - registers tools and handles requests
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./session/manager.js";
import { executeClaudeCode } from "./tools/claude-code.js";
import { executeClaudeCodeReply } from "./tools/claude-code-reply.js";
import { executeClaudeCodeSession } from "./tools/claude-code-session.js";
import { executeClaudeCodeConfigure } from "./tools/claude-code-configure.js";
import {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  AGENT_MODELS,
  CONFIGURE_ACTIONS,
  SESSION_ACTIONS,
  ErrorCode,
} from "./types.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

export interface ServerOptions {
  /** Allow bypassPermissions mode (default: false, can be enabled via claude_code_configure tool) */
  allowBypass?: boolean;
}

export function createServer(serverCwd: string, opts?: ServerOptions): McpServer {
  const parsePositiveInt = (value: string | undefined): number | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  };

  const sessionManager = new SessionManager({
    sessionTtlMs: parsePositiveInt(process.env.CLAUDE_CODE_MCP_SESSION_TTL_MS),
    runningSessionMaxMs: parsePositiveInt(process.env.CLAUDE_CODE_MCP_RUNNING_SESSION_MAX_MS),
    cleanupIntervalMs: parsePositiveInt(process.env.CLAUDE_CODE_MCP_CLEANUP_INTERVAL_MS),
  });
  let allowBypass = opts?.allowBypass ?? false;

  const config = {
    getAllowBypass: () => allowBypass,
    setAllowBypass: (v: boolean) => {
      allowBypass = v;
    },
  };

  const server = new McpServer({
    name: "claude-code-mcp",
    version: SERVER_VERSION,
  });

  // Tool 1: claude_code - Start a new agent session
  server.tool(
    "claude_code",
    `Start a new Claude Code session. The agent autonomously performs coding tasks: reading/writing files, running shell commands, searching code, managing git, and interacting with APIs.
Returns a sessionId that can be passed to claude_code_reply for multi-turn conversations.
Defaults: permissionMode="dontAsk" (auto-approves allowed tools without prompting), loads all local Claude settings (user, project, local) including CLAUDE.md.`,
    {
      prompt: z.string().describe("The task or question for Claude Code"),
      cwd: z.string().optional().describe("Working directory (defaults to server cwd)"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "List of tool names the agent can use without permission prompts. In the default 'dontAsk' mode, only tools in this list are available. Example: ['Bash', 'Read', 'Write', 'Edit']"
        ),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "List of tool names the agent is forbidden from using. Takes precedence over allowedTools."
        ),
      tools: z
        .union([
          z.array(z.string()),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
          }),
        ])
        .optional()
        .describe(
          "Define the base tool set for the session. Pass an array of tool name strings, or use {type: 'preset', preset: 'claude_code'} for the default Claude Code toolset. allowedTools/disallowedTools further filter on top of this base set."
        ),
      persistSession: z
        .boolean()
        .optional()
        .describe(
          "Persist session history to disk (~/.claude/projects). Default: true. Set false to disable persistence."
        ),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(
          "Controls how the agent handles tool permissions. 'dontAsk' (default): auto-approve tools in allowedTools without prompting. 'bypassPermissions': skip all permission checks (requires enable_bypass via claude_code_configure). 'plan': require approval before executing."
        ),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum number of agent reasoning steps. Each step may involve one or more tool calls. Limits how many iterations the agent performs before stopping."
        ),
      model: z.string().optional().describe("Model to use, e.g. 'claude-sonnet-4-5-20250929'"),
      systemPrompt: z
        .union([
          z.string(),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
            append: z
              .string()
              .optional()
              .describe("Additional instructions to append to the preset"),
          }),
        ])
        .optional()
        .describe(
          "Override the agent's system prompt. Pass a string for full replacement, or use {type: 'preset', preset: 'claude_code', append: '...'} to extend the default Claude Code prompt with additional instructions."
        ),
      agents: z
        .record(
          z.string(),
          z.object({
            description: z.string(),
            prompt: z.string(),
            tools: z.array(z.string()).optional(),
            disallowedTools: z.array(z.string()).optional(),
            model: z.enum(AGENT_MODELS).optional(),
            maxTurns: z.number().int().positive().optional(),
            mcpServers: z
              .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
              .optional(),
            skills: z.array(z.string()).optional(),
            criticalSystemReminder_EXPERIMENTAL: z.string().optional(),
          })
        )
        .optional()
        .describe(
          "Define custom sub-agents that the main agent can delegate tasks to. Each key is the agent name; the value specifies its system prompt, available tools, model, and other constraints."
        ),
      maxBudgetUsd: z
        .number()
        .positive()
        .optional()
        .describe("Maximum budget in USD for this session"),
      effort: z
        .enum(EFFORT_LEVELS)
        .optional()
        .describe(
          "Effort level: 'low' (fast), 'medium' (balanced), 'high' (thorough), 'max' (maximum)"
        ),
      betas: z
        .array(z.string())
        .optional()
        .describe("Beta features to enable (e.g. ['context-1m-2025-08-07'])"),
      additionalDirectories: z
        .array(z.string())
        .optional()
        .describe("Additional directories the agent can access beyond cwd"),
      outputFormat: z
        .object({
          type: z.literal("json_schema"),
          schema: z.record(z.string(), z.unknown()).describe("JSON Schema for structured output"),
        })
        .optional()
        .describe("Structured output format with JSON Schema (omit for plain text output)"),
      thinking: z
        .union([
          z.object({ type: z.literal("adaptive") }),
          z.object({
            type: z.literal("enabled"),
            budgetTokens: z.number().int().positive().describe("Token budget for thinking"),
          }),
          z.object({ type: z.literal("disabled") }),
        ])
        .optional()
        .describe("Thinking mode: 'adaptive' (auto), 'enabled' (with budget), or 'disabled'"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds for this session"),
      pathToClaudeCodeExecutable: z
        .string()
        .optional()
        .describe("Path to the Claude Code executable"),
      agent: z
        .string()
        .optional()
        .describe(
          "Name of a custom agent (defined in 'agents' parameter) to use as the primary agent for this session, applying its system prompt, tool restrictions, and model override."
        ),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("MCP server configurations (key: server name, value: server config)"),
      sandbox: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Sandbox configuration for isolating shell command execution (e.g., Docker container settings). Controls the execution environment for Bash tool calls."
        ),
      fallbackModel: z
        .string()
        .optional()
        .describe("Fallback model if the primary model fails or is unavailable"),
      enableFileCheckpointing: z
        .boolean()
        .optional()
        .describe("Enable file checkpointing to track file changes during the session"),
      includePartialMessages: z
        .boolean()
        .optional()
        .describe(
          "When true, includes intermediate streaming messages in the response (e.g., partial tool outputs as they arrive). Useful for real-time progress monitoring. Default: false."
        ),
      strictMcpConfig: z
        .boolean()
        .optional()
        .describe("Enforce strict validation of MCP server configurations"),
      settingSources: z
        .array(z.enum(["user", "project", "local"]))
        .optional()
        .describe(
          'Control which filesystem settings are loaded. Defaults to ["user", "project", "local"] (loads all settings including ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json, and CLAUDE.md). Pass an empty array [] to disable all settings (SDK isolation mode).'
        ),
      debug: z.boolean().optional().describe("Enable debug mode for verbose logging"),
      debugFile: z
        .string()
        .optional()
        .describe("Write debug logs to a specific file path (implicitly enables debug mode)"),
      env: z
        .record(z.string(), z.string().optional())
        .optional()
        .describe(
          "Environment variables to merge with process.env and pass to the Claude Code process (user-provided values take precedence)"
        ),
    },
    async (args) => {
      try {
        const result = await executeClaudeCode(args, sessionManager, serverCwd, allowBypass);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.isError,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${ErrorCode.INTERNAL}]: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 2: claude_code_reply - Continue an existing session
  server.tool(
    "claude_code_reply",
    `Continue an existing Claude Code session by sending a follow-up message. The agent retains full context from previous turns including files read, code analysis, and conversation history. Requires a sessionId returned by a previous claude_code call.
Note: When CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1 is set and the in-memory session has expired, the agent can resume from disk-persisted history. Parameters marked "(disk resume fallback)" are only used in this scenario to reconstruct the session.`,
    {
      sessionId: z
        .string()
        .describe("The session ID to continue (from a previous claude_code call)"),
      prompt: z.string().describe("Follow-up prompt or instruction"),
      forkSession: z
        .boolean()
        .optional()
        .describe(
          "Create a branched copy of this session. The original session remains unchanged; the new session starts with the same context but diverges from this point. Useful for exploring alternative approaches."
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds for this reply"),

      // Optional disk-resume overrides (only used when CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1
      // and the in-memory session metadata is missing)
      cwd: z.string().optional().describe("Working directory (disk resume fallback)"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Auto-approved tool names (disk resume fallback). See claude_code tool for details."
        ),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe("Forbidden tool names (disk resume fallback). See claude_code tool for details."),
      tools: z
        .union([
          z.array(z.string()),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
          }),
        ])
        .optional()
        .describe("Base tool set (disk resume fallback). See claude_code tool for details."),
      persistSession: z
        .boolean()
        .optional()
        .describe("Persist session history to disk (~/.claude/projects). Default: true."),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe("Permission mode (disk resume fallback). See claude_code tool for details."),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of agent reasoning steps for this reply."),
      model: z.string().optional().describe("Model to use, e.g. 'claude-sonnet-4-5-20250929'"),
      systemPrompt: z
        .union([
          z.string(),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
            append: z
              .string()
              .optional()
              .describe("Additional instructions to append to the preset"),
          }),
        ])
        .optional()
        .describe("Override the agent's system prompt. See claude_code tool for details."),
      agents: z
        .record(
          z.string(),
          z.object({
            description: z.string(),
            prompt: z.string(),
            tools: z.array(z.string()).optional(),
            disallowedTools: z.array(z.string()).optional(),
            model: z.enum(AGENT_MODELS).optional(),
            maxTurns: z.number().int().positive().optional(),
            mcpServers: z
              .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
              .optional(),
            skills: z.array(z.string()).optional(),
            criticalSystemReminder_EXPERIMENTAL: z.string().optional(),
          })
        )
        .optional()
        .describe("Define custom sub-agents. See claude_code tool for details."),
      maxBudgetUsd: z
        .number()
        .positive()
        .optional()
        .describe("Maximum budget in USD for this reply"),
      effort: z
        .enum(EFFORT_LEVELS)
        .optional()
        .describe(
          "Effort level: 'low' (fast), 'medium' (balanced), 'high' (thorough), 'max' (maximum)"
        ),
      betas: z.array(z.string()).optional().describe("Beta features to enable"),
      additionalDirectories: z
        .array(z.string())
        .optional()
        .describe("Additional directories the agent can access beyond cwd"),
      outputFormat: z
        .object({
          type: z.literal("json_schema"),
          schema: z.record(z.string(), z.unknown()).describe("JSON Schema for structured output"),
        })
        .optional()
        .describe("Structured output format with JSON Schema (omit for plain text output)"),
      thinking: z
        .union([
          z.object({ type: z.literal("adaptive") }),
          z.object({
            type: z.literal("enabled"),
            budgetTokens: z.number().int().positive().describe("Token budget for thinking"),
          }),
          z.object({ type: z.literal("disabled") }),
        ])
        .optional()
        .describe("Thinking mode: 'adaptive' (auto), 'enabled' (with budget), or 'disabled'"),
      resumeSessionAt: z
        .string()
        .optional()
        .describe(
          "Resume only up to and including a specific message UUID (disk resume fallback only)"
        ),
      pathToClaudeCodeExecutable: z
        .string()
        .optional()
        .describe("Path to the Claude Code executable"),
      agent: z
        .string()
        .optional()
        .describe(
          "Name of a custom agent (defined in 'agents') to use as the primary agent. See claude_code tool for details."
        ),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("MCP server configurations (key: server name, value: server config)"),
      sandbox: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Sandbox configuration for isolating shell command execution. See claude_code tool for details."
        ),
      fallbackModel: z
        .string()
        .optional()
        .describe("Fallback model if the primary model fails or is unavailable"),
      enableFileCheckpointing: z
        .boolean()
        .optional()
        .describe("Enable file checkpointing to track file changes during the session"),
      includePartialMessages: z
        .boolean()
        .optional()
        .describe(
          "When true, includes intermediate streaming messages in the response (e.g., partial tool outputs as they arrive). Useful for real-time progress monitoring. Default: false."
        ),
      strictMcpConfig: z
        .boolean()
        .optional()
        .describe("Enforce strict validation of MCP server configurations"),
      settingSources: z
        .array(z.enum(["user", "project", "local"]))
        .optional()
        .describe(
          'Control which filesystem settings are loaded. Defaults to ["user", "project", "local"] (loads all settings including ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json, and CLAUDE.md). Pass an empty array [] to disable all settings (SDK isolation mode).'
        ),
      debug: z.boolean().optional().describe("Enable debug mode for verbose logging"),
      debugFile: z
        .string()
        .optional()
        .describe("Write debug logs to a specific file path (implicitly enables debug mode)"),
      env: z
        .record(z.string(), z.string().optional())
        .optional()
        .describe(
          "Environment variables to merge with process.env and pass to the Claude Code process (user-provided values take precedence)"
        ),
    },
    async (args) => {
      try {
        const result = await executeClaudeCodeReply(args, sessionManager, allowBypass);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: result.isError,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${ErrorCode.INTERNAL}]: ${message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Tool 3: claude_code_session - Manage sessions
  server.tool(
    "claude_code_session",
    `Manage Claude Code sessions. Actions: 'list' returns all sessions with status and metadata; 'get' returns detailed info for a specific session (requires sessionId); 'cancel' terminates a running session (requires sessionId).`,
    {
      action: z.enum(SESSION_ACTIONS).describe("Action to perform: 'list', 'get', or 'cancel'"),
      sessionId: z.string().optional().describe("Session ID (required for 'get' and 'cancel')"),
      includeSensitive: z
        .boolean()
        .optional()
        .describe(
          "When true, includes sensitive fields (cwd, systemPrompt, agents, additionalDirectories) in the response. Requires CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS=1 env var. Default: false."
        ),
    },
    async (args) => {
      const allowSensitive = process.env.CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS === "1";
      if (args.includeSensitive && !allowSensitive) {
        const result = {
          sessions: [],
          message: `Error [${ErrorCode.PERMISSION_DENIED}]: includeSensitive is disabled. Set CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS=1 to enable.`,
          isError: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: true,
        };
      }
      const result = executeClaudeCodeSession(args, sessionManager);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: result.isError ?? false,
      };
    }
  );

  // Tool 4: claude_code_configure - Runtime configuration
  server.tool(
    "claude_code_configure",
    `Configure the Claude Code MCP server at runtime.
Actions: 'enable_bypass' allows sessions to use permissionMode='bypassPermissions' (skips all tool permission checks — use with caution); 'disable_bypass' revokes this ability; 'get_config' returns the current server configuration.`,
    {
      action: z
        .enum(CONFIGURE_ACTIONS)
        .describe(
          "Action to perform: 'enable_bypass' | 'disable_bypass' | 'get_config'. See tool description for details."
        ),
    },
    async (args) => {
      const result = executeClaudeCodeConfigure(args, config);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: result.isError ?? false,
      };
    }
  );

  // Cleanup on server close
  const originalClose = server.close.bind(server);
  server.close = async () => {
    sessionManager.destroy();
    await originalClose();
  };

  return server;
}
