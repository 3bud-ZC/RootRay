/**
 * "Copy Context" — a bounded, factual developer-context block for the
 * selected element. Relative paths only, a small source snippet, no
 * secrets, no absolute paths, no large payloads.
 */

import type { ElementSelection, SourcePreview } from "@rootray/shared";

const MAX_SNIPPET_LINES = 8;
const MAX_USED_BY = 8;
const MAX_STYLE_SOURCES = 8;
const MAX_BLOCK_CHARS = 4000;

export function buildContextBlock(
  selection: ElementSelection,
  preview: SourcePreview | null,
  usedBy: { path: string; line: number }[] | null,
): string {
  const { element, source, styles } = selection;
  const lines: string[] = [];

  if (source.componentName) lines.push(`Component: ${source.componentName}`);
  lines.push(`Source: ${source.relativePath}:${source.line}:${source.column}`);
  lines.push(`Tag: ${element.tagName}`);
  if (element.id) lines.push(`ID: #${element.id}`);
  if (styles && styles.classes.length > 0) {
    lines.push(`Classes: ${styles.classes.join(" ")}`);
  } else if (element.className) {
    lines.push(`Classes: ${element.className}`);
  }

  if (usedBy && usedBy.length > 0) {
    lines.push("", "Used by:");
    for (const u of usedBy.slice(0, MAX_USED_BY)) {
      lines.push(`- ${u.path}:${u.line}`);
    }
  }

  if (styles) {
    const sources = [
      ...new Set(
        styles.matchedRules
          .map((r) => r.sourcePath)
          .filter((p): p is string => typeof p === "string"),
      ),
    ].slice(0, MAX_STYLE_SOURCES);
    if (sources.length > 0) {
      lines.push("", "Matched style sources:");
      for (const s of sources) lines.push(`- ${s}`);
    }
  }

  if (preview) {
    const start = Math.max(0, preview.selectedLine - preview.startLine - 2);
    const snippet = preview.lines.slice(start, start + MAX_SNIPPET_LINES);
    if (snippet.length > 0) {
      lines.push("", "Selected source:", "```");
      for (const l of snippet) lines.push(`${l.n}: ${l.text}`);
      lines.push("```");
    }
  }

  // Final bound — relative paths only, bounded size.
  return lines.join("\n").slice(0, MAX_BLOCK_CHARS);
}
