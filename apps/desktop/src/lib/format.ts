/** Formats elapsed milliseconds as `m:ss` / `h:mm:ss`. */
export function formatElapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return "—";
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Short display name for a project path (last segment). */
export function projectDisplayName(name: string | null, root: string): string {
  if (name) return name;
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/** Strips ANSI CSI/OSC sequences for log rendering. */
export function stripAnsi(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires control chars
  return input.replace(/\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "");
}
