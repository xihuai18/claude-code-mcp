import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toEnvRecord } from "./env.js";

export type ConnectedClient = {
  client: Client;
  transport: Transport;
  close: () => Promise<void>;
  stderrText: () => string;
};

function resolveStdioServerParams(): { command: string; args: string[] } {
  if (process.env.CLAUDE_CODE_MCP_E2E_USE_NPX === "1") {
    return { command: "npx", args: ["-y", "@leo000001/claude-code-mcp"] };
  }
  return { command: process.execPath, args: ["dist/index.js"] };
}

export async function connectStdioClient(opts?: { cwd?: string }): Promise<ConnectedClient> {
  const { command, args } = resolveStdioServerParams();
  const env = toEnvRecord(process.env);

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: opts?.cwd,
    env,
    stderr: "pipe",
  });

  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const client = new Client(
    {
      name: "claude-code-mcp-e2e",
      version: "0.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    }
  );

  await client.connect(transport);

  return {
    client,
    transport,
    close: async () => {
      try {
        await transport.close();
      } catch {
        // ignore close errors
      }
    },
    stderrText: () => stderrChunks.join(""),
  };
}
