import { describe, expect, it } from "vitest";
import { decideStdinShutdown } from "../src/utils/stdin-shutdown.js";

describe("decideStdinShutdown", () => {
  it("returns clear when stdin appears recovered", () => {
    const decision = decideStdinShutdown({
      stdinUnavailable: false,
      elapsedMs: 1000,
      maxWaitMs: 15000,
      hasActiveSessions: false,
      isConnected: false,
    });
    expect(decision).toBe("clear");
  });

  it("reschedules while transport is still connected", () => {
    const decision = decideStdinShutdown({
      stdinUnavailable: true,
      elapsedMs: 20000,
      maxWaitMs: 15000,
      hasActiveSessions: false,
      isConnected: true,
    });
    expect(decision).toBe("reschedule");
  });

  it("shuts down immediately when disconnected and no active sessions", () => {
    const decision = decideStdinShutdown({
      stdinUnavailable: true,
      elapsedMs: 500,
      maxWaitMs: 15000,
      hasActiveSessions: false,
      isConnected: false,
    });
    expect(decision).toBe("shutdown_now");
  });

  it("uses timeout shutdown when disconnected with active sessions past max wait", () => {
    const decision = decideStdinShutdown({
      stdinUnavailable: true,
      elapsedMs: 16000,
      maxWaitMs: 15000,
      hasActiveSessions: true,
      isConnected: false,
    });
    expect(decision).toBe("shutdown_timeout");
  });

  it("reschedules when disconnected with active sessions before timeout", () => {
    const decision = decideStdinShutdown({
      stdinUnavailable: true,
      elapsedMs: 2000,
      maxWaitMs: 15000,
      hasActiveSessions: true,
      isConnected: false,
    });
    expect(decision).toBe("reschedule");
  });
});
