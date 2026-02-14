import { describe, it, expect } from "vitest";
import {
  TOOL_CATALOG,
  ToolDiscoveryCache,
  buildInternalToolsDescription,
  discoverToolsFromInit,
  mergeToolLists,
} from "../src/tools/tool-discovery.js";

describe("tool-discovery", () => {
  it("discoverToolsFromInit maps descriptions and preserves unknown tools", () => {
    const tools = discoverToolsFromInit(["Read", "UnknownTool", "Read"]);
    expect(tools.find((t) => t.name === "Read")?.description).toBe(TOOL_CATALOG.Read.description);
    expect(tools.find((t) => t.name === "UnknownTool")?.description).toBe("UnknownTool");
  });

  it("ToolDiscoveryCache starts from catalog and updates from init.tools", () => {
    const cache = new ToolDiscoveryCache();
    const initial = cache.getTools().map((t) => t.name);
    expect(initial.length).toBeGreaterThan(0);

    const { updated, tools } = cache.updateFromInit(["Read", "Write", "UnknownTool"]);
    expect(updated).toBe(true);
    expect(tools.map((t) => t.name)).toContain("UnknownTool");

    const second = cache.updateFromInit(["Read", "Write", "UnknownTool"]);
    expect(second.updated).toBe(false);
  });

  it("mergeToolLists prefers primary entries", () => {
    const merged = mergeToolLists(
      [{ name: "Read", description: "PRIMARY", category: "file_read" }],
      [{ name: "Read", description: "FALLBACK", category: "file_read" }]
    );
    expect(merged.find((t) => t.name === "Read")?.description).toBe("PRIMARY");
  });

  it("buildInternalToolsDescription includes guidance about includeTools and claude_code_check", () => {
    const desc = buildInternalToolsDescription([{ name: "Read", description: "Read files." }]);
    expect(desc).toContain("claude_code_check");
    expect(desc).toContain("includeTools=true");
  });
});
