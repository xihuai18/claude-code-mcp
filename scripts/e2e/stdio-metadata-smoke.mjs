import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

function transportConfig() {
  return {
    command: process.execPath,
    args: [path.join("dist", "index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: process.env,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function getTextContent(result) {
  const content = result?.contents?.[0];
  return content && "text" in content && typeof content.text === "string" ? content.text : "";
}

async function main() {
  const transport = new StdioClientTransport(transportConfig());
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
  }

  const client = new Client({ name: "stdio-metadata-smoke", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    const claudeCode = listed.tools.find((tool) => tool.name === "claude_code");
    const claudeCodeCheck = listed.tools.find((tool) => tool.name === "claude_code_check");

    assert(toolNames.includes("claude_code"), "claude_code tool missing");
    assert(toolNames.includes("claude_code_reply"), "claude_code_reply tool missing");
    assert(toolNames.includes("claude_code_session"), "claude_code_session tool missing");
    assert(toolNames.includes("claude_code_check"), "claude_code_check tool missing");
    assert(
      claudeCode?.description?.includes("No final result is returned here"),
      "claude_code description lost async result guidance"
    );
    assert(
      claudeCodeCheck?.description?.includes("respond_user_input is not supported"),
      "claude_code_check description lost unsupported flow guidance"
    );

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    assert(resourceUris.includes("claude-code-mcp:///quickstart"), "quickstart resource missing");
    assert(resourceUris.includes("claude-code-mcp:///gotchas"), "gotchas resource missing");
    assert(resourceUris.includes("claude-code-mcp:///compat-report"), "compat-report resource missing");

    const quickstartText = getTextContent(
      await client.readResource({ uri: "claude-code-mcp:///quickstart" })
    );
    const gotchasText = getTextContent(await client.readResource({ uri: "claude-code-mcp:///gotchas" }));
    const compatText = getTextContent(
      await client.readResource({ uri: "claude-code-mcp:///compat-report" })
    );
    const compat = JSON.parse(compatText || "{}");

    assert(quickstartText.includes("Persist these client-side"), "quickstart missing stored-state guidance");
    assert(quickstartText.includes("nextCursor"), "quickstart missing nextCursor guidance");
    assert(
      quickstartText.includes("respond_permission"),
      "quickstart missing permission-response guidance"
    );
    assert(gotchasText.includes("Severity:"), "gotchas missing structured severity guidance");
    assert(gotchasText.includes("Remedy:"), "gotchas missing remedy guidance");
    assert(Array.isArray(compat.guidance), "compat-report guidance missing");
    assert(
      compat.guidance.some((item) =>
        typeof item === "string" && item.includes("README-level documentation is visible")
      ),
      "compat-report missing model-visibility guidance"
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          toolCount: listed.tools.length,
          resourceCount: resources.resources.length,
          checked: {
            toolDescriptions: ["claude_code", "claude_code_check"],
            resources: ["quickstart", "gotchas", "compat-report"],
          },
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
