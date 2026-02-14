/**
 * MCP Server definition - registers tools and handles requests
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./session/manager.js";
import { executeClaudeCode } from "./tools/claude-code.js";
import { executeClaudeCodeReply } from "./tools/claude-code-reply.js";
import { executeClaudeCodeCheck } from "./tools/claude-code-check.js";
import { executeClaudeCodeSession } from "./tools/claude-code-session.js";
import { buildInternalToolsDescription, ToolDiscoveryCache } from "./tools/tool-discovery.js";
import {
  EFFORT_LEVELS,
  AGENT_MODELS,
  CHECK_ACTIONS,
  CHECK_RESPONSE_MODES,
  SESSION_ACTIONS,
  ErrorCode,
} from "./types.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

export function createServer(serverCwd: string): McpServer {
  const sessionManager = new SessionManager();
  const toolCache = new ToolDiscoveryCache();

  const server = new McpServer({
    name: "claude-code-mcp",
    version: SERVER_VERSION,
  });

  // ── Shared Zod fragments ──────────────────────────────────────────────
  const agentDefinitionSchema = z.object({
    description: z.string(),
    prompt: z.string(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    model: z.enum(AGENT_MODELS).optional(),
    maxTurns: z.number().int().positive().optional(),
    mcpServers: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    skills: z.array(z.string()).optional(),
    criticalSystemReminder_EXPERIMENTAL: z.string().optional(),
  });

  const systemPromptSchema = z.union([
    z.string(),
    z.object({
      type: z.literal("preset"),
      preset: z.literal("claude_code"),
      append: z.string().optional().describe("Additional instructions to append to the preset"),
    }),
  ]);

  const toolsConfigSchema = z.union([
    z.array(z.string()),
    z.object({
      type: z.literal("preset"),
      preset: z.literal("claude_code"),
    }),
  ]);

  const thinkingSchema = z.union([
    z.object({ type: z.literal("adaptive") }),
    z.object({
      type: z.literal("enabled"),
      budgetTokens: z.number().int().positive().describe("Token budget for thinking"),
    }),
    z.object({ type: z.literal("disabled") }),
  ]);

  const outputFormatSchema = z.object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()).describe("JSON Schema for structured output"),
  });

  /** Advanced options shared by claude_code (and reused in diskResumeConfig). */
  const advancedOptionsSchema = z
    .object({
      tools: toolsConfigSchema
        .optional()
        .describe(
          "Define the base tool set visible to the agent. Default: omitted (SDK/Claude Code default). Pass an array of tool names, or {type: 'preset', preset: 'claude_code'} for the default set."
        ),
      persistSession: z
        .boolean()
        .optional()
        .describe("Persist session history to disk (~/.claude/projects). Default: true."),
      sessionInitTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to wait (in ms) for the agent process to initialize. Default: 10000."),
      agents: z
        .record(z.string(), agentDefinitionSchema)
        .optional()
        .describe(
          "Define custom sub-agents the main agent can delegate tasks to. Each key is the agent name."
        ),
      agent: z
        .string()
        .optional()
        .describe("Name of a custom agent (defined in 'agents') to use as the primary agent."),
      maxBudgetUsd: z
        .number()
        .positive()
        .optional()
        .describe("Maximum budget in USD for this session."),
      effort: z
        .enum(EFFORT_LEVELS)
        .optional()
        .describe("Effort level: 'low' | 'medium' | 'high' | 'max'."),
      betas: z.array(z.string()).optional().describe("Beta features to enable."),
      additionalDirectories: z
        .array(z.string())
        .optional()
        .describe("Additional directories the agent can access beyond cwd."),
      outputFormat: outputFormatSchema
        .optional()
        .describe("Structured output format with JSON Schema."),
      thinking: thinkingSchema
        .optional()
        .describe("Thinking mode: 'adaptive' | 'enabled' (with budget) | 'disabled'."),
      pathToClaudeCodeExecutable: z
        .string()
        .optional()
        .describe("Path to the Claude Code executable. Default: SDK-bundled."),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("MCP server configurations (key: server name, value: server config)."),
      sandbox: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Sandbox configuration for isolating shell command execution."),
      fallbackModel: z
        .string()
        .optional()
        .describe("Fallback model if the primary model fails or is unavailable."),
      enableFileCheckpointing: z
        .boolean()
        .optional()
        .describe("Enable file checkpointing to track file changes. Default: false."),
      includePartialMessages: z
        .boolean()
        .optional()
        .describe("Include intermediate messages as events in claude_code_check. Default: false."),
      strictMcpConfig: z
        .boolean()
        .optional()
        .describe("Enforce strict validation of MCP server configurations. Default: false."),
      settingSources: z
        .array(z.enum(["user", "project", "local"]))
        .optional()
        .describe(
          "Which local config files to load. Default: ['user', 'project', 'local']. Pass [] to disable all."
        ),
      debug: z.boolean().optional().describe("Enable debug mode. Default: false."),
      debugFile: z
        .string()
        .optional()
        .describe("Write debug logs to a file path (implicitly enables debug mode)."),
      env: z
        .record(z.string(), z.string().optional())
        .optional()
        .describe("Environment variables to merge with process.env."),
    })
    .optional()
    .describe(
      "Low-frequency SDK options. All fields are optional with sensible defaults. Most callers can omit this entirely."
    );

  // Tool 1: claude_code - Start a new agent session
  server.tool(
    "claude_code",
    buildInternalToolsDescription(toolCache.getTools()),
    {
      prompt: z.string().describe("The task or question for Claude Code"),
      cwd: z.string().optional().describe("Working directory. Default: server cwd."),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Tools the agent can use without asking for permission. Default: [] (no auto-approvals). Example: ['Bash', 'Read', 'Write', 'Edit']. Tools not listed here or in disallowedTools will trigger a permission request via claude_code_check."
        ),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe(
          "Tools the agent is forbidden from using. Default: [] (none). Takes priority over allowedTools."
        ),
      maxTurns: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of reasoning steps the agent can take."),
      model: z.string().optional().describe("Model to use, e.g. 'claude-sonnet-4-5-20250929'."),
      systemPrompt: systemPromptSchema
        .optional()
        .describe(
          "Override the agent's system prompt. Pass a string for full replacement, or use {type: 'preset', preset: 'claude_code', append: '...'} to extend the default."
        ),
      permissionRequestTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How long to wait (in ms) for a permission decision via claude_code_check before auto-denying. Default: 60000."
        ),
      advanced: advancedOptionsSchema,
    },
    async (args, extra) => {
      try {
        const result = await executeClaudeCode(
          args,
          sessionManager,
          serverCwd,
          toolCache,
          extra.signal
        );
        const isError = typeof (result as { error?: unknown }).error === "string";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError,
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
    `Send a follow-up message to an existing Claude Code session.

The agent retains full context from previous turns (files read, code analyzed, conversation history). Returns immediately — use claude_code_check to poll for the result.

Supports session forking (forkSession=true) to explore alternative approaches without modifying the original session.

Defaults:
- forkSession: false
- sessionInitTimeoutMs: 10000 (only used when forkSession=true)
- permissionRequestTimeoutMs: 60000
- Disk resume: disabled unless CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1

Disk resume: If the server restarted and the session is no longer in memory, set CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1 to let the agent resume from its on-disk transcript. Pass diskResumeConfig with resumeToken and session parameters.`,
    {
      sessionId: z
        .string()
        .describe("The session ID to continue (from a previous claude_code call)"),
      prompt: z.string().describe("Follow-up prompt or instruction"),
      forkSession: z
        .boolean()
        .optional()
        .describe(
          "Branch this session into a new copy that diverges from the current point. The original session remains unchanged. Default: false."
        ),
      sessionInitTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How long to wait (in ms) for a forked session to initialize. Default: 10000."),
      permissionRequestTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How long to wait (in ms) for a permission decision via claude_code_check before auto-denying. Default: 60000."
        ),
      diskResumeConfig: z
        .object({
          resumeToken: z
            .string()
            .optional()
            .describe(
              "Resume token returned by claude_code / claude_code_reply. Required for disk resume."
            ),
          cwd: z.string().optional().describe("Working directory. Required for disk resume."),
          allowedTools: z
            .array(z.string())
            .optional()
            .describe("Tools the agent can use without permission."),
          disallowedTools: z
            .array(z.string())
            .optional()
            .describe("Tools the agent is forbidden from using."),
          tools: toolsConfigSchema.optional().describe("Which tools the agent can see."),
          persistSession: z
            .boolean()
            .optional()
            .describe("Persist session history to disk. Default: true."),
          maxTurns: z.number().int().positive().optional().describe("Maximum reasoning steps."),
          model: z.string().optional().describe("Model to use."),
          systemPrompt: systemPromptSchema
            .optional()
            .describe("Override the agent's system prompt."),
          agents: z
            .record(z.string(), agentDefinitionSchema)
            .optional()
            .describe("Define custom sub-agents."),
          agent: z.string().optional().describe("Name of a custom agent to use as primary."),
          maxBudgetUsd: z.number().positive().optional().describe("Maximum budget in USD."),
          effort: z.enum(EFFORT_LEVELS).optional().describe("Effort level."),
          betas: z.array(z.string()).optional().describe("Beta features to enable."),
          additionalDirectories: z
            .array(z.string())
            .optional()
            .describe("Additional accessible directories."),
          outputFormat: outputFormatSchema.optional().describe("Structured output format."),
          thinking: thinkingSchema.optional().describe("Thinking mode configuration."),
          resumeSessionAt: z
            .string()
            .optional()
            .describe("Resume only up to a specific message UUID."),
          pathToClaudeCodeExecutable: z
            .string()
            .optional()
            .describe("Path to the Claude Code executable."),
          mcpServers: z
            .record(z.string(), z.record(z.string(), z.unknown()))
            .optional()
            .describe("MCP server configurations."),
          sandbox: z.record(z.string(), z.unknown()).optional().describe("Sandbox configuration."),
          fallbackModel: z.string().optional().describe("Fallback model."),
          enableFileCheckpointing: z
            .boolean()
            .optional()
            .describe("Enable file checkpointing. Default: false."),
          includePartialMessages: z
            .boolean()
            .optional()
            .describe("Include intermediate messages as events. Default: false."),
          strictMcpConfig: z
            .boolean()
            .optional()
            .describe("Enforce strict MCP validation. Default: false."),
          settingSources: z
            .array(z.enum(["user", "project", "local"]))
            .optional()
            .describe("Which local config files to load."),
          debug: z.boolean().optional().describe("Enable debug mode. Default: false."),
          debugFile: z.string().optional().describe("Write debug logs to a file path."),
          env: z
            .record(z.string(), z.string().optional())
            .optional()
            .describe("Environment variables to merge with process.env."),
        })
        .optional()
        .describe(
          "Disk resume fallback configuration. Only needed when CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1 and the in-memory session is missing. Contains resumeToken + all session config overrides."
        ),
    },
    async (args, extra) => {
      try {
        const result = await executeClaudeCodeReply(args, sessionManager, toolCache, extra.signal);
        const isError = typeof (result as { error?: unknown }).error === "string";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError,
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
    `List, inspect, or cancel Claude Code sessions.

- action="list": Get all sessions with their status, cost, turn count, and settings.
- action="get": Get full details for one session (pass sessionId). Add includeSensitive=true to also see cwd, systemPrompt, agents, and additionalDirectories.
- action="cancel": Stop a running session immediately (pass sessionId).`,
    {
      action: z.enum(SESSION_ACTIONS).describe("Action to perform: 'list', 'get', or 'cancel'"),
      sessionId: z.string().optional().describe("Session ID (required for 'get' and 'cancel')"),
      includeSensitive: z
        .boolean()
        .optional()
        .describe(
          "When true, includes sensitive fields (cwd, systemPrompt, agents, additionalDirectories) in the response. Default: false."
        ),
    },
    async (args) => {
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

  // Tool 4: claude_code_check - Poll events + respond to permission requests
  server.tool(
    "claude_code_check",
    `Query a running session for new events, retrieve the final result, or respond to permission requests.

Two actions:

Defaults (poll):
- responseMode: "minimal"
- minimal mode strips verbose fields from assistant messages (usage, model, id, cache_control) and filters out noisy progress events (tool_progress, auth_status)
- maxEvents: 200 in minimal mode (unlimited in full mode unless maxEvents is set)

action="poll" — Retrieve events since the last poll.
  Returns events (agent output, progress updates, permission requests, errors, final result).
  Pass the cursor from the previous poll's nextCursor for incremental updates. Omit cursor to get all buffered events.
  If the agent is waiting for permission, the response includes an "actions" array with pending requests.

action="respond_permission" — Approve or deny a pending permission request.
  Pass the requestId from the actions array, plus decision="allow" or decision="deny".
  Approving resumes agent execution. Denying (with optional interrupt=true) can halt the entire session.
  The response also includes the latest poll state (events, status, etc.), so a separate poll call is not needed.`,
    {
      action: z.enum(CHECK_ACTIONS).describe('Action to perform: "poll" or "respond_permission"'),
      sessionId: z.string().describe("Session ID to check"),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Event cursor for incremental polling. Pass nextCursor from the previous poll response."
        ),
      responseMode: z
        .enum(CHECK_RESPONSE_MODES)
        .optional()
        .describe("Response shaping preset. 'minimal' reduces payload size. Default: 'minimal'."),
      maxEvents: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Max number of events to return per poll (pagination via nextCursor). Default: 200 in minimal mode."
        ),

      requestId: z
        .string()
        .optional()
        .describe(
          "The permission request ID to respond to (from the actions array). Required for respond_permission."
        ),
      decision: z
        .enum(["allow", "deny"])
        .optional()
        .describe(
          "Whether to approve or reject the permission request. Required for respond_permission."
        ),
      denyMessage: z
        .string()
        .optional()
        .describe(
          "Reason for denying, shown to the agent. Only used with decision='deny'. Default: 'Permission denied by caller'."
        ),
      interrupt: z
        .boolean()
        .optional()
        .describe(
          "When true with decision='deny', stops the entire agent session. Default: false."
        ),

      pollOptions: z
        .object({
          includeTools: z
            .boolean()
            .optional()
            .describe("Include availableTools array from session init. Default: false."),
          includeEvents: z
            .boolean()
            .optional()
            .describe(
              "When false, omits the events array (nextCursor still advances). Default: true."
            ),
          includeActions: z
            .boolean()
            .optional()
            .describe("When false, omits actions[] even if waiting_permission. Default: true."),
          includeResult: z
            .boolean()
            .optional()
            .describe("When false, omits the top-level result when idle/error. Default: true."),
          includeUsage: z
            .boolean()
            .optional()
            .describe("Include AgentResult.usage. Default: true in full mode, false in minimal."),
          includeModelUsage: z
            .boolean()
            .optional()
            .describe(
              "Include AgentResult.modelUsage. Default: true in full mode, false in minimal."
            ),
          includeStructuredOutput: z
            .boolean()
            .optional()
            .describe(
              "Include AgentResult.structuredOutput. Default: true in full mode, false in minimal."
            ),
          includeTerminalEvents: z
            .boolean()
            .optional()
            .describe(
              "Include terminal result/error events in events stream. Default: true in full, false in minimal."
            ),
          includeProgressEvents: z
            .boolean()
            .optional()
            .describe(
              "Include progress events (tool_progress, auth_status). Default: true in full, false in minimal."
            ),
        })
        .optional()
        .describe(
          "Fine-grained poll control. Overrides responseMode defaults for individual fields. Most callers can omit this."
        ),

      permissionOptions: z
        .object({
          updatedInput: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Modified tool input to use instead of the original. Only with decision='allow'."
            ),
          updatedPermissions: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Permission rule updates to apply. Only with decision='allow'."),
        })
        .optional()
        .describe(
          "Advanced permission response options. Only used with respond_permission + decision='allow'."
        ),
    },
    async (args) => {
      const result = executeClaudeCodeCheck(args, sessionManager, toolCache);
      const isError = (result as { isError?: boolean }).isError === true;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError,
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
