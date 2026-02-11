/**
 * Windows-specific utilities for Git Bash detection
 */
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, normalize } from "node:path";

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
  const envPathRaw = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (envPathRaw && envPathRaw.trim() !== "") {
    // Users sometimes include quotes in JSON/env config.
    const envPath = normalize(envPathRaw.trim().replace(/^"|"$/g, ""));
    if (existsSync(envPath)) return envPath;
    return null; // env var set but path doesn't exist
  }

  try {
    const output = execSync("where git", { encoding: "utf8" });
    const gitCandidates = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const gitPathRaw of gitCandidates) {
      const gitPath = normalize(gitPathRaw.replace(/^"|"$/g, ""));
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
        const normalized = normalize(bashPath);
        if (existsSync(normalized)) return normalized;
      }
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
