import { createHmac, timingSafeEqual } from "node:crypto";

export function getResumeSecrets(): string[] {
  const raw = process.env.CLAUDE_CODE_MCP_RESUME_SECRET;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getResumeSecret(): string | undefined {
  return getResumeSecrets()[0];
}

export function computeResumeToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const rightRaw = Buffer.from(b, "utf8");
  const right = Buffer.alloc(left.length);
  rightRaw.copy(right, 0, 0, left.length);
  const sameLength = rightRaw.length === left.length;
  return timingSafeEqual(left, right) && sameLength;
}

export function isValidResumeToken(sessionId: string, token: string, secrets: string[]): boolean {
  for (const secret of secrets) {
    const computed = computeResumeToken(sessionId, secret);
    if (timingSafeEqualText(computed, token)) return true;
  }
  return false;
}
