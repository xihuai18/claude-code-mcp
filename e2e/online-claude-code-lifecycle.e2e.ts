import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { connectStdioClient } from "./helpers/stdio.js";
import { pollToTerminal } from "./helpers/poll.js";

const ONLINE = process.env.CLAUDE_CODE_MCP_E2E_ONLINE === "1";

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (close) await close();
  close = null;
});

const onlineTest = ONLINE ? test : test.skip;

onlineTest(
  "online: claude_code can fix a failing node:test project (with interactive permissions)",
  { timeout: 12 * 60_000 },
  async () => {
    const tmpRoot = path.join(os.tmpdir(), `claude-code-mcp-e2e-${Date.now()}`);
    try {
      mkdirSync(tmpRoot, { recursive: true });
      const projectDir = path.join(tmpRoot, "node-test-bug");
      mkdirSync(projectDir, { recursive: true });

      writeFileSync(
        path.join(projectDir, "package.json"),
        JSON.stringify({ name: "node-test-bug", private: true, type: "module" }, null, 2),
        "utf8"
      );
      writeFileSync(
        path.join(projectDir, "sum.js"),
        "export function sum(a, b) { return a - b; }\n",
        "utf8"
      );
      mkdirSync(path.join(projectDir, "test"), { recursive: true });
      writeFileSync(
        path.join(projectDir, "test", "sum.test.js"),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { sum } from '../sum.js';",
          "test('sum', () => { assert.equal(sum(1, 2), 3); });",
          "",
        ].join("\n"),
        "utf8"
      );

      // Sanity: should fail before agent runs
      expect(() =>
        execFileSync(process.execPath, ["--test"], { cwd: projectDir, stdio: "ignore" })
      ).toThrow();

      const conn = await connectStdioClient({ cwd: process.cwd() });
      close = conn.close;

      const started = await conn.client.callTool({
        name: "claude_code",
        arguments: {
          cwd: projectDir,
          maxTurns: 12,
          permissionRequestTimeoutMs: 60_000,
          advanced: { maxBudgetUsd: 1.0 },
          prompt:
            "Goal: make `node --test` pass in this directory. First run `node --test` to reproduce, then make the smallest correct fix, then re-run `node --test` to confirm. Do not add dependencies.",
        },
      });
      const start = started.structuredContent as { sessionId: string; status: string };
      expect(start.status).toBe("running");
      expect(typeof start.sessionId).toBe("string");

      const allow = new Set(["Read", "Write", "Edit", "Grep", "Glob", "Bash"]);
      const policy = (toolName: string) =>
        allow.has(toolName)
          ? { decision: "allow" as const }
          : { decision: "deny" as const, interrupt: false };

      const { final } = await pollToTerminal({
        callTool: async (name, args) => {
          const res = await conn.client.callTool({ name, arguments: args });
          return res.structuredContent ?? res;
        },
        sessionId: start.sessionId,
        policy,
        timeoutMs: 10 * 60_000,
        intervalMs: 600,
      });

      expect(final.status).toBe("idle");
      expect(final.result?.isError).toBe(false);

      // Verify locally: tests pass and code is fixed
      execFileSync(process.execPath, ["--test"], { cwd: projectDir, stdio: "ignore" });
      const fixed = readFileSync(path.join(projectDir, "sum.js"), "utf8");
      expect(fixed).toMatch(/return\s+a\s*\+\s*b/);
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
);
