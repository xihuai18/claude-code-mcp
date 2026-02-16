import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  it("should return structuredContent for tool results", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "claude_code_session",
        arguments: { action: "list" },
      });
      expect(res).toHaveProperty("structuredContent");
      expect(res.structuredContent).toHaveProperty("sessions");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should expose tool annotations in tools/list", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const claudeCode = listed.tools.find((t) => t.name === "claude_code");
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.annotations).toBeDefined();
      expect(claudeCode?.annotations?.openWorldHint).toBe(true);
      expect(claudeCode?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should declare capabilities consistent with exposed primitives", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.logging).toBeDefined();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeUndefined();
      expect(caps?.completions).toBeUndefined();
      expect(caps?.tasks).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
