/**
 * Copy Diagnostics — a small, safe support block.
 *
 * Includes app version, platform, project detection summary and runtime
 * phases. Deliberately excludes: absolute project paths (basename only),
 * tokens, env vars, source contents, logs and any user file data.
 */

import type { UiState } from "../state/reducer";
import { getDiagnostics } from "./ipc";

const MAX_CHARS = 3000;

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export async function buildDiagnostics(state: UiState, crash?: string): Promise<string> {
  const info = await getDiagnostics().catch(() => null);
  const rt = state.runtime;
  const p = rt.project;
  const insp = state.inspector;

  const lines = [
    `RootRay ${info?.version ?? "?"} (${info?.os ?? "?"}/${info?.arch ?? "?"})`,
    `Project: ${p ? basename(p.root) : "none"} — ${p?.framework ?? "—"} / ${p?.packageManager ?? "—"}`,
    `Runner: ${rt.phase}${rt.url ? ` @ ${rt.url}` : ""}`,
    `Inspector: ${insp.phase}${insp.inspectionEnabled ? " (inspecting)" : ""}`,
    `Editor: ${state.editor ? `${state.editor.relativePath} (${state.editor.status})` : "none"}`,
  ];
  if (rt.error) lines.push(`Runner error: ${rt.error.code}`);
  if (insp.error) lines.push(`Inspector error: ${insp.error.code}`);
  if (state.recentErrors.length > 0) {
    lines.push("Recent errors:");
    for (const e of state.recentErrors) lines.push(`- ${e}`);
  }
  if (crash) lines.push("UI crash:", crash.slice(0, 500));
  return lines.join("\n").slice(0, MAX_CHARS);
}
