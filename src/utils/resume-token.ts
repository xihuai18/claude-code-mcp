import { createHmac } from "node:crypto";

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

export function isValidResumeToken(sessionId: string, token: string, secrets: string[]): boolean {
  for (const secret of secrets) {
    if (computeResumeToken(sessionId, secret) === token) return true;
  }
  return false;
}
