import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const CASES = [
  "running-interrupt",
  "running-cancel",
  "waiting-permission-interrupt",
  "waiting-permission-cancel",
];

function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const parsed = {
    caseName: process.env.npm_config_case ?? "all",
    iterations: parsePositiveIntEnv("npm_config_iterations", 5),
    pollIntervalMs: parsePositiveIntEnv("npm_config_poll_interval_ms", 500),
    maxPolls: parsePositiveIntEnv("npm_config_max_polls", 40),
    startRetries: parsePositiveIntEnv("npm_config_start_retries", 3),
    startRetryDelayMs: parsePositiveIntEnv("npm_config_start_retry_delay_ms", 750),
    waitingAttempts: parsePositiveIntEnv("npm_config_waiting_attempts", 3),
  };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--case" && argv[i + 1]) {
      parsed.caseName = argv[i + 1];
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
      continue;
    }
    if (arg === "--start-retries" && argv[i + 1]) {
      parsed.startRetries = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--start-retry-delay-ms" && argv[i + 1]) {
      parsed.startRetryDelayMs = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg === "--waiting-attempts" && argv[i + 1]) {
      parsed.waitingAttempts = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (!arg.startsWith("--")) positional.push(arg);
  }

  // npm can forward extra args as bare positional values in some shells, e.g.:
  // `node ... --case all 1 running-cancel`
  // Keep this fallback so `npm run ... -- --iterations 1 --case running-cancel` remains usable.
  for (const token of positional) {
    const maybeInt = Number.parseInt(token, 10);
    if (Number.isFinite(maybeInt) && String(maybeInt) === token && maybeInt > 0) {
      parsed.iterations = maybeInt;
      continue;
    }
    const lower = token.toLowerCase();
    if (lower === "all" || CASES.includes(lower)) {
      parsed.caseName = lower;
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

function startArguments(caseName) {
  const isWaitingCase = caseName.startsWith("waiting-permission");
  const cwd = process.cwd();
  const base = {
    maxTurns: isWaitingCase ? 10 : 6,
    advanced: {
      maxBudgetUsd: 0.2,
      sessionInitTimeoutMs: 30_000,
    },
    permissionRequestTimeoutMs: 120_000,
  };

  if (isWaitingCase) {
    return {
      ...base,
      prompt:
        "Use the Read tool with file_path exactly \"package.json\" to inspect this project, then summarize the scripts section in one sentence. Do not answer from memory; read the file first.",
      cwd,
    };
  }

  return {
    ...base,
    prompt: "Say one sentence and wait for follow-up instructions.",
  };
}

function expectedAction(caseName) {
  return caseName.endsWith("interrupt") ? "interrupt" : "cancel";
}

function isTerminalStatus(status) {
  return status === "idle" || status === "error" || status === "cancelled";
}

function extractErrorCode(value) {
  const textCandidates = [];
  if (value && typeof value === "object") {
    if (typeof value.error === "string") textCandidates.push(value.error);
    if (typeof value.message === "string") textCandidates.push(value.message);
    if (typeof value.result === "string") textCandidates.push(value.result);
    if (typeof value.rawText === "string") textCandidates.push(value.rawText);
  } else if (typeof value === "string") {
    textCandidates.push(value);
  }
  for (const text of textCandidates) {
    const m = text.match(/Error \[([A-Z_]+)\]/);
    if (m) return m[1];
    if (text.includes("SESSION_BUSY")) return "SESSION_BUSY";
    if (text.includes("CANCELLED")) return "CANCELLED";
  }
  return undefined;
}

function summarizeSessions(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter((session) => session && typeof session === "object")
    .map((session) => ({
      sessionId: typeof session.sessionId === "string" ? session.sessionId : undefined,
      status: typeof session.status === "string" ? session.status : undefined,
      pendingPermissionCount:
        typeof session.pendingPermissionCount === "number" ? session.pendingPermissionCount : 0,
      eventCount: typeof session.eventCount === "number" ? session.eventCount : 0,
      currentCursor: typeof session.currentCursor === "number" ? session.currentCursor : undefined,
      lastError: typeof session.lastError === "string" ? session.lastError : undefined,
      cancelledAt: typeof session.cancelledAt === "string" ? session.cancelledAt : undefined,
    }));
}

function summarizeSessionPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const sessions = summarizeSessions(payload.sessions);
  const maxSessions = 8;
  return {
    message: typeof payload.message === "string" ? payload.message : undefined,
    totalSessions: sessions.length,
    sessions: sessions.slice(Math.max(0, sessions.length - maxSessions)),
  };
}

function hasToolUseEvent(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  for (const event of events) {
    const message = event?.data?.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    if (content.some((entry) => entry && entry.type === "tool_use")) {
      return true;
    }
  }
  return false;
}

function hasPermissionDenials(result) {
  const denials = result?.permissionDenials;
  return Array.isArray(denials) && denials.length > 0;
}

function summarizeWaitProbe(waitResult) {
  const result = waitResult?.polled?.result;
  const denials = Array.isArray(result?.permissionDenials) ? result.permissionDenials.length : 0;
  return {
    polls: waitResult?.polls,
    cursor: waitResult?.cursor,
    status: waitResult?.polled?.status,
    nextCursor: waitResult?.polled?.nextCursor,
    sawToolUse: !!waitResult?.sawToolUse,
    sawPermissionDenials: !!waitResult?.sawPermissionDenials,
    permissionDenials: denials,
    resultIsError: result?.isError === true,
  };
}

async function pollUntil(client, sessionId, options, predicate) {
  let cursor;
  let sawToolUse = false;
  let sawPermissionDenials = false;
  for (let i = 0; i < options.maxPolls; i += 1) {
    const polled = parseToolResponse(
      await client.callTool({
        name: "claude_code_check",
        arguments: { action: "poll", sessionId, cursor, responseMode: "minimal" },
      })
    );
    if (typeof polled.nextCursor === "number") cursor = polled.nextCursor;
    if (hasToolUseEvent(polled.events)) sawToolUse = true;
    if (hasPermissionDenials(polled.result)) sawPermissionDenials = true;
    if (predicate(polled)) {
      return { polled, cursor, polls: i + 1, sawToolUse, sawPermissionDenials };
    }
    await sleep(options.pollIntervalMs);
  }
  return { polled: undefined, cursor, polls: options.maxPolls, sawToolUse, sawPermissionDenials };
}

async function startSessionWithRetry(client, caseName, config) {
  const attempts = [];
  const maxRetries = Math.max(1, config.startRetries);
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    let started;
    try {
      started = parseToolResponse(
        await client.callTool({
          name: "claude_code",
          arguments: startArguments(caseName),
        })
      );
    } catch (error) {
      started = {
        sessionId: "",
        status: "error",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    attempts.push(started);
    const sessionId = typeof started.sessionId === "string" ? started.sessionId : "";
    if (started.status === "running" && sessionId) {
      return { start: started, attempts, startAttempt: attempt };
    }

    const errorCode = extractErrorCode(started);
    const retryable = errorCode === "TIMEOUT";
    if (!retryable || attempt >= maxRetries) {
      return { start: started, attempts, startAttempt: attempt };
    }
    await sleep(config.startRetryDelayMs * attempt);
  }
  return { start: attempts[attempts.length - 1], attempts, startAttempt: attempts.length };
}

async function cancelSessionBestEffort(client, sessionId) {
  const cleanup = {
    sessionId,
    cancelled: undefined,
    polled: undefined,
    error: undefined,
  };
  try {
    cleanup.cancelled = summarizeSessionPayload(
      parseToolResponse(
        await client.callTool({
          name: "claude_code_session",
          arguments: { action: "cancel", sessionId },
        })
      )
    );
    cleanup.polled = parseToolResponse(
      await client.callTool({
        name: "claude_code_check",
        arguments: { action: "poll", sessionId, responseMode: "minimal" },
      })
    );
  } catch (error) {
    cleanup.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return cleanup;
}

async function ensureWaitingPermission(client, caseName, config) {
  const attempts = [];
  const totalAttempts = Math.max(1, config.waitingAttempts);
  let autoApprovalLikeCount = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const started = await startSessionWithRetry(client, caseName, config);
    const attemptRecord = {
      attempt,
      startAttempt: started.startAttempt,
      startAttempts: started.attempts,
      waitProbe: undefined,
      cleanup: undefined,
    };

    const start = started.start;
    const sessionId = typeof start.sessionId === "string" ? start.sessionId : "";
    if (start.status !== "running" || !sessionId) {
      attempts.push(attemptRecord);
      continue;
    }

    const waitResult = await pollUntil(
      client,
      sessionId,
      config,
      (polled) => polled?.status === "waiting_permission" || isTerminalStatus(polled?.status)
    );
    attemptRecord.waitProbe = summarizeWaitProbe(waitResult);
    attempts.push(attemptRecord);

    if (waitResult.polled?.status === "waiting_permission") {
      return {
        ok: true,
        sessionId,
        cursor: waitResult.cursor,
        start,
        attempts,
      };
    }

    const status = waitResult.polled?.status;
    const seemsAutoApprovalLike =
      isTerminalStatus(status) && waitResult.sawToolUse && !waitResult.sawPermissionDenials;
    if (seemsAutoApprovalLike) {
      autoApprovalLikeCount += 1;
    }

    if (status === "running" || status === "waiting_permission" || !status) {
      attemptRecord.cleanup = await cancelSessionBestEffort(client, sessionId);
    } else {
      attemptRecord.cleanup = {
        skipped: true,
        reason: `Session ended with status '${status}' before waiting_permission was observed.`,
      };
    }
  }

  return {
    ok: false,
    autoApprovalLikely: autoApprovalLikeCount > 0,
    attempts,
  };
}

async function cleanupRunningSessions(client) {
  const result = { cancelled: [], poll: [], errors: [] };
  try {
    const listed = parseToolResponse(
      await client.callTool({ name: "claude_code_session", arguments: { action: "list" } })
    );
    const sessions = Array.isArray(listed.sessions) ? listed.sessions : [];
    for (const session of sessions) {
      if (!session || typeof session !== "object") continue;
      const sessionId = typeof session.sessionId === "string" ? session.sessionId : undefined;
      const status = typeof session.status === "string" ? session.status : undefined;
      if (!sessionId) continue;
      if (status !== "running" && status !== "waiting_permission") continue;
      try {
        const cancelled = await cancelSessionBestEffort(client, sessionId);
        result.cancelled.push(cancelled);
      } catch (error) {
        result.errors.push({
          sessionId,
          stage: "cancel",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
      try {
        const polled = parseToolResponse(
          await client.callTool({
            name: "claude_code_check",
            arguments: { action: "poll", sessionId, responseMode: "minimal" },
          })
        );
        result.poll.push({ sessionId, polled });
      } catch (error) {
        result.errors.push({
          sessionId,
          stage: "poll",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  } catch (error) {
    result.errors.push({
      stage: "list",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
  return result;
}

async function runCaseIteration(client, caseName, iteration, config) {
  const startedAt = new Date().toISOString();
  const record = {
    caseName,
    iteration: iteration + 1,
    startedAt,
  };

  let sessionId;
  let cursor;

  if (caseName.startsWith("waiting-permission")) {
    const waitingSetup = await ensureWaitingPermission(client, caseName, config);
    record.waitingSetup = waitingSetup;
    if (!waitingSetup.ok || !waitingSetup.sessionId) {
      if (waitingSetup.autoApprovalLikely) {
        record.waitingFallback = {
          reason:
            "waiting_permission not observed; runtime appears to auto-approve tool calls. Falling back to running-state race.",
        };
        const fallbackCase = caseName.endsWith("interrupt")
          ? "running-interrupt"
          : "running-cancel";
        const fallbackStart = await startSessionWithRetry(client, fallbackCase, config);
        record.startAttempts = fallbackStart.attempts;
        record.start = fallbackStart.start;
        const fallbackSessionId =
          typeof fallbackStart.start?.sessionId === "string" ? fallbackStart.start.sessionId : "";
        if (fallbackStart.start.status !== "running" || !fallbackSessionId) {
          record.failed = true;
          record.failureStep = "start_fallback";
          record.endedAt = new Date().toISOString();
          return record;
        }
        sessionId = fallbackSessionId;
      } else {
        record.failed = true;
        record.failureStep = "waiting_permission_not_observed";
        record.endedAt = new Date().toISOString();
        return record;
      }
    } else {
      record.start = waitingSetup.start;
      sessionId = waitingSetup.sessionId;
      cursor = waitingSetup.cursor;
    }
  } else {
    const started = await startSessionWithRetry(client, caseName, config);
    record.startAttempts = started.attempts;
    record.start = started.start;
    const startedSessionId =
      typeof started.start?.sessionId === "string" ? started.start.sessionId : "";
    if (started.start.status !== "running" || !startedSessionId) {
      record.failed = true;
      record.failureStep = "start";
      record.endedAt = new Date().toISOString();
      return record;
    }
    sessionId = startedSessionId;
  }

  const action = expectedAction(caseName);
  const replyCall = client
    .callTool({
      name: "claude_code_reply",
      arguments: { sessionId, prompt: "Race follow-up message." },
    })
    .then((res) => ({ ok: true, payload: parseToolResponse(res) }))
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }));

  // Slight delay increases probability of overlapping calls while preserving concurrency.
  await sleep(5);
  const actionCall = client
    .callTool({
      name: "claude_code_session",
      arguments: { action, sessionId },
    })
    .then((res) => ({ ok: true, payload: parseToolResponse(res) }))
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }));

  const [replyResult, actionResult] = await Promise.all([replyCall, actionCall]);
  record.replyResult = replyResult;
  record.action = action;
  record.actionResult = actionResult.ok
    ? { ok: true, payload: summarizeSessionPayload(actionResult.payload) }
    : actionResult;

  const replyErrorCode = extractErrorCode(replyResult.ok ? replyResult.payload : replyResult.error);
  record.replyErrorCode = replyErrorCode;
  const acceptedReplyCodes = new Set(["SESSION_BUSY", "CANCELLED"]);
  if (!acceptedReplyCodes.has(replyErrorCode ?? "")) {
    record.failed = true;
    record.failureStep = "reply_error_code";
  }

  try {
    record.pollAfterRace = parseToolResponse(
      await client.callTool({
        name: "claude_code_check",
        arguments: { action: "poll", sessionId, cursor, responseMode: "full" },
      })
    );
  } catch (error) {
    record.failed = true;
    record.failureStep = "poll_after_race";
    record.pollAfterRaceError =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  try {
    const resources = await client.listResources();
    record.resourcesAfterRace = resources.resources.map((r) => r.uri);
  } catch (error) {
    record.failed = true;
    record.failureStep = "list_resources_after_race";
    record.resourcesAfterRaceError =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  try {
    record.sessionListAfterRace = summarizeSessionPayload(
      parseToolResponse(
        await client.callTool({
          name: "claude_code_session",
          arguments: { action: "list" },
        })
      )
    );
  } catch (error) {
    record.failed = true;
    record.failureStep = "list_sessions_after_race";
    record.sessionListAfterRaceError =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  record.cleanup = await cleanupRunningSessions(client);
  if (Array.isArray(record.cleanup.errors) && record.cleanup.errors.length > 0) {
    record.failed = true;
    record.failureStep = record.failureStep ?? "cleanup";
  }

  record.failed = !!record.failed;
  record.endedAt = new Date().toISOString();
  return record;
}

async function main() {
  const cfg = parseArgs(process.argv);
  const selectedCases =
    cfg.caseName === "all" ? CASES : CASES.filter((c) => c.toLowerCase() === cfg.caseName);
  if (selectedCases.length === 0) {
    throw new Error(
      `Unknown --case '${cfg.caseName}'. Allowed: all, ${CASES.map((c) => `'${c}'`).join(", ")}`
    );
  }

  const transport = new StdioClientTransport(transportConfig());
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
  }

  const client = new Client(
    { name: "stdio-reply-race-regression", version: "0.0.0" },
    { capabilities: {} }
  );
  const report = {
    startedAt: new Date().toISOString(),
    caseName: cfg.caseName,
    selectedCases,
    iterations: cfg.iterations,
    pollIntervalMs: cfg.pollIntervalMs,
    maxPolls: cfg.maxPolls,
    startRetries: cfg.startRetries,
    startRetryDelayMs: cfg.startRetryDelayMs,
    waitingAttempts: cfg.waitingAttempts,
    records: [],
    failedAt: undefined,
    fatal: undefined,
  };

  try {
    await client.connect(transport);
    for (let i = 0; i < cfg.iterations; i += 1) {
      for (const caseName of selectedCases) {
        try {
          const record = await runCaseIteration(client, caseName, i, cfg);
          report.records.push(record);
          if (record.failed) {
            report.failedAt = `${caseName}#${i + 1}`;
            break;
          }
        } catch (error) {
          report.records.push({
            caseName,
            iteration: i + 1,
            failed: true,
            failureStep: "iteration",
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            endedAt: new Date().toISOString(),
          });
          report.failedAt = `${caseName}#${i + 1}`;
          break;
        }
      }
      if (report.failedAt) break;
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
