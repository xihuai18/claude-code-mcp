/**
 * Windows-specific utilities for Git Bash detection
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Attempt to locate bash.exe on Windows using the same logic as the Claude CLI:
 * 1. Check CLAUDE_CODE_GIT_BASH_PATH env var
 * 2. Find `git` in PATH and derive bash.exe from it
 *
 * Returns the resolved path, or null if not found.
 */
export function findGitBash(): string | null {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (existsSync(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH;
    }
    return null; // env var set but path doesn't exist
  }

  try {
    const gitPath = execSync("where git", { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    if (gitPath) {
      // git is typically at <root>/cmd/git.exe or <root>/mingw64/bin/git.exe
      // bash.exe is at <root>/bin/bash.exe
      const bashPath = join(dirname(gitPath), "..", "..", "bin", "bash.exe");
      if (existsSync(bashPath)) return bashPath;
      // Also try: git at <root>/bin/git.exe → same dir
      const bashPath2 = join(dirname(gitPath), "bash.exe");
      if (existsSync(bashPath2)) return bashPath2;
    }
  } catch {
    // `where git` failed — git not in PATH
  }

  return null;
}

/**
 * Log a startup warning if running on Windows without a detectable bash.exe.
 */
export function checkWindowsBashAvailability(): void {
  if (!isWindows()) return;

  const bashPath = findGitBash();
  if (bashPath) {
    console.error(`[windows] Git Bash detected: ${bashPath}`);
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
  if (
    errorMessage.includes("git-bash") ||
    errorMessage.includes("bash.exe") ||
    errorMessage.includes("CLAUDE_CODE_GIT_BASH_PATH")
  ) {
    return errorMessage + WINDOWS_BASH_HINT;
  }
  return errorMessage;
}
