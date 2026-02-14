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
      append: z.string().optional().describe("Appended to preset prompt"),
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
      budgetTokens: z.number().int().positive(),
    }),
    z.object({ type: z.literal("disabled") }),
  ]);

  const outputFormatSchema = z.object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()),
  });

  /** Advanced options shared by claude_code (and reused in diskResumeConfig). */
  const advancedOptionsSchema = z
    .object({
      tools: toolsConfigSchema.optional().describe("Visible tool set. Default: SDK"),
      persistSession: z.boolean().optional().describe("Default: true"),
      sessionInitTimeoutMs: z.number().int().positive().optional().describe("Default: 10000"),
      agents: z
        .record(z.string(), agentDefinitionSchema)
        .optional()
        .describe("Sub-agent definitions. Default: none"),
      agent: z.string().optional().describe("Primary agent name (from 'agents'). Default: none"),
      maxBudgetUsd: z.number().positive().optional().describe("Default: none"),
      effort: z.enum(EFFORT_LEVELS).optional().describe("Default: SDK"),
      betas: z.array(z.string()).optional().describe("Default: none"),
      additionalDirectories: z.array(z.string()).optional().describe("Default: none"),
      outputFormat: outputFormatSchema.optional().describe("Default: none (plain text)"),
      thinking: thinkingSchema.optional().describe("Default: SDK"),
      pathToClaudeCodeExecutable: z.string().optional().describe("Default: SDK-bundled"),
      mcpServers: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe("Default: none"),
      sandbox: z.record(z.string(), z.unknown()).optional().describe("Default: none"),
      fallbackModel: z.string().optional().describe("Default: none"),
      enableFileCheckpointing: z.boolean().optional().describe("Default: false"),
      includePartialMessages: z
        .boolean()
        .optional()
        .describe("Stream events to claude_code_check. Default: false"),
      strictMcpConfig: z.boolean().optional().describe("Default: false"),
      settingSources: z
        .array(z.enum(["user", "project", "local"]))
        .optional()
        .describe("Default: ['user','project','local']. [] = isolation mode"),
      debug: z.boolean().optional().describe("Default: false"),
      debugFile: z.string().optional().describe("Enables debug. Default: none"),
      env: z
        .record(z.string(), z.string().optional())
        .optional()
        .describe("Merged with process.env. Default: none"),
    })
    .optional()
    .describe("Low-frequency SDK options (all optional)");

  // Tool 1: claude_code - Start a new agent session
  server.tool(
    "claude_code",
    buildInternalToolsDescription(toolCache.getTools()),
    {
      prompt: z.string().describe("Task or question"),
      cwd: z.string().optional().describe("Working directory. Default: server cwd"),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Auto-approved tools, e.g. ['Bash','Read','Write','Edit']. Default: []"),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe("Forbidden tools (priority over allowedTools). Default: []"),
      maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
      model: z.string().optional().describe("e.g. 'opus'. Default: SDK"),
      systemPrompt: systemPromptSchema.optional().describe("Default: SDK"),
      permissionRequestTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Auto-deny timeout (ms). Default: 60000"),
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
      sessionId: z.string().describe("Session ID from claude_code"),
      prompt: z.string().describe("Follow-up message"),
      forkSession: z.boolean().optional().describe("Branch into new session copy. Default: false"),
      sessionInitTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Fork init timeout (ms). Default: 10000"),
      permissionRequestTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Auto-deny timeout (ms). Default: 60000"),
      diskResumeConfig: z
        .object({
          resumeToken: z.string().optional().describe("Required"),
          cwd: z.string().optional().describe("Required"),
          allowedTools: z.array(z.string()).optional().describe("Default: []"),
          disallowedTools: z.array(z.string()).optional().describe("Default: []"),
          tools: toolsConfigSchema.optional().describe("Default: SDK"),
          persistSession: z.boolean().optional().describe("Default: true"),
          maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
          model: z.string().optional().describe("Default: SDK"),
          systemPrompt: systemPromptSchema.optional().describe("Default: SDK"),
          agents: z.record(z.string(), agentDefinitionSchema).optional().describe("Default: none"),
          agent: z.string().optional().describe("Default: none"),
          maxBudgetUsd: z.number().positive().optional().describe("Default: none"),
          effort: z.enum(EFFORT_LEVELS).optional().describe("Default: SDK"),
          betas: z.array(z.string()).optional().describe("Default: none"),
          additionalDirectories: z.array(z.string()).optional().describe("Default: none"),
          outputFormat: outputFormatSchema.optional().describe("Default: none"),
          thinking: thinkingSchema.optional().describe("Default: SDK"),
          resumeSessionAt: z
            .string()
            .optional()
            .describe("Resume to specific message UUID. Default: none"),
          pathToClaudeCodeExecutable: z.string().optional().describe("Default: SDK-bundled"),
          mcpServers: z
            .record(z.string(), z.record(z.string(), z.unknown()))
            .optional()
            .describe("Default: none"),
          sandbox: z.record(z.string(), z.unknown()).optional().describe("Default: none"),
          fallbackModel: z.string().optional().describe("Default: none"),
          enableFileCheckpointing: z.boolean().optional().describe("Default: false"),
          includePartialMessages: z
            .boolean()
            .optional()
            .describe("Stream events to claude_code_check. Default: false"),
          strictMcpConfig: z.boolean().optional().describe("Default: false"),
          settingSources: z
            .array(z.enum(["user", "project", "local"]))
            .optional()
            .describe("Default: ['user','project','local']. [] = isolation mode"),
          debug: z.boolean().optional().describe("Default: false"),
          debugFile: z.string().optional().describe("Enables debug. Default: none"),
          env: z.record(z.string(), z.string().optional()).optional().describe("Default: none"),
        })
        .optional()
        .describe(
          "Disk resume config (needs CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1). Requires resumeToken + cwd."
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
      action: z.enum(SESSION_ACTIONS),
      sessionId: z.string().optional().describe("Required for 'get' and 'cancel'"),
      includeSensitive: z
        .boolean()
        .optional()
        .describe("Include cwd/systemPrompt/agents/additionalDirectories. Default: false"),
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
      action: z.enum(CHECK_ACTIONS),
      sessionId: z.string().describe("Target session ID"),
      cursor: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Event offset for incremental poll. Default: 0"),
      responseMode: z.enum(CHECK_RESPONSE_MODES).optional().describe("Default: 'minimal'"),
      maxEvents: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Events per poll. Default: 200 (minimal)"),

      requestId: z.string().optional().describe("Permission request ID (from actions[])"),
      decision: z.enum(["allow", "deny"]).optional().describe("For respond_permission"),
      denyMessage: z
        .string()
        .optional()
        .describe("Reason shown to agent on deny. Default: 'Permission denied by caller'"),
      interrupt: z.boolean().optional().describe("Stop session on deny. Default: false"),

      pollOptions: z
        .object({
          includeTools: z.boolean().optional().describe("Default: false"),
          includeEvents: z.boolean().optional().describe("Default: true"),
          includeActions: z.boolean().optional().describe("Default: true"),
          includeResult: z.boolean().optional().describe("Default: true"),
          includeUsage: z.boolean().optional().describe("Default: full=true, minimal=false"),
          includeModelUsage: z.boolean().optional().describe("Default: full=true, minimal=false"),
          includeStructuredOutput: z
            .boolean()
            .optional()
            .describe("Default: full=true, minimal=false"),
          includeTerminalEvents: z
            .boolean()
            .optional()
            .describe("Default: full=true, minimal=false"),
          includeProgressEvents: z
            .boolean()
            .optional()
            .describe("Default: full=true, minimal=false"),
        })
        .optional()
        .describe("Override responseMode defaults"),

      permissionOptions: z
        .object({
          updatedInput: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Replace tool input on allow. Default: none"),
          updatedPermissions: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe("Update permission rules on allow. Default: none"),
        })
        .optional()
        .describe("Allow-only: modify tool input or update rules"),
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
