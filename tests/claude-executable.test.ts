import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CLAUDE_COMMAND_ENV,
  DEFAULT_CLAUDE_PATH_ENV,
  resolveDefaultClaudeExecutable,
} from "../src/utils/claude-executable.js";

function createExecutableFixture(commandName: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-exec-"));
  const fileName = process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") chmodSync(filePath, 0o755);
  return { dir, filePath };
}

describe("claude executable resolution", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("auto-detects claude before claude-internal", () => {
    const first = createExecutableFixture("claude");
    const second = createExecutableFixture("claude-internal");
    try {
      process.env = {
        ...originalEnv,
        PATH: [first.dir, second.dir].join(path.delimiter),
      };
      delete process.env[DEFAULT_CLAUDE_COMMAND_ENV];
      delete process.env[DEFAULT_CLAUDE_PATH_ENV];

      const resolved = resolveDefaultClaudeExecutable();
      expect(resolved.source).toBe("auto_claude");
      expect(resolved.command).toBe("claude");
      expect(resolved.resolvedPath).toBe(path.normalize(first.filePath));
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("auto-detects claude-internal when claude is absent", () => {
    const fixture = createExecutableFixture("claude-internal");
    try {
      process.env = {
        ...originalEnv,
        PATH: fixture.dir,
      };
      delete process.env[DEFAULT_CLAUDE_COMMAND_ENV];
      delete process.env[DEFAULT_CLAUDE_PATH_ENV];

      const resolved = resolveDefaultClaudeExecutable();
      expect(resolved.source).toBe("auto_claude_internal");
      expect(resolved.command).toBe("claude-internal");
      expect(resolved.resolvedPath).toBe(path.normalize(fixture.filePath));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses the exact configured command when DEFAULT_CLAUDE_COMMAND is set", () => {
    const first = createExecutableFixture("claude");
    const second = createExecutableFixture("claude-internal");
    try {
      process.env = {
        ...originalEnv,
        PATH: [first.dir, second.dir].join(path.delimiter),
        [DEFAULT_CLAUDE_COMMAND_ENV]: "claude-internal",
      };
      delete process.env[DEFAULT_CLAUDE_PATH_ENV];

      const resolved = resolveDefaultClaudeExecutable();
      expect(resolved.source).toBe("env_command");
      expect(resolved.command).toBe("claude-internal");
      expect(resolved.resolvedPath).toBe(path.normalize(second.filePath));
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("uses the configured filesystem path when DEFAULT_CLAUDE_PATH is set", () => {
    const fixture = createExecutableFixture("claude-internal");
    try {
      process.env = {
        ...originalEnv,
        PATH: "",
        [DEFAULT_CLAUDE_PATH_ENV]: fixture.filePath,
      };
      delete process.env[DEFAULT_CLAUDE_COMMAND_ENV];

      const resolved = resolveDefaultClaudeExecutable();
      expect(resolved.source).toBe("env_path");
      expect(resolved.resolvedPath).toBe(path.normalize(fixture.filePath));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("throws when command and path env vars are both set", () => {
    process.env = {
      ...originalEnv,
      [DEFAULT_CLAUDE_COMMAND_ENV]: "claude",
      [DEFAULT_CLAUDE_PATH_ENV]: path.join(process.cwd(), "claude.cmd"),
    };

    expect(() => resolveDefaultClaudeExecutable()).toThrow("mutually exclusive");
  });

  it("rejects command env values with path separators", () => {
    process.env = {
      ...originalEnv,
      [DEFAULT_CLAUDE_COMMAND_ENV]: "./claude-internal",
    };

    expect(() => resolveDefaultClaudeExecutable()).toThrow("must be a command name");
  });

  it("rejects non-executable DEFAULT_CLAUDE_PATH files on POSIX", () => {
    if (process.platform === "win32") return;

    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-exec-nonexec-"));
    const filePath = path.join(dir, "claude-internal");
    writeFileSync(filePath, "#!/bin/sh\n", "utf8");
    chmodSync(filePath, 0o644);
    try {
      process.env = {
        ...originalEnv,
        [DEFAULT_CLAUDE_PATH_ENV]: filePath,
      };
      delete process.env[DEFAULT_CLAUDE_COMMAND_ENV];

      expect(() => resolveDefaultClaudeExecutable()).toThrow(
        "does not point to an executable file"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to SDK bundled when nothing is configured or detected", () => {
    process.env = {
      ...originalEnv,
      PATH: "",
    };
    delete process.env[DEFAULT_CLAUDE_COMMAND_ENV];
    delete process.env[DEFAULT_CLAUDE_PATH_ENV];

    const resolved = resolveDefaultClaudeExecutable();
    expect(resolved.source).toBe("sdk_bundled");
    expect(resolved.resolvedPath).toBeUndefined();
  });
});
