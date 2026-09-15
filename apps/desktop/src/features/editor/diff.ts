/**
 * Compact line diff for the Quick Edit "Changes" view — compares the
 * last-known disk snapshot to current editor content. No Git involved.
 * Classic LCS on lines; files are capped at 2 MiB by the native layer
 * and typical quick edits are small, so the O(n·m) table is fine.
 */

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the old (disk) text, 1-based. Undefined for added. */
  oldN?: number;
  /** Line number in the new (editor) text, 1-based. Undefined for removed. */
  newN?: number;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Full line-level diff of `oldText` → `newText`. */
export function diffLines(oldText: string, newText: string): DiffResult {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table, built backwards. Rows are Uint32Array so indexing
  // is bounds-safe under noUncheckedIndexedAccess via `?? 0`.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const cell = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    if (!row) break;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const fromOld = a[i];
    const fromNew = b[j];
    if (fromOld === undefined || fromNew === undefined) break;
    if (fromOld === fromNew) {
      lines.push({ kind: "context", oldN: i + 1, newN: j + 1, text: fromOld });
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      lines.push({ kind: "removed", oldN: i + 1, text: fromOld });
      removed++;
      i++;
    } else {
      lines.push({ kind: "added", newN: j + 1, text: fromNew });
      added++;
      j++;
    }
  }
  for (; i < n; i++) {
    const text = a[i];
    if (text === undefined) break;
    lines.push({ kind: "removed", oldN: i + 1, text });
    removed++;
  }
  for (; j < m; j++) {
    const text = b[j];
    if (text === undefined) break;
    lines.push({ kind: "added", newN: j + 1, text });
    added++;
  }
  return { lines, added, removed };
}

/**
 * Collapse long runs of context lines, keeping `contextRadius` lines of
 * context around each change hunk. Purely a display concern.
 */
export function collapseContext(result: DiffResult, contextRadius = 3): DiffLine[] {
  const out: DiffLine[] = [];
  const lines = result.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.kind !== "context") {
      out.push(line);
      i++;
      continue;
    }
    // Measure this context run.
    let runEnd = i;
    while (runEnd < lines.length && lines[runEnd]?.kind === "context") runEnd++;
    const runLen = runEnd - i;
    if (runLen <= contextRadius * 2 + 1) {
      for (let k = i; k < runEnd; k++) {
        const l = lines[k];
        if (l) out.push(l);
      }
    } else {
      for (let k = i; k < i + contextRadius; k++) {
        const l = lines[k];
        if (l) out.push(l);
      }
      const skipped = runLen - contextRadius * 2;
      out.push({ kind: "context", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
      for (let k = runEnd - contextRadius; k < runEnd; k++) {
        const l = lines[k];
        if (l) out.push(l);
      }
    }
    i = runEnd;
  }
  return out;
}
