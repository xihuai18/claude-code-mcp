/**
 * Shared helper to build SDK query options from a flat source object.
 *
 * All three call-sites (claude-code start, reply from session, disk-resume)
 * share the same field-by-field copy logic.  This function centralises it so
 * a newly-added Options field only needs to be wired once.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
  OutputFormat,
  SandboxSettings,
  SettingSource,
  SystemPrompt,
  ThinkingConfig,
  ToolsConfig,
} from "../types.js";
import { DEFAULT_SETTING_SOURCES } from "../types.js";

/** Superset of fields that any of the three call-sites may provide. */
export interface OptionSource {
  cwd: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  maxTurns?: number;
  model?: string;
  systemPrompt?: SystemPrompt;
  agents?: Record<string, AgentDefinition>;
  maxBudgetUsd?: number;
  effort?: EffortLevel;
  betas?: string[];
  additionalDirectories?: string[];
  outputFormat?: OutputFormat;
  thinking?: ThinkingConfig;
  persistSession?: boolean;
  resumeSessionAt?: string;
  pathToClaudeCodeExecutable?: string;
  agent?: string;
  mcpServers?: Record<string, McpServerConfig>;
  sandbox?: SandboxSettings;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  includePartialMessages?: boolean;
  strictMcpConfig?: boolean;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Build SDK `Partial<Options>` from a flat source object.
 *
 * Only copies fields that are explicitly defined (not `undefined`) so that
 * SDK defaults are preserved for omitted fields.
 */
export function buildOptions(src: OptionSource): Partial<Options> {
  const opts: Partial<Options> = { cwd: src.cwd };

  if (src.allowedTools !== undefined) opts.allowedTools = src.allowedTools;
  if (src.disallowedTools !== undefined) opts.disallowedTools = src.disallowedTools;
  if (src.tools !== undefined) opts.tools = src.tools;
  if (src.maxTurns !== undefined) opts.maxTurns = src.maxTurns;
  if (src.model !== undefined) opts.model = src.model;
  if (src.systemPrompt !== undefined) opts.systemPrompt = src.systemPrompt;
  if (src.agents !== undefined) opts.agents = src.agents as Options["agents"];
  if (src.maxBudgetUsd !== undefined) opts.maxBudgetUsd = src.maxBudgetUsd;
  if (src.effort !== undefined) opts.effort = src.effort;
  if (src.betas !== undefined) opts.betas = src.betas as Options["betas"];
  if (src.additionalDirectories !== undefined)
    opts.additionalDirectories = src.additionalDirectories;
  if (src.outputFormat !== undefined) opts.outputFormat = src.outputFormat;
  if (src.thinking !== undefined) opts.thinking = src.thinking;
  if (src.persistSession !== undefined) opts.persistSession = src.persistSession;
  if (src.resumeSessionAt !== undefined) opts.resumeSessionAt = src.resumeSessionAt;
  if (src.pathToClaudeCodeExecutable !== undefined)
    opts.pathToClaudeCodeExecutable = src.pathToClaudeCodeExecutable;
  if (src.agent !== undefined) opts.agent = src.agent;
  if (src.mcpServers !== undefined) opts.mcpServers = src.mcpServers as Options["mcpServers"];
  if (src.sandbox !== undefined) opts.sandbox = src.sandbox;
  if (src.fallbackModel !== undefined) opts.fallbackModel = src.fallbackModel;
  if (src.enableFileCheckpointing !== undefined)
    opts.enableFileCheckpointing = src.enableFileCheckpointing;
  if (src.includePartialMessages !== undefined)
    opts.includePartialMessages = src.includePartialMessages;
  if (src.strictMcpConfig !== undefined) opts.strictMcpConfig = src.strictMcpConfig;
  if (src.settingSources !== undefined) opts.settingSources = src.settingSources;
  else opts.settingSources = DEFAULT_SETTING_SOURCES;
  if (src.debug !== undefined) opts.debug = src.debug;
  if (src.debugFile !== undefined) opts.debugFile = src.debugFile;
  if (src.env !== undefined) opts.env = { ...process.env, ...src.env };

  return opts;
}
