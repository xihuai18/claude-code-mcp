import { describe, it, expect, vi } from "vitest";
import { raceWithAbort } from "../src/utils/race-with-abort.js";

describe("raceWithAbort", () => {
  it("returns the original promise when no signal is provided", async () => {
    const onAbort = vi.fn();
    await expect(raceWithAbort(Promise.resolve(1), undefined, onAbort)).resolves.toBe(1);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const onAbort = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(raceWithAbort(Promise.resolve(1), ac.signal, onAbort)).rejects.toThrow(
      "CANCELLED"
    );
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("rejects when the signal aborts before the promise resolves", async () => {
    const onAbort = vi.fn();
    const ac = new AbortController();
    const p = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    const raced = raceWithAbort(p, ac.signal, onAbort);
    ac.abort();
    await expect(raced).rejects.toThrow("CANCELLED");
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("swallows onAbort errors and still rejects with CANCELLED", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      raceWithAbort(Promise.resolve(1), ac.signal, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("CANCELLED");
  });
});
