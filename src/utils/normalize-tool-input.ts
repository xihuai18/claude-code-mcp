import { normalizeWindowsPathLike } from "./normalize-windows-path.js";

export function normalizeToolInput(
  _toolName: string,
  input: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> {
  if (platform !== "win32") return input;

  const filePath = input.file_path;
  if (typeof filePath !== "string") return input;

  const normalized = normalizeWindowsPathLike(filePath, platform);
  return normalized === filePath ? input : { ...input, file_path: normalized };
}
