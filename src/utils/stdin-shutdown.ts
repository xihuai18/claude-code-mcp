export type StdinShutdownDecision = "clear" | "shutdown_now" | "shutdown_timeout" | "reschedule";

export function decideStdinShutdown(params: {
  stdinUnavailable: boolean;
  elapsedMs: number;
  maxWaitMs: number;
  hasActiveSessions: boolean;
  isConnected: boolean;
}): StdinShutdownDecision {
  if (!params.stdinUnavailable) return "clear";

  // Important safety guard:
  // when transport still reports connected, treat stdin end/close as potentially
  // transient and keep serving instead of forcing process shutdown.
  if (params.isConnected) return "reschedule";

  if (!params.hasActiveSessions) return "shutdown_now";
  if (params.elapsedMs >= params.maxWaitMs) return "shutdown_timeout";
  return "reschedule";
}
