import { createHmac } from "node:crypto";

export function getResumeSecret(): string | undefined {
  const secret = process.env.CLAUDE_CODE_MCP_RESUME_SECRET;
  if (typeof secret !== "string") return undefined;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function computeResumeToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}
