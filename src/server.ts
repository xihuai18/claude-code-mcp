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
import { registerResources } from "./resources/register-resources.js";
import {
  EFFORT_LEVELS,
  AGENT_MODELS,
  CHECK_ACTIONS,
  CHECK_RESPONSE_MODES,
  SESSION_ACTIONS,
  ErrorCode as LocalErrorCode,
} from "./types.js";

declare const __PKG_VERSION__: string;
const SERVER_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0-dev";

export function createServerContext(serverCwd: string): {
  server: McpServer;
  sessionManager: SessionManager;
  toolCache: ToolDiscoveryCache;
} {
  const sessionManager = new SessionManager();

  const server = new McpServer(
    {
      name: "claude-code-mcp",
      version: SERVER_VERSION,
      title: "Claude Code MCP",
      description:
        "MCP server that runs Claude Code via the Claude Agent SDK with async polling and interactive permissions.",
      websiteUrl: "https://github.com/xihuai18/claude-code-mcp",
      icons: [],
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
    }
  );

  // Dynamic tool catalog cache + dynamic claude_code tool description updates.
  // `server.tool(...)` returns a RegisteredTool with an `update()` method.
  const claudeCodeToolRef: {
    current?: { update: (updates: { description?: string }) => void };
  } = {};
  const notifyInternalToolsResourceChanged = () => {
    if (!server.isConnected()) return;
    // Prefer the stable high-level API to avoid coupling to internal SDK fields.
    // This notifies clients to refresh resources when the runtime tool catalog changes.
    server.sendResourceListChanged();
  };

  const toolCache = new ToolDiscoveryCache(undefined, (tools) => {
    try {
      claudeCodeToolRef.current?.update({ description: buildInternalToolsDescription(tools) });
      if (server.isConnected()) {
        server.sendToolListChanged();
      }
      notifyInternalToolsResourceChanged();
    } catch {
      // ignore update errors
    }
  });

  // ── Shared Zod fragments ──────────────────────────────────────────────
  const agentDefinitionSchema = z.object({
    description: z.string(),
    prompt: z.string(),
    tools: z.array(z.string()).optional().describe("Default: inherit"),
    disallowedTools: z.array(z.string()).optional().describe("Default: none"),
    model: z.enum(AGENT_MODELS).optional().describe("Default: inherit"),
    maxTurns: z.number().int().positive().optional().describe("Default: none"),
    mcpServers: z
      .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
      .optional()
      .describe("Default: inherit"),
    skills: z.array(z.string()).optional().describe("Default: none"),
    criticalSystemReminder_EXPERIMENTAL: z.string().optional().describe("Default: none"),
  });

  const systemPromptSchema = z.union([
    z.string(),
    z.object({
      type: z.literal("preset"),
      preset: z.literal("claude_code"),
      append: z.string().optional().describe("Default: none"),
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

  const effortOptionSchema = z.enum(EFFORT_LEVELS).optional();
  const thinkingOptionSchema = thinkingSchema.optional();

  const outputFormatSchema = z.object({
    type: z.literal("json_schema"),
    schema: z.record(z.string(), z.unknown()),
  });

  const sharedOptionFieldsSchemaShape = {
    tools: toolsConfigSchema.optional().describe("Tool set. Default: SDK"),
    persistSession: z.boolean().optional().describe("Default: true"),
    agents: z.record(z.string(), agentDefinitionSchema).optional().describe("Default: none"),
    agent: z.string().optional().describe("Default: none"),
    maxBudgetUsd: z.number().positive().optional().describe("Default: none"),
    betas: z.array(z.string()).optional().describe("Default: none"),
    additionalDirectories: z.array(z.string()).optional().describe("Default: none"),
    outputFormat: outputFormatSchema.optional().describe("Default: none"),
    pathToClaudeCodeExecutable: z.string().optional().describe("Default: SDK-bundled"),
    mcpServers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe("Default: none"),
    sandbox: z.record(z.string(), z.unknown()).optional().describe("Default: none"),
    fallbackModel: z.string().optional().describe("Default: none"),
    enableFileCheckpointing: z.boolean().optional().describe("Default: false"),
    includePartialMessages: z.boolean().optional().describe("Default: false"),
    promptSuggestions: z.boolean().optional().describe("Default: false"),
    strictMcpConfig: z.boolean().optional().describe("Default: false"),
    settingSources: z
      .array(z.enum(["user", "project", "local"]))
      .optional()
      .describe("Default: ['user','project','local']. []=isolation"),
    debug: z.boolean().optional().describe("Default: false"),
    debugFile: z.string().optional().describe("Default: none"),
    env: z.record(z.string(), z.string().optional()).optional().describe("Default: none"),
  } as const;

  const advancedOptionFieldsSchemaShape = {
    ...sharedOptionFieldsSchemaShape,
  } as const;

  const diskResumeOptionFieldsSchemaShape = {
    ...sharedOptionFieldsSchemaShape,
    effort: effortOptionSchema.describe("Default: SDK"),
    thinking: thinkingOptionSchema.describe("Default: SDK"),
  } as const;

  /** Advanced options shared by claude_code (and reused in diskResumeConfig). */
  const advancedOptionsSchema = z
    .object({
      ...advancedOptionFieldsSchemaShape,
      sessionInitTimeoutMs: z.number().int().positive().optional().describe("Default: 10000"),
    })
    .optional()
    .describe("Default: none");

  const diskResumeConfigSchema = z
    .object({
      resumeToken: z.string(),
      cwd: z.string(),
      allowedTools: z.array(z.string()).optional().describe("Default: []"),
      disallowedTools: z.array(z.string()).optional().describe("Default: []"),
      strictAllowedTools: z.boolean().optional().describe("Default: false"),
      maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
      model: z.string().optional().describe("Default: SDK"),
      systemPrompt: systemPromptSchema.optional().describe("Default: SDK"),
      resumeSessionAt: z.string().optional().describe("Default: none"),
      ...diskResumeOptionFieldsSchemaShape,
    })
    .optional()
    .describe("Default: none");

  const startResultSchema = z
    .object({
      sessionId: z.string(),
      status: z.enum(["running", "error"]),
      pollInterval: z.number().optional(),
      resumeToken: z.string().optional(),
      compatWarnings: z.array(z.string()).optional(),
      error: z.string().optional(),
    })
    .passthrough();

  const sessionResultSchema = z
    .object({
      sessions: z.array(z.record(z.string(), z.unknown())),
      message: z.string().optional(),
      isError: z.boolean().optional(),
    })
    .passthrough();

  const checkEventSchema = z
    .object({
      id: z.number().int().nonnegative(),
      type: z.string(),
      data: z.unknown(),
      timestamp: z.string(),
    })
    .passthrough();

  const checkActionSchema = z
    .object({
      type: z.string(),
      requestId: z.string().optional(),
      toolName: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      summary: z.string().optional(),
    })
    .passthrough();

  const checkResultSchema = z
    .object({
      sessionId: z.string(),
      status: z.string(),
      pollInterval: z.number().optional(),
      cursorResetTo: z.number().optional(),
      truncated: z.boolean().optional(),
      truncatedFields: z.array(z.string()).optional(),
      events: z.array(checkEventSchema),
      nextCursor: z.number().optional(),
      availableTools: z.array(z.record(z.string(), z.unknown())).optional(),
      toolValidation: z
        .object({
          runtimeToolsKnown: z.boolean(),
          unknownAllowedTools: z.array(z.string()),
          unknownDisallowedTools: z.array(z.string()),
        })
        .optional(),
      compatWarnings: z.array(z.string()).optional(),
      actions: z.array(checkActionSchema).optional(),
      result: z.unknown().optional(),
      cancelledAt: z.string().optional(),
      cancelledReason: z.string().optional(),
      cancelledSource: z.string().optional(),
      lastEventId: z.number().optional(),
      lastToolUseId: z.string().optional(),
      isError: z.boolean().optional(),
      error: z.string().optional(),
    })
    .passthrough();

  // Tool 1: claude_code - Start a new agent session
  claudeCodeToolRef.current = server.registerTool(
    "claude_code",
    {
      description: buildInternalToolsDescription(toolCache.getTools()),
      inputSchema: {
        prompt: z.string().describe("Prompt"),
        cwd: z.string().optional().describe("Working dir. Default: server cwd"),
        allowedTools: z.array(z.string()).optional().describe("Default: []"),
        disallowedTools: z.array(z.string()).optional().describe("Default: []"),
        strictAllowedTools: z.boolean().optional().describe("Default: false"),
        maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
        model: z.string().optional().describe("Default: SDK"),
        effort: effortOptionSchema.describe("Default: SDK"),
        thinking: thinkingOptionSchema.describe("Default: SDK"),
        systemPrompt: systemPromptSchema.optional().describe("Default: SDK"),
        permissionRequestTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Default: 60000, clamped to 300000"),
        advanced: advancedOptionsSchema,
      },
      outputSchema: startResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
          structuredContent: result as unknown as Record<string, unknown>,
          isError,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errorResult = {
          sessionId: "",
          status: "error" as const,
          error: `Error [${LocalErrorCode.INTERNAL}]: ${message}`,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(errorResult, null, 2),
            },
          ],
          structuredContent: errorResult as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );

  // Tool 2: claude_code_reply - Continue an existing session
  server.registerTool(
    "claude_code_reply",
    {
      description:
        "Send a follow-up to an existing session. Returns immediately; use claude_code_check to poll.",
      inputSchema: {
        sessionId: z.string().describe("Session ID"),
        prompt: z.string().describe("Prompt"),
        forkSession: z.boolean().optional().describe("Default: false"),
        effort: effortOptionSchema.describe("Default: SDK"),
        thinking: thinkingOptionSchema.describe("Default: SDK"),
        sessionInitTimeoutMs: z.number().int().positive().optional().describe("Default: 10000"),
        permissionRequestTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Default: 60000, clamped to 300000"),
        diskResumeConfig: diskResumeConfigSchema,
      },
      outputSchema: startResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
          structuredContent: result as unknown as Record<string, unknown>,
          isError,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errorResult = {
          sessionId: "",
          status: "error" as const,
          error: `Error [${LocalErrorCode.INTERNAL}]: ${message}`,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(errorResult, null, 2),
            },
          ],
          structuredContent: errorResult as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );

  // Tool 3: claude_code_session - Manage sessions
  server.registerTool(
    "claude_code_session",
    {
      description: "List, inspect, cancel, or interrupt sessions.",
      inputSchema: {
        action: z.enum(SESSION_ACTIONS),
        sessionId: z.string().optional().describe("Required for get/cancel/interrupt"),
        includeSensitive: z.boolean().optional().describe("Default: false"),
      },
      outputSchema: sessionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const result = executeClaudeCodeSession(args, sessionManager, extra.signal);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: result.isError ?? false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errorResult = {
          sessions: [],
          message: `Error [${LocalErrorCode.INTERNAL}]: ${message}`,
          isError: true,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(errorResult, null, 2),
            },
          ],
          structuredContent: errorResult as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );

  // Tool 4: claude_code_check - Poll events + respond to permission requests
  server.registerTool(
    "claude_code_check",
    {
      description: "Poll session events or respond to permission requests.",
      inputSchema: {
        action: z.enum(CHECK_ACTIONS),
        sessionId: z.string().describe("Session ID"),
        cursor: z.number().int().nonnegative().optional().describe("Default: 0"),
        responseMode: z
          .enum(CHECK_RESPONSE_MODES)
          .optional()
          .describe("Default: 'minimal'. Use 'delta_compact' for lightweight polling."),
        maxEvents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Default: 200 (minimal), unlimited (full/delta_compact)"),

        requestId: z.string().optional().describe("Default: none"),
        decision: z
          .enum(["allow", "deny", "allow_for_session"])
          .optional()
          .describe("Default: none"),
        denyMessage: z.string().optional().describe("Default: 'Permission denied by caller'"),
        interrupt: z.boolean().optional().describe("Default: false"),

        pollOptions: z
          .object({
            includeTools: z.boolean().optional().describe("Default: false"),
            includeEvents: z.boolean().optional().describe("Default: true"),
            includeActions: z.boolean().optional().describe("Default: true"),
            includeResult: z.boolean().optional().describe("Default: true"),
            includeUsage: z
              .boolean()
              .optional()
              .describe("Default: full=true, minimal/delta_compact=false"),
            includeModelUsage: z
              .boolean()
              .optional()
              .describe("Default: full=true, minimal/delta_compact=false"),
            includeStructuredOutput: z
              .boolean()
              .optional()
              .describe("Default: full=true, minimal/delta_compact=false"),
            includeTerminalEvents: z
              .boolean()
              .optional()
              .describe("Default: full=true, minimal/delta_compact=false"),
            includeProgressEvents: z
              .boolean()
              .optional()
              .describe("Default: full=true, minimal/delta_compact=false"),
            maxBytes: z.number().int().positive().optional().describe("Default: unlimited"),
          })
          .optional()
          .describe("Default: none"),

        permissionOptions: z
          .object({
            updatedInput: z.record(z.string(), z.unknown()).optional().describe("Default: none"),
            updatedPermissions: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe("Default: none"),
          })
          .optional()
          .describe("Default: none"),
      },
      outputSchema: checkResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra) => {
      try {
        const result = executeClaudeCodeCheck(args, sessionManager, toolCache, extra.signal);
        const isError = (result as { isError?: boolean }).isError === true;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
          isError,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errorResult = {
          sessionId: args.sessionId ?? "",
          status: "error",
          events: [] as unknown[],
          isError: true,
          error: `Error [${LocalErrorCode.INTERNAL}]: ${message}`,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(errorResult, null, 2),
            },
          ],
          structuredContent: errorResult as unknown as Record<string, unknown>,
          isError: true,
        };
      }
    }
  );

  registerResources(server, { toolCache, version: SERVER_VERSION, sessionManager });

  return { server, sessionManager, toolCache };
}

export function createServer(serverCwd: string): McpServer {
  return createServerContext(serverCwd).server;
}
