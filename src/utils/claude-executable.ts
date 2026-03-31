import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CLAUDE_COMMAND_ENV = "CLAUDE_CODE_MCP_DEFAULT_CLAUDE_COMMAND";
export const DEFAULT_CLAUDE_PATH_ENV = "CLAUDE_CODE_MCP_DEFAULT_CLAUDE_PATH";

const AUTO_CLAUDE_COMMANDS = ["claude", "claude-internal"] as const;

export type DefaultClaudeExecutableSource =
  | "env_path"
  | "env_command"
  | "auto_claude"
  | "auto_claude_internal"
  | "sdk_bundled";

export interface DefaultClaudeExecutableResolution {
  source: DefaultClaudeExecutableSource;
  command?: string;
  resolvedPath?: string;
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeMaybeQuotedPath(raw: string): string {
  return path.normalize(raw.trim().replace(/^"|"$/g, ""));
}

function normalizeMaybeQuotedToken(raw: string): string {
  return raw.trim().replace(/^"|"$/g, "");
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsableExecutablePath(candidate: string): boolean {
  return isExecutableFile(candidate);
}

function pathEntries(): string[] {
  const raw = process.env.PATH;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.normalize(entry));
}

function windowsExecutableNames(command: string): string[] {
  const ext = path.extname(command);
  if (ext) return [command];
  const pathExt = trimEnv("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  const exts = Array.from(
    new Set(
      pathExt
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
  return exts.map((suffix) => `${command}${suffix.toLowerCase()}`);
}

function resolveCommandFromPath(command: string): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    throw new Error(
      `${DEFAULT_CLAUDE_COMMAND_ENV} must be a command name without path separators. Use ${DEFAULT_CLAUDE_PATH_ENV} for filesystem paths.`
    );
  }

  const names = process.platform === "win32" ? windowsExecutableNames(command) : [command];
  const uniqueNames = Array.from(new Set(names.filter(Boolean)));

  for (const dir of pathEntries()) {
    for (const name of uniqueNames) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && isExecutableFile(candidate)) {
        return path.normalize(candidate);
      }
    }
  }

  return undefined;
}

function resolveConfiguredPath(rawPath: string): string {
  const normalized = normalizeMaybeQuotedPath(rawPath);
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(normalized);
  if (!isUsableExecutablePath(resolved)) {
    throw new Error(`${DEFAULT_CLAUDE_PATH_ENV} does not point to an executable file: ${resolved}`);
  }
  return path.normalize(resolved);
}

export function resolveDefaultClaudeExecutable(): DefaultClaudeExecutableResolution {
  const configuredPath = trimEnv(DEFAULT_CLAUDE_PATH_ENV);
  const configuredCommandRaw = trimEnv(DEFAULT_CLAUDE_COMMAND_ENV);
  const configuredCommand = configuredCommandRaw
    ? normalizeMaybeQuotedToken(configuredCommandRaw)
    : undefined;

  if (configuredPath && configuredCommand) {
    throw new Error(
      `${DEFAULT_CLAUDE_PATH_ENV} and ${DEFAULT_CLAUDE_COMMAND_ENV} are mutually exclusive; set only one.`
    );
  }

  if (configuredPath) {
    return {
      source: "env_path",
      resolvedPath: resolveConfiguredPath(configuredPath),
    };
  }

  if (configuredCommand) {
    const resolved = resolveCommandFromPath(configuredCommand);
    if (!resolved) {
      throw new Error(
        `${DEFAULT_CLAUDE_COMMAND_ENV}='${configuredCommand}' was not found in PATH.`
      );
    }
    return {
      source: "env_command",
      command: configuredCommand,
      resolvedPath: resolved,
    };
  }

  for (const candidate of AUTO_CLAUDE_COMMANDS) {
    const resolved = resolveCommandFromPath(candidate);
    if (!resolved) continue;
    return {
      source: candidate === "claude" ? "auto_claude" : "auto_claude_internal",
      command: candidate,
      resolvedPath: resolved,
    };
  }

  return { source: "sdk_bundled" };
}

export function getDefaultClaudeExecutablePath(): string | undefined {
  return resolveDefaultClaudeExecutable().resolvedPath;
}

export function checkDefaultClaudeExecutableAvailability(): void {
  // Invalid env overrides are treated as startup misconfiguration and should
  // fail fast instead of silently falling back to a different executable.
  const resolution = resolveDefaultClaudeExecutable();
  if (!resolution.resolvedPath) return;
  const commandText = resolution.command ? `, command=${resolution.command}` : "";
  console.error(
    `[executable] Default Claude executable resolved: ${resolution.resolvedPath} (source=${resolution.source}${commandText})`
  );
}
