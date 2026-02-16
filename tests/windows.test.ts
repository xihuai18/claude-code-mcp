import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fs/child_process so tests are deterministic and cross-platform.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { findGitBash, enhanceWindowsError } from "../src/utils/windows.js";

const existsSyncMock = vi.mocked(existsSync);
const execSyncMock = vi.mocked(execSync);

describe("windows utils", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    // Force Windows behavior for these tests
    Object.defineProperty(process, "platform", { value: "win32" });
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("findGitBash prefers CLAUDE_CODE_GIT_BASH_PATH and trims/dequotes", () => {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = ' "C:\\Program Files\\Git\\bin\\bash.exe" ';
    existsSyncMock.mockImplementation((p) => String(p).includes("bash.exe"));

    expect(findGitBash()).toContain("bash.exe");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("findGitBash derives root from cmd\\git.exe and finds <root>\\bin\\bash.exe", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    execSyncMock.mockReturnValue(
      "C:\\Program Files\\Git\\cmd\\git.exe\r\nC:\\Windows\\System32\\git.exe\r\n"
    );

    existsSyncMock.mockImplementation((p) => {
      const s = String(p).replace(/\//g, "\\");
      return s.endsWith("\\Program Files\\Git\\bin\\bash.exe");
    });

    const bash = findGitBash();
    expect(bash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("findGitBash ignores WSL bash.exe and falls back to git-derived locations", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];

    execSyncMock.mockImplementation((cmd) => {
      if (String(cmd).toLowerCase().includes("where bash")) {
        return "C:\\Windows\\System32\\bash.exe\r\n";
      }
      if (String(cmd).toLowerCase().includes("where git")) {
        return "C:\\Program Files\\Git\\cmd\\git.exe\r\n";
      }
      return "";
    });

    existsSyncMock.mockImplementation((p) => {
      const s = String(p).replace(/\//g, "\\");
      return (
        s === "C:\\Windows\\System32\\bash.exe" || s === "C:\\Program Files\\Git\\bin\\bash.exe"
      );
    });

    expect(findGitBash()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("findGitBash prefers git-derived bash.exe over other bash.exe in PATH", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];

    execSyncMock.mockImplementation((cmd) => {
      if (String(cmd).toLowerCase().includes("where bash")) {
        return "C:\\msys64\\usr\\bin\\bash.exe\r\n";
      }
      if (String(cmd).toLowerCase().includes("where git")) {
        return "C:\\Program Files\\Git\\cmd\\git.exe\r\n";
      }
      return "";
    });

    existsSyncMock.mockImplementation((p) => {
      const s = String(p).replace(/\//g, "\\");
      return (
        s === "C:\\msys64\\usr\\bin\\bash.exe" || s === "C:\\Program Files\\Git\\bin\\bash.exe"
      );
    });

    expect(findGitBash()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("findGitBash falls back to default ProgramFiles location even if PATH is missing", () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    process.env.ProgramFiles = "C:\\Program Files";
    delete process.env.ProgramW6432;
    delete process.env["ProgramFiles(x86)"];

    existsSyncMock.mockImplementation((p) => {
      const s = String(p).replace(/\//g, "\\");
      return s === "C:\\Program Files\\Git\\bin\\bash.exe";
    });

    expect(findGitBash()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("enhanceWindowsError appends hint for bash-related errors", () => {
    const msg = enhanceWindowsError("spawn bash.exe ENOENT");
    expect(msg).toContain("Git Bash");
    expect(msg).toContain("CLAUDE_CODE_GIT_BASH_PATH");
  });

  it("enhanceWindowsError appends hint for 'spawn bash ENOENT' errors", () => {
    const msg = enhanceWindowsError("Error: spawn bash ENOENT");
    expect(msg).toContain("Git Bash");
    expect(msg).toContain("CLAUDE_CODE_GIT_BASH_PATH");
  });
});
