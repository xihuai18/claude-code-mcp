/**
 * Windows-specific utilities for Git Bash detection
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

// Always use win32 path semantics in this module so that the logic works
// correctly even when the test-suite runs on a non-Windows CI host.
const { join, dirname, normalize, isAbsolute } = path.win32;
const LONG_PATH_PREFIX = "\\\\?\\";
const UNC_LONG_PATH_PREFIX = "\\\\?\\UNC\\";

export function isWindows(): boolean {
  return process.platform === "win32";
}

function normalizeMaybeQuotedPath(raw: string): string {
  return normalize(raw.trim().replace(/^"|"$/g, ""));
}

function existsSyncSafe(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function ensureLongPathPrefix(normalized: string): string {
  if (!normalized || normalized.startsWith(LONG_PATH_PREFIX)) return normalized;
  if (!isAbsolute(normalized)) return normalized;
  if (normalized.startsWith("\\\\")) {
    return `${UNC_LONG_PATH_PREFIX}${normalized.slice(2)}`;
  }
  return `${LONG_PATH_PREFIX}${normalized}`;
}

function existsPath(raw?: string): boolean {
  if (!raw) return false;
  const normalized = normalizeMaybeQuotedPath(raw);
  if (existsSyncSafe(normalized)) return true;
  const longPath = ensureLongPathPrefix(normalized);
  if (longPath === normalized) return false;
  return existsSyncSafe(longPath);
}

function tryWhere(exe: string): string[] {
  try {
    const output = execSync(`where ${exe}`, {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => normalizeMaybeQuotedPath(p));
  } catch {
    return [];
  }
}

function pathEntries(): string[] {
  const raw = process.env.PATH;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(path.delimiter)
    .map((p) => p.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((p) => normalizeMaybeQuotedPath(p));
}

function tryFromPath(exeNames: string[]): string[] {
  const results: string[] = [];
  for (const dir of pathEntries()) {
    for (const exe of exeNames) {
      const full = normalize(path.win32.join(dir, exe));
      if (existsPath(full)) results.push(full);
    }
  }
  return results;
}

function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (p && existsPath(p)) return p;
  }
  return null;
}

function isWindowsSystemBash(pathLike: string): boolean {
  const p = normalizeMaybeQuotedPath(pathLike).toLowerCase();
  return (
    p.endsWith("\\windows\\system32\\bash.exe") ||
    p.endsWith("\\windows\\syswow64\\bash.exe") ||
    p.includes("\\windows\\system32\\bash.exe") ||
    p.includes("\\windows\\syswow64\\bash.exe")
  );
}

/**
 * Attempt to locate bash.exe on Windows using the same logic as the Claude CLI:
 * 1. Check CLAUDE_CODE_GIT_BASH_PATH env var
 * 2. Find `git` in PATH and derive bash.exe from it
 *
 * Returns the resolved path, or null if not found.
 */
export function findGitBash(): string | null {
  const envPathRaw = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPathRaw && envPathRaw.trim() !== "") {
    // Users sometimes include quotes in JSON/env config.
    const envPath = normalizeMaybeQuotedPath(envPathRaw);
    if (existsPath(envPath)) return envPath;
    // Env var set but path doesn't exist — continue best-effort detection
  }

  // Common Git for Windows install locations (works even if PATH is missing).
  const programFilesRoots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ].filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const defaultCandidates: string[] = [];
  for (const root of programFilesRoots) {
    const base = join(normalizeMaybeQuotedPath(root), "Git");
    defaultCandidates.push(join(base, "bin", "bash.exe"));
    defaultCandidates.push(join(base, "usr", "bin", "bash.exe"));
  }
  const fromDefault = firstExisting(defaultCandidates);
  if (fromDefault) return fromDefault;

  try {
    const gitCandidates = [...tryFromPath(["git.exe", "git.cmd", "git.bat"]), ...tryWhere("git")];
    for (const gitPath of gitCandidates) {
      if (!gitPath) continue;

      const gitDir = dirname(gitPath);
      const gitDirLower = gitDir.toLowerCase();

      // Determine plausible Git roots from common layouts.
      // Layouts seen in the wild:
      //   <root>\cmd\git.exe           -> bash at <root>\bin\bash.exe
      //   <root>\bin\git.exe           -> bash at <root>\bin\bash.exe
      //   <root>\mingw64\bin\git.exe   -> bash at <root>\usr\bin\bash.exe (or <root>\bin\bash.exe)
      const roots = new Set<string>();
      roots.add(gitDir);
      roots.add(join(gitDir, ".."));
      roots.add(join(gitDir, "..", ".."));

      if (gitDirLower.endsWith("\\cmd") || gitDirLower.endsWith("\\bin")) {
        roots.add(join(gitDir, ".."));
      }
      if (gitDirLower.endsWith("\\mingw64\\bin")) {
        roots.add(join(gitDir, "..", ".."));
      }

      const bashCandidates: string[] = [];
      for (const root of roots) {
        // Common Git for Windows locations
        bashCandidates.push(join(root, "bin", "bash.exe"));
        bashCandidates.push(join(root, "usr", "bin", "bash.exe"));
        // Some layouts may place bash.exe adjacent
        bashCandidates.push(join(root, "bash.exe"));
        // Some portable installs
        bashCandidates.push(join(root, "mingw64", "bin", "bash.exe"));
      }

      for (const bashPath of bashCandidates) {
        const normalizedPath = normalize(bashPath);
        if (existsPath(normalizedPath)) return normalizedPath;
      }
    }
  } catch {
    // `where git` failed — git not in PATH
  }

  // If bash.exe is already on PATH, use it (avoid the WSL system bash.exe).
  const fromWhereBash = firstExisting(
    [...tryFromPath(["bash.exe"]), ...tryWhere("bash")].filter(
      (p) => p.toLowerCase().endsWith("\\bash.exe") && !isWindowsSystemBash(p)
    )
  );
  if (fromWhereBash) return fromWhereBash;

  return null;
}

/**
 * Log a startup warning if running on Windows without a detectable bash.exe.
 */
export function checkWindowsBashAvailability(): void {
  if (!isWindows()) return;

  const envPathRaw = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const envPath =
    envPathRaw && envPathRaw.trim() !== "" ? normalizeMaybeQuotedPath(envPathRaw) : null;
  const envValid = !!(envPath && existsPath(envPath));

  const bashPath = findGitBash();
  if (bashPath) {
    // Ensure child processes can reliably locate bash.exe even when started
    // from GUI clients that don't inherit a full PATH environment.
    if (!envValid) {
      process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      if (envPathRaw && envPathRaw.trim() !== "") {
        console.error(
          `[windows] WARNING: CLAUDE_CODE_GIT_BASH_PATH is set to "${envPathRaw}" but the file does not exist.`
        );
      }
      console.error(`[windows] Git Bash detected: ${bashPath} (set CLAUDE_CODE_GIT_BASH_PATH)`);
    } else {
      console.error(`[windows] Git Bash detected: ${bashPath}`);
    }
    return;
  }

  const hint = process.env.CLAUDE_CODE_GIT_BASH_PATH
    ? `CLAUDE_CODE_GIT_BASH_PATH is set to "${process.env.CLAUDE_CODE_GIT_BASH_PATH}" but the file does not exist.`
    : "CLAUDE_CODE_GIT_BASH_PATH is not set and git was not found in PATH.";

  console.error(
    `[windows] WARNING: ${hint}\n` +
      `  The Claude Code CLI requires Git Bash on Windows.\n` +
      `  Install Git for Windows (https://git-scm.com/downloads/win) and either:\n` +
      `    1. Add git to PATH, or\n` +
      `    2. Set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe path\n` +
      `  Example: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe\n` +
      `  See README.md "Windows Support" section for MCP client config examples.`
  );
}

const WINDOWS_BASH_HINT =
  "\n\n[Windows] The Claude Code CLI requires Git Bash. " +
  "Set CLAUDE_CODE_GIT_BASH_PATH in your MCP server config or system environment. " +
  'See README.md "Windows Support" section for details.';

/**
 * If the error looks like a Windows bash.exe issue, append a helpful hint.
 */
export function enhanceWindowsError(errorMessage: string): string {
  if (!isWindows()) return errorMessage;
  const lower = errorMessage.toLowerCase();
  const looksLikeMissingBash =
    (lower.includes("enoent") && (lower.includes("bash") || lower.includes("git-bash"))) ||
    lower.includes("claude code on windows requires git-bash");
  if (looksLikeMissingBash || lower.includes("claude_code_git_bash_path")) {
    return errorMessage + WINDOWS_BASH_HINT;
  }
  return errorMessage;
}
