type PermissionAction = {
  type: "permission";
  requestId: string;
  toolName: string;
};

type CheckResult = {
  status: "idle" | "running" | "waiting_permission" | "cancelled" | "error";
  nextCursor?: number;
  cursorResetTo?: number;
  actions?: PermissionAction[];
  result?: { isError: boolean; errorSubtype?: string; result: string };
  events?: Array<{ id: number; type: string; data: unknown }>;
};

export type PermissionPolicy = (toolName: string) => {
  decision: "allow" | "deny";
  interrupt?: boolean;
};

export async function pollToTerminal(params: {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  sessionId: string;
  policy: PermissionPolicy;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ final: CheckResult; events: Array<{ id: number; type: string; data: unknown }> }> {
  const timeoutMs = params.timeoutMs ?? 5 * 60_000;
  const intervalMs = params.intervalMs ?? 400;

  let cursor = 0;
  const allEvents: Array<{ id: number; type: string; data: unknown }> = [];
  const startedAt = Date.now();

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `pollToTerminal timeout after ${timeoutMs}ms (sessionId=${params.sessionId})`
      );
    }

    const raw = await params.callTool("claude_code_check", {
      action: "poll",
      sessionId: params.sessionId,
      cursor,
    });
    const res = raw as CheckResult;

    if (typeof res.cursorResetTo === "number") cursor = res.cursorResetTo;
    if (Array.isArray(res.events) && res.events.length > 0) allEvents.push(...res.events);
    if (typeof res.nextCursor === "number") cursor = res.nextCursor;

    if (
      res.status === "waiting_permission" &&
      Array.isArray(res.actions) &&
      res.actions.length > 0
    ) {
      for (const a of res.actions) {
        const { decision, interrupt } = params.policy(a.toolName);
        await params.callTool("claude_code_check", {
          action: "respond_permission",
          sessionId: params.sessionId,
          requestId: a.requestId,
          decision,
          interrupt,
        });
      }
    }

    if (res.status === "idle" || res.status === "error" || res.status === "cancelled") {
      return { final: res, events: allEvents };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
