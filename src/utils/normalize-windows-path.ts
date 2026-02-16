import path from "node:path";
import os from "node:os";

function maybeAddWindowsLongPathPrefix(value: string): string {
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\") || value.length < 240)
    return value;
  return path.win32.toNamespacedPath(value);
}

function expandTilde(value: string, platform: NodeJS.Platform): string {
  if (value === "~") return os.homedir();
  if (!value.startsWith("~")) return value;
  const next = value[1];
  if (next !== "/" && next !== "\\") return value;
  const rest = value.slice(2);
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return join(os.homedir(), rest);
}

function normalizeMsysToWindowsPathInner(rawPath: string): string | undefined {
  // NOTE: This assumes callers have already confirmed the runtime is Windows.
  // We intentionally do not normalize on non-win32 platforms (e.g. WSL) where
  // `/mnt/c/...` can be a real POSIX path.
  //
  // Already a Windows drive path or UNC.
  if (/^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\")) return undefined;

  // MSYS-style UNC: //server/share/path -> \\server\share\path
  // Guard against accidental matches like //d/... by requiring server name length >= 2.
  if (rawPath.startsWith("//")) {
    const m = rawPath.match(/^\/\/([^/]{2,})\/(.*)$/);
    if (m) {
      const host = m[1]!;
      const rest = m[2] ?? "";
      return `\\\\${host}\\${rest.replace(/\//g, "\\")}`;
    }
  }

  // Cygwin-style: /cygdrive/c/path -> C:\path
  const cyg = rawPath.match(/^\/cygdrive\/([a-zA-Z])\/(.*)$/);
  if (cyg) {
    const drive = cyg[1]!.toUpperCase();
    const rest = cyg[2] ?? "";
    return `${drive}:\\${rest.replace(/\//g, "\\")}`;
  }

  // MSYS/WSL-style: /c/path or /mnt/c/path -> C:\path
  const m = rawPath.match(/^\/(?:mnt\/)?([a-zA-Z])\/(.*)$/);
  if (!m) return undefined;
  const drive = m[1]!.toUpperCase();
  const rest = m[2] ?? "";
  return `${drive}:\\${rest.replace(/\//g, "\\")}`;
}

export function normalizeMsysToWindowsPath(rawPath: string): string | undefined {
  const converted = normalizeMsysToWindowsPathInner(rawPath);
  if (!converted) return undefined;
  return path.win32.normalize(converted);
}

export function normalizeWindowsPathLike(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const expanded = expandTilde(value, platform);
  if (platform !== "win32") return expanded;
  const converted = normalizeMsysToWindowsPath(expanded);
  // If we didn't actually convert anything, avoid treating POSIX-style absolute paths
  // (e.g. "/extra" or "//d/path") as Windows-rooted or UNC paths.
  if (!converted && expanded.startsWith("/")) return expanded;
  const normalized = path.win32.normalize(converted ?? expanded);
  return maybeAddWindowsLongPathPrefix(normalized);
}

export function normalizeWindowsPathArray(
  values: string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  return values.map((v) => normalizeWindowsPathLike(v, platform));
}
