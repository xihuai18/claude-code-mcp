import { spawnSync } from "node:child_process";
import path from "node:path";

function parseArgs(argv) {
  const parsed = {
    iterations: 20,
    pollIntervalMs: 500,
    maxPolls: 20,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
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

function runMode(mode, cfg) {
  const script = path.join("scripts", "e2e", "stdio-cancel-regression.mjs");
  const args = [
    script,
    "--mode",
    mode,
    "--iterations",
    String(cfg.iterations),
    "--poll-interval-ms",
    String(cfg.pollIntervalMs),
    "--max-polls",
    String(cfg.maxPolls),
  ];
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  const endedAt = new Date().toISOString();

  let parsedReport;
  try {
    parsedReport = JSON.parse(result.stdout || "{}");
  } catch {
    parsedReport = {
      parseError: true,
      rawStdout: result.stdout,
    };
  }

  if (result.stderr) process.stderr.write(result.stderr);

  return {
    mode,
    startedAt,
    endedAt,
    exitCode: result.status ?? 1,
    report: parsedReport,
  };
}

function main() {
  const cfg = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  const fastCancel = runMode("fast-cancel", cfg);
  const waitingPermissionCancel = runMode("waiting-permission-cancel", cfg);
  const endedAt = new Date().toISOString();

  const summary = {
    startedAt,
    endedAt,
    iterations: cfg.iterations,
    pollIntervalMs: cfg.pollIntervalMs,
    maxPolls: cfg.maxPolls,
    runs: [fastCancel, waitingPermissionCancel],
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (fastCancel.exitCode !== 0 || waitingPermissionCancel.exitCode !== 0) {
    process.exitCode = 1;
  }
}

main();
