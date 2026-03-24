import type { SessionManager } from "../session/manager.js";
import type { PermissionMode } from "../types.js";
import { DEFAULT_SETTING_SOURCES } from "../types.js";
import type { OptionSource } from "./build-options.js";

export type SessionCreateParams = Parameters<SessionManager["create"]>[0];

export function toSessionCreateParams(input: {
  sessionId: string;
  source: OptionSource;
  abortController: AbortController;
  queryInterrupt?: () => void;
  permissionMode?: PermissionMode;
}): SessionCreateParams {
  const src = input.source;
  return {
    sessionId: input.sessionId,
    cwd: src.cwd,
    model: src.model,
    permissionMode: input.permissionMode,
    allowedTools: src.allowedTools,
    disallowedTools: src.disallowedTools,
    strictAllowedTools: src.strictAllowedTools,
    tools: src.tools,
    maxTurns: src.maxTurns,
    systemPrompt: src.systemPrompt,
    agents: src.agents,
    maxBudgetUsd: src.maxBudgetUsd,
    effort: src.effort,
    betas: src.betas,
    additionalDirectories: src.additionalDirectories,
    outputFormat: src.outputFormat,
    thinking: src.thinking,
    persistSession: src.persistSession,
    pathToClaudeCodeExecutable: src.pathToClaudeCodeExecutable,
    agent: src.agent,
    mcpServers: src.mcpServers,
    sandbox: src.sandbox,
    fallbackModel: src.fallbackModel,
    enableFileCheckpointing: src.enableFileCheckpointing,
    toolConfig: src.toolConfig,
    includePartialMessages: src.includePartialMessages,
    promptSuggestions: src.promptSuggestions,
    agentProgressSummaries: src.agentProgressSummaries,
    strictMcpConfig: src.strictMcpConfig,
    settings: src.settings,
    settingSources: src.settingSources ?? DEFAULT_SETTING_SOURCES,
    debug: src.debug,
    debugFile: src.debugFile,
    env: src.env,
    abortController: input.abortController,
    queryInterrupt: input.queryInterrupt,
  };
}
