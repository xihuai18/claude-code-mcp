function normalizeMsysToWindowsPath(path: string): string | undefined {
  // NOTE: This assumes callers have already confirmed the runtime is Windows.
  // We intentionally do not normalize on non-win32 platforms (e.g. WSL) where
  // `/mnt/c/...` is a real POSIX path.
  // Already a Windows drive path or UNC.
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) return undefined;

  const m = path.match(/^\/(?:mnt\/)?([a-zA-Z])\/(.*)$/);
  if (!m) return undefined;
  const drive = m[1]!.toUpperCase();
  const rest = m[2] ?? "";
  return `${drive}:\\${rest.replace(/\//g, "\\")}`;
}

export function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> {
  if (platform !== "win32") return input;
  if (toolName !== "NotebookEdit") return input;

  const filePath = input.file_path;
  if (typeof filePath !== "string") return input;

  const normalized = normalizeMsysToWindowsPath(filePath);
  if (!normalized) return input;

  return { ...input, file_path: normalized };
}
