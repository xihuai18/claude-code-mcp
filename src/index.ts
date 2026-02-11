/**
 * claude-code-mcp - MCP server entry point
 *
 * Starts the MCP server with stdio transport.
 * Usage: npx claude-code-mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { checkWindowsBashAvailability } from "./utils/windows.js";

async function main(): Promise<void> {
  const serverCwd = process.cwd();
  const server = createServer(serverCwd);
  const transport = new StdioServerTransport();

  // Handle graceful shutdown (idempotent)
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    // Allow stdio to flush before exiting
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);

  // Check Windows bash.exe availability and warn early
  checkWindowsBashAvailability();

  // Log to stderr (stdout is used for MCP communication)
  console.error(`claude-code-mcp server started (cwd: ${serverCwd})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
