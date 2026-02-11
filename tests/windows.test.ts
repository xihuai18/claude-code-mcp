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

  it("enhanceWindowsError appends hint for bash-related errors", () => {
    const msg = enhanceWindowsError("spawn bash.exe ENOENT");
    expect(msg).toContain("Git Bash");
    expect(msg).toContain("CLAUDE_CODE_GIT_BASH_PATH");
  });
});
