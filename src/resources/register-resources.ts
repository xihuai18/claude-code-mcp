import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type { SessionManager } from "../session/manager.js";
import { ErrorCode, type PublicSessionInfo } from "../types.js";
import {
  defaultCatalogTools,
  discoverToolsFromInit,
  type ToolDiscoveryCache,
} from "../tools/tool-discovery.js";

const RESOURCE_SCHEME = "claude-code-mcp";

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  internalTools: `${RESOURCE_SCHEME}:///internal-tools`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
  quickstart: `${RESOURCE_SCHEME}:///quickstart`,
  errors: `${RESOURCE_SCHEME}:///errors`,
  compatReport: `${RESOURCE_SCHEME}:///compat-report`,
} as const;

const RESOURCE_TEMPLATES = {
  sessionById: `${RESOURCE_SCHEME}:///session/{sessionId}`,
  runtimeTools: `${RESOURCE_SCHEME}:///tools/runtime{?sessionId}`,
  compatDiff: `${RESOURCE_SCHEME}:///compat/diff{?client}`,
} as const;

type GotchaSeverity = "low" | "medium" | "high";
type GotchaEntry = {
  id: string;
  title: string;
  severity: GotchaSeverity;
  appliesTo: string[];
  symptom: string;
  detection: string;
  remedy: string;
  example?: string;
};

function asTextResource(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        text,
        mimeType,
      },
    ],
  };
}

function asJsonResource(uri: URL, value: unknown): ReadResourceResult {
  return asTextResource(uri, JSON.stringify(value, null, 2), "application/json");
}

function serializeLimit(limit: number): number | "unlimited" {
  return Number.isFinite(limit) ? limit : "unlimited";
}

function computeEtag(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function extractSingleVariable(value: string | string[] | null | undefined): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim() !== "")
    return value[0];
  return undefined;
}

function buildSessionRedactions(includeSensitive: boolean): PublicSessionInfo["redactions"] {
  const redactions: PublicSessionInfo["redactions"] = [
    { field: "env", reason: "secret_or_internal" },
    { field: "mcpServers", reason: "secret_or_internal" },
    { field: "sandbox", reason: "secret_or_internal" },
    { field: "settings", reason: "secret_or_internal" },
    { field: "debugFile", reason: "secret_or_internal" },
    { field: "pathToClaudeCodeExecutable", reason: "secret_or_internal" },
  ];
  if (!includeSensitive) {
    redactions.push(
      { field: "cwd", reason: "sensitive_by_default" },
      { field: "systemPrompt", reason: "sensitive_by_default" },
      { field: "agents", reason: "sensitive_by_default" },
      { field: "additionalDirectories", reason: "sensitive_by_default" },
      { field: "toolConfig", reason: "sensitive_by_default" }
    );
  }
  return redactions;
}

function buildGotchasEntries(): GotchaEntry[] {
  return [
    {
      id: "permission-timeout",
      title: "Permission requests auto-deny on timeout",
      severity: "high",
      appliesTo: ["claude_code_check.actions", "permission workflow"],
      symptom:
        "Session waits for approval, then tool call is denied without explicit caller decision.",
      detection:
        "Observe actions[].expiresAt/remainingMs and permission_result with source=timeout.",
      remedy:
        "Poll more frequently and respond before timeout; increase permissionRequestTimeoutMs if needed.",
      example: "Default timeout is 60000ms and server-clamped to 300000ms.",
    },
    {
      id: "read-size-cap",
      title: "Read may cap response size",
      severity: "medium",
      appliesTo: ["Read tool"],
      symptom: "Large file reads are truncated or fail.",
      detection: "Read responses are incomplete for large files.",
      remedy: "Use offset/limit paging or chunk with Grep.",
    },
    {
      id: "edit-replace-all",
      title: "Edit replace_all uses substring matching",
      severity: "medium",
      appliesTo: ["Edit tool"],
      symptom: "replace_all=true fails unexpectedly.",
      detection: "Tool returns error when no exact substring match is found.",
      remedy: "Validate exact match text first; prefer smaller targeted replacements.",
    },
    {
      id: "windows-path-normalization",
      title: "Windows path normalization applies to common MSYS-style paths",
      severity: "medium",
      appliesTo: ["Windows", "cwd", "additionalDirectories", "file_path"],
      symptom: "Permission/path behavior differs from raw input path text.",
      detection: "Compare submitted path with effective path in logs/permission prompts.",
      remedy:
        "Use absolute native Windows paths when possible; avoid relying on implicit conversion behavior.",
      example: "/d/... /mnt/c/... /cygdrive/c/... //server/share/... are normalized on Windows.",
    },
    {
      id: "team-delete-async-cleanup",
      title: "TeamDelete cleanup can be asynchronous",
      severity: "low",
      appliesTo: ["TeamDelete"],
      symptom: "Immediate follow-up calls still see active members.",
      detection: "TeamDelete reports shutdown_approved or active member transitions.",
      remedy: "Retry after short delay; wait for shutdown state to settle.",
    },
    {
      id: "skills-late-availability",
      title: "Skills may become available later in a session",
      severity: "low",
      appliesTo: ["Skills"],
      symptom: "Early calls show unknown skill/tool errors.",
      detection: "Later calls in same session succeed without config changes.",
      remedy: "Retry after initialization events are complete.",
    },
    {
      id: "tool-count-sources-differ",
      title: "toolCatalogCount and availableTools have different sources",
      severity: "medium",
      appliesTo: ["internal-tools", "claude_code_check.availableTools", "compat-report"],
      symptom: "Tool counts appear inconsistent (for example 15 vs 28).",
      detection: "Compare compat-report.toolCounts and session-level availableTools.",
      remedy:
        "Treat catalog count as server-known baseline and availableTools as session runtime view from system/init.tools.",
    },
    {
      id: "available-tools-not-exhaustive",
      title: "availableTools may omit internal features",
      severity: "low",
      appliesTo: ["claude_code_check.availableTools"],
      symptom: "A known feature is callable but not listed in availableTools.",
      detection: "Feature works while missing from availableTools list.",
      remedy: "Use availableTools as runtime hint, not exhaustive capability proof.",
      example: "Some internal features (e.g. ToolSearch) may not appear.",
    },
  ];
}

function asVersionedPayload(params: {
  schemaVersion: string;
  stability: "stable" | "experimental";
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const updatedAt = new Date().toISOString();
  return {
    ...params.payload,
    schemaVersion: params.schemaVersion,
    updatedAt,
    etag: computeEtag(params.payload),
    stability: params.stability,
  };
}

export function registerResources(
  server: McpServer,
  deps: { toolCache: ToolDiscoveryCache; version: string; sessionManager: SessionManager }
): void {
  const startedAt = new Date().toISOString();
  const resourceSchemaVersion = "1.3";
  const mcpProtocolVersion = "2025-03-26";
  const gotchasEntries = buildGotchasEntries();
  const catalogToolNames = new Set(defaultCatalogTools().map((tool) => tool.name));
  const staticResourceUris = Object.values(RESOURCE_URIS);
  const templateUris = Object.values(RESOURCE_TEMPLATES);

  const serverInfoUri = new URL(RESOURCE_URIS.serverInfo);
  server.registerResource(
    "server_info",
    serverInfoUri.toString(),
    {
      title: "Server Info",
      description: "Server metadata (version/platform/runtime).",
      mimeType: "application/json",
    },
    () =>
      asJsonResource(
        serverInfoUri,
        (() => {
          const base: Record<string, unknown> = {
            name: "claude-code-mcp",
            version: deps.version,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            mcpProtocolVersion,
            startedAt,
            uptimeSec: Math.floor(process.uptime()),
            resources: staticResourceUris,
            resourceTemplates: templateUris,
            toolCatalogCount: deps.toolCache.getTools().length,
            capabilities: {
              resources: true,
              toolsListChanged: true,
              resourcesListChanged: true,
              prompts: false,
              completions: false,
            },
            limits: {
              maxSessions: serializeLimit(deps.sessionManager.getMaxSessions()),
              maxPendingPermissionsPerSession: serializeLimit(
                deps.sessionManager.getMaxPendingPermissionsPerSession()
              ),
              eventBuffer: deps.sessionManager.getEventBufferConfig(),
              pollDefaults: {
                runningMs: 3000,
                waitingPermissionMs: 1000,
              },
            },
          };
          if (typeof process.env.CLAUDE_CODE_MCP_BUILD_COMMIT === "string") {
            const commit = process.env.CLAUDE_CODE_MCP_BUILD_COMMIT.trim();
            if (commit !== "") base.buildCommit = commit;
          }
          return asVersionedPayload({
            schemaVersion: resourceSchemaVersion,
            stability: "stable",
            payload: base,
          });
        })()
      )
  );

  const toolsUri = new URL(RESOURCE_URIS.internalTools);
  server.registerResource(
    "internal_tools",
    toolsUri.toString(),
    {
      title: "Internal Tools",
      description: "Claude Code internal tool catalog (runtime-aware).",
      mimeType: "application/json",
    },
    () =>
      asJsonResource(
        toolsUri,
        (() => {
          const base: Record<string, unknown> = {
            tools: deps.toolCache.getTools(),
            toolCatalogCount: deps.toolCache.getTools().length,
          };
          return asVersionedPayload({
            schemaVersion: resourceSchemaVersion,
            stability: "stable",
            payload: base,
          });
        })()
      )
  );

  const gotchasUri = new URL(RESOURCE_URIS.gotchas);
  server.registerResource(
    "gotchas",
    gotchasUri.toString(),
    {
      title: "Gotchas",
      description: "Practical limits and gotchas when using Claude Code via this MCP server.",
      mimeType: "text/markdown",
    },
    () =>
      asTextResource(
        gotchasUri,
        [
          "# claude-code-mcp: gotchas",
          "",
          ...gotchasEntries.map((entry) => `- ${entry.title}. ${entry.remedy}`),
          "",
        ].join("\n"),
        "text/markdown"
      )
  );

  const compatReportUri = new URL(RESOURCE_URIS.compatReport);

  const quickstartUri = new URL(RESOURCE_URIS.quickstart);
  server.registerResource(
    "quickstart",
    quickstartUri.toString(),
    {
      title: "Quickstart",
      description: "Minimal async polling flow for claude_code / claude_code_check.",
      mimeType: "text/markdown",
    },
    () =>
      asTextResource(
        quickstartUri,
        [
          "# claude-code-mcp quickstart",
          "",
          "1. Call `claude_code` with `{ prompt }` and keep `sessionId`.",
          "2. Poll with `claude_code_check(action='poll')` using `nextCursor`.",
          "3. If actions are returned, respond with `claude_code_check(action='respond_permission')`.",
          "4. Continue polling until status becomes `idle` / `error` / `cancelled`.",
          "",
          "Notes:",
          "- `respond_user_input` is not supported on this backend.",
          "- `allowedTools` is pre-approval by default; set `strictAllowedTools=true` for strict allowlist behavior.",
          "- OpenCode/Codex-style clients usually work best when they store `sessionId` + `nextCursor` and answer approvals with `decision=allow_for_session`.",
          "- Prefer `responseMode='delta_compact'` for high-frequency polling.",
        ].join("\n"),
        "text/markdown"
      )
  );

  const errorsUri = new URL(RESOURCE_URIS.errors);
  server.registerResource(
    "errors",
    errorsUri.toString(),
    {
      title: "Errors",
      description: "Structured error codes and remediation hints.",
      mimeType: "application/json",
    },
    () => {
      const codes = Object.values(ErrorCode);
      const hints = {
        [ErrorCode.INVALID_ARGUMENT]: "Validate required fields and enum values.",
        [ErrorCode.SESSION_NOT_FOUND]: "Session may be expired or server-restarted.",
        [ErrorCode.SESSION_BUSY]: "Wait for running/waiting_permission session to settle.",
        [ErrorCode.PERMISSION_REQUEST_NOT_FOUND]:
          "The permission request was already finished/expired.",
        [ErrorCode.PERMISSION_DENIED]: "Check token/secrets/policy restrictions.",
        [ErrorCode.RESOURCE_EXHAUSTED]: "Reduce session count or increase server limits.",
        [ErrorCode.TIMEOUT]: "Increase timeout or poll/respond more frequently.",
        [ErrorCode.CANCELLED]: "Request/session was cancelled by caller or shutdown.",
        [ErrorCode.INTERNAL]: "Inspect server logs and runtime environment.",
      };
      return asJsonResource(
        errorsUri,
        asVersionedPayload({
          schemaVersion: resourceSchemaVersion,
          stability: "stable",
          payload: {
            codes,
            hints,
          },
        })
      );
    }
  );

  server.registerResource(
    "compat_report",
    compatReportUri.toString(),
    {
      title: "Compatibility Report",
      description: "Compatibility diagnostics for MCP clients and local runtime assumptions.",
      mimeType: "application/json",
    },
    () => {
      const runtimeWarnings: string[] = [];
      if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
        runtimeWarnings.push(
          "CLAUDE_CODE_GIT_BASH_PATH is not set. Auto-detection exists, but explicit path is more reliable for GUI-launched MCP clients."
        );
      }
      const diskResumeEnabled = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME === "1";
      const resumeSecretConfigured =
        typeof process.env.CLAUDE_CODE_MCP_RESUME_SECRET === "string" &&
        process.env.CLAUDE_CODE_MCP_RESUME_SECRET.trim() !== "";
      const runtimeToolStats = deps.sessionManager.getRuntimeToolStats();
      const toolCatalogCount = deps.toolCache.getTools().length;
      const detectedMismatches: string[] = [];
      if (
        runtimeToolStats.sessionsWithInitTools > 0 &&
        runtimeToolStats.runtimeDiscoveredUniqueCount < toolCatalogCount
      ) {
        detectedMismatches.push(
          "Runtime discovered tools are fewer than catalog tools; some features may be hidden or not surfaced in system/init.tools."
        );
      }
      const updatedAt = new Date().toISOString();
      const base = {
        transport: "stdio",
        samePlatformRequired: true,
        packageVersion: deps.version,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        limits: {
          maxSessions: serializeLimit(deps.sessionManager.getMaxSessions()),
          maxPendingPermissionsPerSession: serializeLimit(
            deps.sessionManager.getMaxPendingPermissionsPerSession()
          ),
          eventBuffer: deps.sessionManager.getEventBufferConfig(),
        },
        diskResume: {
          enabled: diskResumeEnabled,
          resumeSecretConfigured,
        },
        features: {
          resources: true,
          resourceTemplates: true,
          toolsListChanged: true,
          resourcesListChanged: true,
          sessionInterrupt: true,
          allowForSessionDecision: true,
          respondUserInput: false,
          prompts: false,
          completions: false,
        },
        recommendedSettings: {
          responseMode: "delta_compact",
          poll: {
            runningMs: 3000,
            waitingPermissionMs: 1000,
            cursorStrategy: "Persist nextCursor and de-duplicate by event.id.",
          },
          timeouts: {
            sessionInitTimeoutMs: 10000,
            permissionRequestTimeoutMs: 60000,
            permissionRequestTimeoutMaxMs: 300000,
          },
        },
        guidance: [
          "Some clients cache tool descriptions at connect time. Prefer claude_code_check(pollOptions.includeTools=true) for runtime-authoritative tool lists.",
          "Use allowedTools/disallowedTools only with exact runtime tool names.",
          "Set strictAllowedTools=true when you need allowedTools to behave as a strict allowlist.",
          "This server assumes MCP client and server run on the same machine/platform.",
          "For high-frequency status checks, prefer responseMode='delta_compact'.",
          "respond_user_input is not supported on this backend; use poll/respond_permission flow.",
        ],
        toolCounts: {
          catalogCount: toolCatalogCount,
          sessionsWithInitTools: runtimeToolStats.sessionsWithInitTools,
          runtimeDiscoveredUniqueCount: runtimeToolStats.runtimeDiscoveredUniqueCount,
          explain:
            "catalogCount is server catalog size; runtimeDiscoveredUniqueCount is union of system/init.tools across active sessions.",
        },
        toolCatalogCount,
        detectedMismatches,
        runtimeWarnings,
        resourceTemplates: templateUris,
      };
      const healthScore = Math.max(
        0,
        100 - runtimeWarnings.length * 10 - detectedMismatches.length * 15
      );

      return asJsonResource(
        compatReportUri,
        asVersionedPayload({
          schemaVersion: resourceSchemaVersion,
          stability: "stable",
          payload: {
            ...base,
            healthScore,
            updatedAt,
          },
        })
      );
    }
  );

  server.registerResource(
    "session_snapshot_template",
    new ResourceTemplate(RESOURCE_TEMPLATES.sessionById, { list: undefined }),
    {
      title: "Session Snapshot Template",
      description: "Read lightweight session diagnostics by sessionId.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const sessionId =
        extractSingleVariable(variables.sessionId) ??
        extractSingleVariable(uri.searchParams.get("sessionId"));
      const payload =
        typeof sessionId !== "string" || sessionId.trim() === ""
          ? {
              found: false,
              message: "sessionId is required in URI template variable.",
            }
          : (() => {
              const session = deps.sessionManager.get(sessionId);
              if (!session) {
                return {
                  sessionId,
                  found: false,
                  message: `Session '${sessionId}' not found.`,
                };
              }
              const base = deps.sessionManager.toPublicJSON(session);
              const stored = deps.sessionManager.getResult(sessionId);
              return {
                sessionId,
                found: true,
                session: {
                  ...base,
                  pendingPermissionCount: deps.sessionManager.getPendingPermissionCount(sessionId),
                  eventCount: deps.sessionManager.getEventCount(sessionId),
                  currentCursor: deps.sessionManager.getCurrentCursor(sessionId),
                  lastEventId: deps.sessionManager.getLastEventId(sessionId),
                  ttlMs: deps.sessionManager.getRemainingTtlMs(sessionId),
                  lastError: stored?.type === "error" ? stored.result.result : undefined,
                  lastErrorAt: stored?.type === "error" ? stored.createdAt : undefined,
                  redactions: buildSessionRedactions(false),
                },
              };
            })();

      return asJsonResource(
        uri,
        asVersionedPayload({
          schemaVersion: resourceSchemaVersion,
          stability: "stable",
          payload: payload as Record<string, unknown>,
        })
      );
    }
  );

  server.registerResource(
    "runtime_tools_template",
    new ResourceTemplate(RESOURCE_TEMPLATES.runtimeTools, { list: undefined }),
    {
      title: "Runtime Tools Template",
      description: "Read runtime tool view globally or for a specific sessionId.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const sessionId =
        extractSingleVariable(variables.sessionId) ??
        extractSingleVariable(uri.searchParams.get("sessionId"));
      const internalToolCount = catalogToolNames.size;
      const payload = (() => {
        if (typeof sessionId === "string" && sessionId.trim() !== "") {
          const session = deps.sessionManager.get(sessionId);
          if (!session) {
            return {
              sessionId,
              source: "session_not_found",
              availableTools: [],
              toolCounts: {
                internalToolCount,
                runtimeAvailableCount: 0,
                sessionAugmentedToolCount: 0,
              },
            };
          }
          const initTools = deps.sessionManager.getInitTools(sessionId) ?? [];
          const discovered = discoverToolsFromInit(initTools);
          const sessionAugmentedToolCount = discovered.filter(
            (tool) => !catalogToolNames.has(tool.name)
          ).length;
          return {
            sessionId,
            source: initTools.length > 0 ? "session_runtime" : "session_without_init",
            availableTools: discovered,
            toolCounts: {
              internalToolCount,
              runtimeAvailableCount: discovered.length,
              sessionAugmentedToolCount,
            },
          };
        }
        const catalog = deps.toolCache.getTools();
        const sessionAugmentedToolCount = catalog.filter(
          (tool) => !catalogToolNames.has(tool.name)
        ).length;
        return {
          source: "catalog",
          availableTools: catalog,
          toolCounts: {
            internalToolCount,
            runtimeAvailableCount: catalog.length,
            sessionAugmentedToolCount,
          },
        };
      })();

      return asJsonResource(
        uri,
        asVersionedPayload({
          schemaVersion: resourceSchemaVersion,
          stability: "stable",
          payload: payload as Record<string, unknown>,
        })
      );
    }
  );

  server.registerResource(
    "compat_diff_template",
    new ResourceTemplate(RESOURCE_TEMPLATES.compatDiff, { list: undefined }),
    {
      title: "Compatibility Diff Template",
      description: "Returns client-specific compatibility guidance and recommended settings.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const clientRaw =
        extractSingleVariable(variables.client) ??
        extractSingleVariable(uri.searchParams.get("client"));
      const clientFingerprint = (clientRaw ?? "unknown").trim();
      const key = clientFingerprint.toLowerCase();
      const profile = (() => {
        if (key.includes("codex")) {
          return {
            clientFamily: "codex",
            detectedMismatches: [] as string[],
            recommendations: [
              "Prefer responseMode='delta_compact' for fast status loops.",
              "Enable pollOptions.includeTools=true when exact runtime tool names are required.",
            ],
          };
        }
        if (key.includes("claude")) {
          return {
            clientFamily: "claude",
            detectedMismatches: [] as string[],
            recommendations: [
              "Use resources and resource templates for low-latency diagnostics.",
              "Use allowedTools/disallowedTools with exact runtime names.",
              "Enable strictAllowedTools when running in locked-down governance mode.",
            ],
          };
        }
        if (key.includes("cursor")) {
          return {
            clientFamily: "cursor",
            detectedMismatches: [
              "Verify that resources/list and resourceTemplates/list are refreshed after list_changed notifications.",
            ],
            recommendations: [
              "Prefer claude_code_check polling as source of truth for runtime state.",
              "Fallback to tool calls if resource template support is partial.",
            ],
          };
        }
        return {
          clientFamily: "generic",
          detectedMismatches: [] as string[],
          recommendations: [
            "Persist nextCursor and de-duplicate by event.id.",
            "Use responseMode='delta_compact' for high-frequency polling, full mode only for diagnostics.",
          ],
        };
      })();

      return asJsonResource(
        uri,
        asVersionedPayload({
          schemaVersion: resourceSchemaVersion,
          stability: "experimental",
          payload: {
            clientFingerprint,
            ...profile,
            recommendedSettings: {
              responseMode: "delta_compact",
              poll: {
                runningMs: 3000,
                waitingPermissionMs: 1000,
                cursorStrategy: "Persist nextCursor and de-duplicate by event.id.",
              },
            },
          },
        })
      );
    }
  );
}
