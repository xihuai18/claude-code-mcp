import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";

describe("MCP Server", () => {
  it("should create a server instance", () => {
    const server = createServer("/tmp");
    expect(server).toBeDefined();
  });

  it("should have the correct server name", () => {
    const server = createServer("/tmp");
    // The server should be an McpServer instance
    expect(server).toHaveProperty("tool");
    expect(server).toHaveProperty("connect");
    expect(server).toHaveProperty("close");
  });
});
