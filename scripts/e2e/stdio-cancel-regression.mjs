import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

function parseArgs(argv) {
  const parsed = {
    mode: "fast-cancel",
    iterations: 20,
    pollIntervalMs: 500,
    maxPolls: 20,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      parsed.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--iterations" && argv[i + 1]) {
      parsed.iterations = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--poll-interval-ms" && argv[i + 1]) {
      parsed.pollIntervalMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--max-polls" && argv[i + 1]) {
      parsed.maxPolls = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseToolResponse(res) {
  if (res?.structuredContent && typeof res.structuredContent === "object") {
    return res.structuredContent;
  }
  const text = res?.content?.[0]?.text;
  if (typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function transportConfig() {
  return {
    command: process.execPath,
    args: [path.join("dist", "index.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: process.env,
  };
}

function startArguments(mode) {
  const base = {
    maxTurns: 5,
    advanced: {
      maxBudgetUsd: 0.15,
      sessionInitTimeoutMs: 15_000,
    },
  };

  if (mode === "waiting-permission-cancel") {
    return {
      ...base,
      prompt:
        "Create wp_cancel_probe.txt, then run a shell command to print the file path. Keep working until stopped.",
      cwd: process.cwd(),
    };
  }

  return {
    ...base,
    prompt: "Say one sentence and wait for follow-up instructions.",
  };
}

async function pollUntilWaitingOrTerminal(client, sessionId, options) {
  let cursor;
  for (let i = 0; i < options.maxPolls; i += 1) {
    const polled = parseToolResponse(
      await client.callTool({
        name: "claude_code_check",
        arguments: { action: "poll", sessionId, cursor, responseMode: "minimal" },
      })
    );
    if (typeof polled.nextCursor === "number") cursor = polled.nextCursor;
    if (
      polled.status === "waiting_permission" ||
      polled.status === "idle" ||
      polled.status === "error" ||
      polled.status === "cancelled"
    ) {
      return { polled, cursor, polls: i + 1 };
    }
    await sleep(options.pollIntervalMs);
  }
  return { polled: undefined, cursor, polls: options.maxPolls };
}

async function runIteration(client, i, config) {
  const startedAt = new Date().toISOString();
  const record = {
    iteration: i + 1,
    startedAt,
    mode: config.mode,
  };

  const started = parseToolResponse(
    await client.callTool({
      name: "claude_code",
      arguments: startArguments(config.mode),
    })
  );
  record.start = started;

  if (started.status !== "running" || typeof started.sessionId !== "string" || !started.sessionId) {
    record.failed = true;
    record.failureStep = "start";
    record.endedAt = new Date().toISOString();
    return record;
  }

  const sessionId = started.sessionId;
  let cursor;
  if (config.mode === "waiting-permission-cancel") {
    const polled = await pollUntilWaitingOrTerminal(client, sessionId, config);
    record.preCancelPoll = polled;
    cursor = polled.cursor;
  }

  record.cancel = parseToolResponse(
    await client.callTool({
      name: "claude_code_session",
      arguments: { action: "cancel", sessionId },
    })
  );
  record.pollAfterCancel = parseToolResponse(
    await client.callTool({
      name: "claude_code_check",
      arguments: { action: "poll", sessionId, cursor, responseMode: "full" },
    })
  );
  record.sessionListAfterCancel = parseToolResponse(
    await client.callTool({
      name: "claude_code_session",
      arguments: { action: "list" },
    })
  );
  const resources = await client.listResources();
  record.resourcesAfterCancel = resources.resources.map((r) => r.uri);
  record.failed = false;
  record.endedAt = new Date().toISOString();
  return record;
}

async function main() {
  const cfg = parseArgs(process.argv);
  const transport = new StdioClientTransport(transportConfig());
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
  }

  const client = new Client(
    { name: "stdio-cancel-regression", version: "0.0.0" },
    { capabilities: {} }
  );
  const report = {
    startedAt: new Date().toISOString(),
    mode: cfg.mode,
    iterations: cfg.iterations,
    maxPolls: cfg.maxPolls,
    pollIntervalMs: cfg.pollIntervalMs,
    records: [],
    failedAt: undefined,
    fatal: undefined,
  };

  try {
    await client.connect(transport);
    for (let i = 0; i < cfg.iterations; i += 1) {
      try {
        const record = await runIteration(client, i, cfg);
        report.records.push(record);
        if (record.failed) {
          report.failedAt = i + 1;
          break;
        }
      } catch (error) {
        report.records.push({
          iteration: i + 1,
          failed: true,
          failureStep: "iteration",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          endedAt: new Date().toISOString(),
        });
        report.failedAt = i + 1;
        break;
      }
    }
  } catch (error) {
    report.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    report.endedAt = new Date().toISOString();
    try {
      await client.close();
    } catch {
      // Ignore shutdown errors in reporting script.
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.fatal || report.failedAt) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(message);
  process.exitCode = 1;
});
