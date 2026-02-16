const BENIGN_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_WRITE_AFTER_END",
  "ERR_STREAM_DESTROYED",
  "ABORT_ERR",
]);

const BENIGN_MESSAGE_PATTERNS = [
  "operation aborted",
  "request was cancelled",
  "transport closed",
  "write after end",
  "stream was destroyed",
  "cannot call write after a stream was destroyed",
  "the pipe is being closed",
];

/**
 * Errors in this category are expected during teardown/cancel races and should
 * not force the MCP server process to exit.
 */
export function isBenignRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const withCode = error as Error & { code?: unknown };
  const code = typeof withCode.code === "string" ? withCode.code : undefined;
  if (code && BENIGN_CODES.has(code)) return true;

  if (error.name === "AbortError") return true;

  const message = error.message.toLowerCase();
  return BENIGN_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}
