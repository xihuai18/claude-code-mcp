import { afterEach, expect, test } from "vitest";
import { connectStdioClient } from "./helpers/stdio.js";

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (close) await close();
  close = null;
});

test("stdio: list tools/resources + read server-info", async () => {
  const conn = await connectStdioClient({ cwd: process.cwd() });
  close = conn.close;

  const tools = await conn.client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  expect(toolNames).toEqual(
    expect.arrayContaining([
      "claude_code",
      "claude_code_reply",
      "claude_code_check",
      "claude_code_session",
    ])
  );

  const resources = await conn.client.listResources();
  const uris = resources.resources.map((r) => r.uri);
  expect(uris).toEqual(
    expect.arrayContaining([
      "claude-code-mcp:///server-info",
      "claude-code-mcp:///internal-tools",
      "claude-code-mcp:///gotchas",
    ])
  );

  const serverInfo = await conn.client.readResource({ uri: "claude-code-mcp:///server-info" });
  const text = serverInfo.contents?.[0]?.text ?? "";
  const json = JSON.parse(text) as { name?: string; platform?: string; node?: string };
  expect(json.name).toBe("claude-code-mcp");
  expect(typeof json.platform).toBe("string");
  expect(typeof json.node).toBe("string");
});
