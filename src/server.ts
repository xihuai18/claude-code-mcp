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
    `Start a new Claude Code agent session to perform coding tasks autonomously.
The agent can read/write files, run commands, search code, and more.
Returns a sessionId for continuing the conversation later.
Permission mode defaults to "dontAsk" (non-interactive, safe for MCP).
By default, loads all local Claude settings (user, project, local) including CLAUDE.md for project context.`,
    {
      prompt: z.string().describe("The task or question for Claude Code"),
      cwd: z.string().optional().describe("Working directory (defaults to server cwd)"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Tools to auto-approve without prompting. In permissionMode='dontAsk', this effectively acts as a tool whitelist."
        ),
      disallowedTools: z.array(z.string()).optional().describe("Tool blacklist"),
      tools: z
        .union([
          z.array(z.string()),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
          }),
        ])
        .optional()
        .describe("Base set of available tools (array of names, or preset)"),
      persistSession: z
        .boolean()
        .optional()
        .describe(
          "Persist session history to disk (~/.claude/projects). Default: true. Set false to disable persistence."
        ),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe("Permission mode for the session"),
      maxTurns: z.number().int().positive().optional().describe("Maximum agentic turns"),
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
        .describe("Custom system prompt (string or preset with optional append)"),
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
        .describe("Custom subagent definitions"),
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
          "Main-thread agent name to apply custom agent system prompt, tool restrictions, and model"
        ),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("MCP server configurations (key: server name, value: server config)"),
      sandbox: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Sandbox settings for command execution isolation"),
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
        .describe("Include partial/streaming message events in output"),
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
    `Continue an existing Claude Code session with full context preserved.
	Claude remembers all files read, analysis done, and conversation history.`,
    {
      sessionId: z
        .string()
        .describe("The session ID to continue (from a previous claude_code call)"),
      prompt: z.string().describe("Follow-up prompt or instruction"),
      forkSession: z
        .boolean()
        .optional()
        .describe("Fork to a new session (preserves original session state)"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in milliseconds for this reply"),

      // Optional disk-resume overrides (only used when CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1
      // and the in-memory session metadata is missing)
      cwd: z
        .string()
        .optional()
        .describe("Working directory (used only for disk resume when session is missing)"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Auto-approved tools (used only for disk resume when session is missing)"),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe("Tool blacklist (used only for disk resume when session is missing)"),
      tools: z
        .union([
          z.array(z.string()),
          z.object({
            type: z.literal("preset"),
            preset: z.literal("claude_code"),
          }),
        ])
        .optional()
        .describe("Base set of available tools (array of names, or preset)"),
      persistSession: z
        .boolean()
        .optional()
        .describe("Persist session history to disk (~/.claude/projects). Default: true."),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe("Permission mode (used only for disk resume when session is missing)"),
      maxTurns: z.number().int().positive().optional().describe("Maximum agentic turns"),
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
        .describe("Custom system prompt (string or preset with optional append)"),
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
        .describe("Custom subagent definitions"),
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
        .describe("Resume only up to and including a specific message UUID (disk resume only)"),
      pathToClaudeCodeExecutable: z
        .string()
        .optional()
        .describe("Path to the Claude Code executable"),
      agent: z
        .string()
        .optional()
        .describe(
          "Main-thread agent name to apply custom agent system prompt, tool restrictions, and model"
        ),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("MCP server configurations (key: server name, value: server config)"),
      sandbox: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Sandbox settings for command execution isolation"),
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
        .describe("Include partial/streaming message events in output"),
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
    `Manage Claude Code sessions: list all sessions, get status of a specific session, or cancel a running session.`,
    {
      action: z.enum(SESSION_ACTIONS).describe("Action to perform: 'list', 'get', or 'cancel'"),
      sessionId: z.string().optional().describe("Session ID (required for 'get' and 'cancel')"),
      includeSensitive: z
        .boolean()
        .optional()
        .describe(
          "Include sensitive fields (cwd, systemPrompt, agents, additionalDirectories) in responses. Default: false"
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
Actions: enable_bypass (allow bypassPermissions mode), disable_bypass, get_config.`,
    {
      action: z.enum(CONFIGURE_ACTIONS).describe("Configuration action to perform"),
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
