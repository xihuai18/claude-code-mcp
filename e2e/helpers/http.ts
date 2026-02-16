import { spawn } from "node:child_process";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toEnvRecord } from "./env.js";

export type HttpServerHandle = {
  port: number;
  url: string;
  proc: ReturnType<typeof spawn>;
  stderrText: () => string;
  close: () => Promise<void>;
};

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function pickFreePort(range?: { from: number; to: number }): Promise<number> {
  const from = range?.from ?? 31000;
  const to = range?.to ?? 39999;
  for (let i = 0; i < 50; i++) {
    const port = from + Math.floor(Math.random() * (to - from + 1));
    if (await isPortFree(port)) return port;
  }
  for (let port = from; port <= to; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${from}-${to}`);
}

async function waitForTcp(
  port: number,
  timeoutMs: number,
  proc: ReturnType<typeof spawn>,
  stderrText: () => string
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (proc.exitCode != null || proc.signalCode != null) {
      throw new Error(
        `HTTP server exited before binding 127.0.0.1:${port} (exit=${proc.exitCode}, signal=${proc.signalCode}). stderr:\n${stderrText()}`
      );
    }
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for tcp://127.0.0.1:${port}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function startHttpServer(opts?: {
  cwd?: string;
  port?: number;
}): Promise<HttpServerHandle> {
  const port = opts?.port ?? (await pickFreePort());
  const useNpx = process.env.CLAUDE_CODE_MCP_E2E_USE_NPX === "1";
  const command = useNpx ? "npx" : process.execPath;
  const args = useNpx ? ["-y", "@leo000001/claude-code-mcp"] : ["dist/index.js"];
  const env = {
    ...toEnvRecord(process.env),
    CLAUDE_CODE_MCP_TRANSPORT: "http",
    CLAUDE_CODE_MCP_HTTP_PORT: String(port),
  };

  const stderrChunks: string[] = [];
  const proc = spawn(command, args, {
    cwd: opts?.cwd,
    env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  await waitForTcp(port, 15_000, proc, () => stderrChunks.join(""));

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    proc,
    stderrText: () => stderrChunks.join(""),
    close: async () => {
      if (proc.exitCode != null) return;
      try {
        proc.kill();
      } catch {
        // ignore kill errors
      }
      await new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    },
  };
}

export async function connectHttpClient(serverUrl: string): Promise<{
  client: Client;
  transport: Transport;
  close: () => Promise<void>;
}> {
  const client = new Client(
    { name: "claude-code-mcp-e2e", version: "0.0.0" },
    { capabilities: { logging: {} } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
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
  };
}
