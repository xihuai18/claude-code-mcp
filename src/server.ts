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
        "MCP server that runs Claude Code via the Claude Agent SDK. Starts and replies return quickly; callers poll with claude_code_check and answer permission requests explicitly.",
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
    tools: z
      .array(z.string())
      .optional()
      .describe("Allowed tool names for this subagent. Default: inherit"),
    disallowedTools: z.array(z.string()).optional().describe("Default: none"),
    model: z.string().optional().describe("Default: inherit"),
    maxTurns: z.number().int().positive().optional().describe("Default: none"),
    mcpServers: z
      .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
      .optional()
      .describe(
        "Additional MCP server names or inline process-transport specs for this subagent. Default: inherit"
      ),
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
      budgetTokens: z.number().int().positive().optional(),
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
    tools: toolsConfigSchema
      .optional()
      .describe(
        "Visible built-in tool set. Use this to restrict what Claude can see/call: string[] of exact tool names, [] to disable built-ins, or {type:'preset',preset:'claude_code'}. Default: SDK"
      ),
    persistSession: z.boolean().optional().describe("Default: true"),
    agents: z
      .record(z.string(), agentDefinitionSchema)
      .optional()
      .describe("Custom subagents keyed by agent name. Default: none"),
    agent: z.string().optional().describe("Default: none"),
    maxBudgetUsd: z.number().positive().optional().describe("Default: none"),
    betas: z.array(z.string()).optional().describe("Default: none"),
    additionalDirectories: z.array(z.string()).optional().describe("Default: none"),
    outputFormat: outputFormatSchema
      .optional()
      .describe("Structured output config: {type:'json_schema', schema:{...}}. Default: none"),
    pathToClaudeCodeExecutable: z
      .string()
      .optional()
      .describe(
        "Explicit Claude executable path. Default: auto-detect 'claude', then 'claude-internal', else SDK-bundled. Server env vars can override the default."
      ),
    mcpServers: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional()
      .describe("MCP server configs keyed by server name. Default: none"),
    sandbox: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Sandbox behavior config object. This controls sandbox behavior, not the actual allow/deny permission rules. Default: none"
      ),
    fallbackModel: z.string().optional().describe("Default: none"),
    enableFileCheckpointing: z.boolean().optional().describe("Default: false"),
    toolConfig: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Per-tool built-in config object, e.g. {askUserQuestion:{previewFormat:'markdown'|'html'}}. Default: none"
      ),
    includePartialMessages: z.boolean().optional().describe("Default: false"),
    promptSuggestions: z.boolean().optional().describe("Default: false"),
    agentProgressSummaries: z.boolean().optional().describe("Default: false"),
    strictMcpConfig: z.boolean().optional().describe("Default: false"),
    settings: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        "Path to a settings JSON file or an inline settings object. Loaded as highest-priority flag settings. Default: none"
      ),
    settingSources: z
      .array(z.enum(["user", "project", "local"]))
      .optional()
      .describe("Default: ['user','project','local']. []=isolation"),
    debug: z.boolean().optional().describe("Default: false"),
    debugFile: z
      .string()
      .optional()
      .describe("Write debug logs to this file and implicitly enable debug. Default: none"),
    env: z
      .record(z.string(), z.string().optional())
      .optional()
      .describe(
        "Environment variables merged over process.env before launching Claude Code. Default: none"
      ),
  } as const;

  const advancedOptionFieldsSchemaShape = {
    ...sharedOptionFieldsSchemaShape,
  } as const;

  const diskResumeOptionFieldsSchemaShape = {
    ...sharedOptionFieldsSchemaShape,
    effort: effortOptionSchema.describe(
      "Effort string: 'low' | 'medium' | 'high' | 'max'. Default: SDK"
    ),
    thinking: thinkingOptionSchema.describe(
      "Thinking config object, not a string. Use {type:'adaptive'} | {type:'enabled', budgetTokens?:N} | {type:'disabled'}. Default: SDK"
    ),
  } as const;

  /** Advanced options shared by claude_code (and reused in diskResumeConfig). */
  const advancedOptionsSchema = z
    .object({
      ...advancedOptionFieldsSchemaShape,
      sessionInitTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Server init wait timeout in ms; not forwarded to SDK Options. Default: 10000"),
    })
    .optional()
    .describe("Default: none");

  const diskResumeConfigSchema = z
    .object({
      resumeToken: z.string(),
      cwd: z.string(),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe("Pre-approved tool names for resumed execution. Default: []"),
      disallowedTools: z
        .array(z.string())
        .optional()
        .describe("Always-denied tool names. Default: []"),
      strictAllowedTools: z
        .boolean()
        .optional()
        .describe(
          "Server-side strict allowlist toggle; not forwarded to SDK Options. Default: false"
        ),
      maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
      model: z.string().optional().describe("Default: SDK"),
      systemPrompt: systemPromptSchema
        .optional()
        .describe(
          "System prompt config: string, {type:'preset',preset:'claude_code'}, or {type:'preset',preset:'claude_code',append:'...'}. Default: SDK"
        ),
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
        prompt: z
          .string()
          .describe(
            "Prompt for a new background run. The final result arrives later via claude_code_check, not this call. Store nextCursor from polls and reuse sessionId with claude_code_reply if you want to continue later."
          ),
        cwd: z.string().optional().describe("Working dir. Default: server cwd"),
        allowedTools: z
          .array(z.string())
          .optional()
          .describe(
            "Pre-approved tool names. Default: []. This is not a strict allowlist unless strictAllowedTools=true."
          ),
        disallowedTools: z
          .array(z.string())
          .optional()
          .describe("Always-denied tool names. Default: []"),
        strictAllowedTools: z
          .boolean()
          .optional()
          .describe("Default: false. When true, tools outside allowedTools are denied."),
        maxTurns: z.number().int().positive().optional().describe("Default: SDK"),
        model: z.string().optional().describe("Default: SDK"),
        effort: effortOptionSchema.describe(
          "Effort string: 'low' | 'medium' | 'high' | 'max'. Default: SDK"
        ),
        thinking: thinkingOptionSchema.describe(
          "Thinking config object, not a string. Use {type:'adaptive'} | {type:'enabled', budgetTokens?:N} | {type:'disabled'}. Default: SDK"
        ),
        systemPrompt: systemPromptSchema
          .optional()
          .describe(
            "System prompt config: string, {type:'preset',preset:'claude_code'}, or {type:'preset',preset:'claude_code',append:'...'}. Default: SDK"
          ),
        permissionRequestTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Server permission wait timeout in ms; not forwarded to SDK Options. Default: 60000, clamped to 300000"
          ),
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
        "Send a follow-up to an existing session. Reuse the same sessionId instead of starting a new claude_code session when you want to continue. Returns immediately; poll with claude_code_check. Use diskResumeConfig only when the in-memory session is missing and disk resume is enabled.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "Session ID from claude_code or an earlier claude_code_reply. Prefer this over starting a fresh claude_code session. Reply works only for persistent sessions, or with diskResumeConfig when disk resume fallback is enabled."
          ),
        prompt: z.string().describe("Follow-up prompt for the existing session."),
        forkSession: z.boolean().optional().describe("Default: false"),
        effort: effortOptionSchema.describe(
          "Effort string: 'low' | 'medium' | 'high' | 'max'. Default: SDK"
        ),
        thinking: thinkingOptionSchema.describe(
          "Thinking config object, not a string. Use {type:'adaptive'} | {type:'enabled', budgetTokens?:N} | {type:'disabled'}. Default: SDK"
        ),
        sessionInitTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Default: 10000. Applies when forkSession=true."),
        permissionRequestTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Server permission wait timeout in ms; not forwarded to SDK Options. Default: 60000, clamped to 300000"
          ),
        diskResumeConfig: diskResumeConfigSchema.describe(
          "Default: none. Use only when the in-memory session is missing and the server allows disk resume."
        ),
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
        action: z
          .enum(SESSION_ACTIONS)
          .describe("Session operation: list, get, cancel, or interrupt."),
        sessionId: z.string().optional().describe("Required for get/cancel/interrupt."),
        includeSensitive: z
          .boolean()
          .optional()
          .describe(
            "Default: false. Exposes more session fields, but some secrets remain redacted."
          ),
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
      description:
        'Poll session state or answer a pending permission request.\n\nPOLLING FREQUENCY: Do NOT poll every turn. Claude Code tasks take minutes, not seconds.\n- "running": sleep at least 2 minutes between polls; increase for complex tasks. Do NOT high-frequency poll — it wastes tokens.\n- "waiting_permission": poll ~1s and respond quickly.\n- "idle"/"error"/"cancelled": stop polling.\n- Adapt interval based on task complexity and whether the previous poll returned new events.\n\nMain loop: call action=\'poll\', persist nextCursor, and use action=\'respond_permission\' for approvals.',
      inputSchema: {
        action: z
          .enum(CHECK_ACTIONS)
          .describe(
            "'poll' fetches new events/actions/result; 'respond_permission' answers one pending permission request."
          ),
        sessionId: z.string().describe("Session ID returned by claude_code or claude_code_reply."),
        cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Default: 0. Pass the previous nextCursor to avoid replaying old buffered events."
          ),
        responseMode: z
          .enum(CHECK_RESPONSE_MODES)
          .optional()
          .describe(
            "Default: 'minimal'. Use 'delta_compact' for compact event payloads; use 'full' mainly for diagnostics."
          ),
        maxEvents: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Default: 200 (minimal), unlimited (full/delta_compact)"),

        requestId: z
          .string()
          .optional()
          .describe("Default: none. Required for action='respond_permission'."),
        decision: z
          .enum(["allow", "deny", "allow_for_session"])
          .optional()
          .describe(
            "Default: none. Required for action='respond_permission'. 'allow_for_session' reduces repeated prompts in the same session."
          ),
        denyMessage: z
          .string()
          .optional()
          .describe("Default: 'Permission denied by caller'. Used only with decision='deny'."),
        interrupt: z
          .boolean()
          .optional()
          .describe(
            "Default: false. When true, a deny decision also interrupts the whole session."
          ),

        pollOptions: z
          .object({
            includeTools: z
              .boolean()
              .optional()
              .describe(
                "Default: false. When true, include runtime-discovered availableTools; use this when exact tool names matter."
              ),
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
          .describe("Default: none. Advanced polling payload controls for action='poll'."),

        permissionOptions: z
          .object({
            updatedInput: z.record(z.string(), z.unknown()).optional().describe("Default: none"),
            updatedPermissions: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe("Default: none"),
          })
          .optional()
          .describe(
            "Default: none. Advanced permission response overrides for action='respond_permission'."
          ),
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
