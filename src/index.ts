/**
 * claude-code-mcp - MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Usage: npx claude-code-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServerContext } from "./server.js";
import { checkWindowsBashAvailability } from "./utils/windows.js";

async function main(): Promise<void> {
  const serverCwd = process.cwd();
  const ctx = createServerContext(serverCwd);
  const server = ctx.server;
  const sessionManager = ctx.sessionManager;
  const transport = new StdioServerTransport();

  // Handle graceful shutdown (idempotent)
  let closing = false;
  let lastExitCode = 0;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    if (typeof process.stdin.off === "function") {
      process.stdin.off("error", handleStdinError);
    }
    const forceExitMs = process.platform === "win32" ? 10_000 : 5_000;
    const forceExitTimer = setTimeout(() => process.exit(lastExitCode), forceExitMs);
    if (forceExitTimer.unref) forceExitTimer.unref();
    try {
      if (server?.isConnected()) {
        await server.sendLoggingMessage({
          level: "info",
          data: { event: "server_stopping" },
        });
      }
      sessionManager.destroy();
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exitCode = lastExitCode;
    try {
      await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
    } catch {
      // ignore flush errors
    } finally {
      clearTimeout(forceExitTimer);
    }
  };
  function handleStdinError(error: Error) {
    console.error("stdin error:", error);
    lastExitCode = 1;
    void shutdown();
  }
  const handleUnexpectedError = (error: unknown) => {
    console.error("Unhandled runtime error:", error);
    lastExitCode = 1;
    void shutdown();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("beforeExit", () => {
    void shutdown();
  });
  process.on("uncaughtException", handleUnexpectedError);
  process.on("unhandledRejection", handleUnexpectedError);
  // Windows console: Ctrl+Break emits SIGBREAK (unsupported on POSIX).
  if (process.platform === "win32") process.on("SIGBREAK", shutdown);
  if (typeof process.stdin.resume === "function") {
    process.stdin.resume();
  }
  // Keep stdin in Buffer mode for MCP stdio framing.
  // Setting stdin encoding would convert chunks to strings and break the transport parser.
  process.stdin.on("error", handleStdinError);
  // When the MCP client closes stdio, ensure the server exits.
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);

  await server.connect(transport);
  server.sendToolListChanged();
  server.sendResourceListChanged();

  // Check Windows bash.exe availability and warn early
  checkWindowsBashAvailability();

  // Log to MCP notifications (and stderr as a fallback).
  try {
    if (transport && server) {
      await server.sendLoggingMessage({
        level: "info",
        data: { event: "server_started", cwd: serverCwd },
      });
    }
  } catch {
    // ignore logging failures (client may not support logging)
  }
  console.error(`claude-code-mcp server started (transport=stdio, cwd: ${serverCwd})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
