import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { buildOptions } from "../src/utils/build-options.js";
import { DEFAULT_SETTING_SOURCES } from "../src/types.js";

describe("buildOptions", () => {
  it("normalizes MSYS-style paths on Windows", () => {
    const originalPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const opts = buildOptions({
        cwd: "/d/repo",
        additionalDirectories: ["/mnt/c/dir"],
        debugFile: "/c/tmp/debug.log",
        pathToClaudeCodeExecutable: "/c/cli/cli.js",
      });
      expect(opts.cwd).toBe("D:\\repo");
      expect(opts.additionalDirectories).toEqual(["C:\\dir"]);
      expect(opts.debugFile).toBe("C:\\tmp\\debug.log");
      expect(opts.pathToClaudeCodeExecutable).toBe("C:\\cli\\cli.js");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("defaults settingSources to DEFAULT_SETTING_SOURCES", () => {
    const opts = buildOptions({ cwd: "/tmp" });
    expect(opts.settingSources).toEqual(DEFAULT_SETTING_SOURCES);
  });

  it("preserves explicit settingSources", () => {
    const opts = buildOptions({ cwd: "/tmp", settingSources: ["user"] });
    expect(opts.settingSources).toEqual(["user"]);
  });

  it("does not copy undefined fields (preserves SDK defaults)", () => {
    const opts = buildOptions({
      cwd: "/tmp",
      allowedTools: undefined,
      disallowedTools: undefined,
      strictAllowedTools: undefined,
      model: undefined,
    });
    expect("allowedTools" in opts).toBe(false);
    expect("disallowedTools" in opts).toBe(false);
    expect("strictAllowedTools" in opts).toBe(false);
    expect("model" in opts).toBe(false);
  });

  it("keeps strictAllowedTools out of SDK options", () => {
    const opts = buildOptions({
      cwd: "/tmp",
      allowedTools: ["Read"],
      strictAllowedTools: true,
    });
    expect(opts.allowedTools).toEqual(["Read"]);
    expect("strictAllowedTools" in opts).toBe(false);
  });

  it("merges env with process.env (user values win)", () => {
    vi.stubEnv("BUILD_OPTIONS_TEST", "from-process");
    const opts = buildOptions({
      cwd: "/tmp",
      env: { BUILD_OPTIONS_TEST: "from-user", ONLY_USER: "x" },
    });
    expect(opts.env?.BUILD_OPTIONS_TEST).toBe("from-user");
    expect(opts.env?.ONLY_USER).toBe("x");
  });

  it("passes through SDK 0.2.81 option fields", () => {
    const opts = buildOptions({
      cwd: "/tmp",
      toolConfig: { askUserQuestion: { previewFormat: "html" } },
      agentProgressSummaries: true,
      settings: { model: "claude-sonnet-4-6", permissions: { allow: ["Read(*)"] } },
    });

    expect(opts.toolConfig).toEqual({ askUserQuestion: { previewFormat: "html" } });
    expect(opts.agentProgressSummaries).toBe(true);
    expect(opts.settings).toEqual({
      model: "claude-sonnet-4-6",
      permissions: { allow: ["Read(*)"] },
    });
  });

  it("expands ~ in path fields", () => {
    const originalPlatform = process.platform;
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/test");
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      const opts = buildOptions({
        cwd: "~/repo",
        additionalDirectories: ["~/extra"],
        debugFile: "~/debug.log",
      });
      expect(opts.cwd).toBe("/home/test/repo");
      expect(opts.additionalDirectories).toEqual(["/home/test/extra"]);
      expect(opts.debugFile).toBe("/home/test/debug.log");
    } finally {
      spy.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
