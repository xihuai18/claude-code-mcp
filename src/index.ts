/**
 * claude-code-mcp - MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Usage: npx claude-code-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServerContext } from "./server.js";
import { isBenignRuntimeError } from "./utils/runtime-errors.js";
import { decideStdinShutdown } from "./utils/stdin-shutdown.js";
import { checkWindowsBashAvailability } from "./utils/windows.js";

const STDIN_SHUTDOWN_CHECK_MS = 750;
const STDIN_SHUTDOWN_MAX_WAIT_MS = process.platform === "win32" ? 15_000 : 10_000;

function summarizeSessions(ctx: ReturnType<typeof createServerContext>): {
  total: number;
  running: number;
  waitingPermission: number;
  terminal: number;
} {
  const sessions = ctx.sessionManager.list();
  const running = sessions.filter((s) => s.status === "running").length;
  const waitingPermission = sessions.filter((s) => s.status === "waiting_permission").length;
  return {
    total: sessions.length,
    running,
    waitingPermission,
    terminal: sessions.length - running - waitingPermission,
  };
}

async function main(): Promise<void> {
  const serverCwd = process.cwd();
  const ctx = createServerContext(serverCwd);
  const server = ctx.server;
  const sessionManager = ctx.sessionManager;
  const transport = new StdioServerTransport();

  // Handle graceful shutdown (idempotent)
  let closing = false;
  let lastExitCode = 0;
  let stdinClosedAt: number | undefined;
  let stdinClosedReason: "end" | "close" | undefined;
  let stdinShutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const onStdinEnd = () => handleStdinTerminated("end");
  const onStdinClose = () => handleStdinTerminated("close");

  const clearStdinShutdownTimer = () => {
    if (stdinShutdownTimer) {
      clearTimeout(stdinShutdownTimer);
      stdinShutdownTimer = undefined;
    }
  };

  const shutdown = async (reason = "unknown") => {
    if (closing) return;
    closing = true;
    clearStdinShutdownTimer();
    if (typeof process.stdin.off === "function") {
      process.stdin.off("error", handleStdinError);
      process.stdin.off("end", onStdinEnd);
      process.stdin.off("close", onStdinClose);
    }
    const forceExitMs = process.platform === "win32" ? 10_000 : 5_000;
    const forceExitTimer = setTimeout(() => process.exit(lastExitCode), forceExitMs);
    if (forceExitTimer.unref) forceExitTimer.unref();
    const sessionSummary = summarizeSessions(ctx);
    try {
      if (server?.isConnected()) {
        await server.sendLoggingMessage({
          level: "info",
          data: { event: "server_stopping", reason, ...sessionSummary },
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
    void shutdown("stdin_error");
  }

  function hasActiveSessions(): boolean {
    return sessionManager
      .list()
      .some((s) => s.status === "running" || s.status === "waiting_permission");
  }

  const evaluateStdinTermination = () => {
    if (closing || stdinClosedAt === undefined) return;

    const stdinUnavailable =
      process.stdin.destroyed || process.stdin.readableEnded || !process.stdin.readable;
    const elapsedMs = Date.now() - stdinClosedAt;
    const active = hasActiveSessions();
    const connected = server.isConnected();
    const decision = decideStdinShutdown({
      stdinUnavailable,
      elapsedMs,
      maxWaitMs: STDIN_SHUTDOWN_MAX_WAIT_MS,
      hasActiveSessions: active,
      isConnected: connected,
    });
    if (decision === "clear") {
      // Defensive: if the stream recovered, drop this shutdown attempt.
      stdinClosedAt = undefined;
      stdinClosedReason = undefined;
      return;
    }
    if (decision === "shutdown_now") {
      void shutdown(`stdin_${stdinClosedReason ?? "closed"}`);
      return;
    }
    if (decision === "shutdown_timeout") {
      // Last-resort shutdown: stdio is gone and transport is disconnected.
      void shutdown(`stdin_${stdinClosedReason ?? "closed"}_timeout`);
      return;
    }
    stdinShutdownTimer = setTimeout(evaluateStdinTermination, STDIN_SHUTDOWN_CHECK_MS);
    if (stdinShutdownTimer.unref) stdinShutdownTimer.unref();
  };

  function handleStdinTerminated(event: "end" | "close") {
    if (closing) return;
    if (stdinClosedAt === undefined) {
      stdinClosedAt = Date.now();
      stdinClosedReason = event;
      console.error(`[lifecycle] stdin ${event} observed; entering guarded shutdown checks`);
    }
    clearStdinShutdownTimer();
    stdinShutdownTimer = setTimeout(evaluateStdinTermination, STDIN_SHUTDOWN_CHECK_MS);
    if (stdinShutdownTimer.unref) stdinShutdownTimer.unref();
  }

  const handleUnexpectedError = (error: unknown) => {
    if (isBenignRuntimeError(error)) {
      console.error("Ignored benign runtime abort:", error);
      return;
    }
    console.error("Unhandled runtime error:", error);
    lastExitCode = 1;
    void shutdown("runtime_error");
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGHUP", () => {
    void shutdown("SIGHUP");
  });
  process.on("beforeExit", () => {
    // Do not eagerly shutdown while transport still appears connected.
    // Some runtimes can emit beforeExit during transient idle windows.
    if (!server.isConnected()) {
      void shutdown("beforeExit");
    }
  });
  process.on("uncaughtException", handleUnexpectedError);
  process.on("unhandledRejection", handleUnexpectedError);
  // Windows console: Ctrl+Break emits SIGBREAK (unsupported on POSIX).
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => {
      void shutdown("SIGBREAK");
    });
  }
  if (typeof process.stdin.resume === "function") {
    process.stdin.resume();
  }
  // Keep stdin in Buffer mode for MCP stdio framing.
  // Setting stdin encoding would convert chunks to strings and break the transport parser.
  process.stdin.on("error", handleStdinError);
  // Guarded shutdown: some clients can transiently trigger stdio close-like signals.
  // We only exit after checking connection/session state.
  process.stdin.on("end", onStdinEnd);
  process.stdin.on("close", onStdinClose);

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
