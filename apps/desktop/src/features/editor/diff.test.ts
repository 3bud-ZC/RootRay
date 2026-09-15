import { describe, expect, it } from "vitest";
import { collapseContext, diffLines } from "./diff";

describe("diffLines", () => {
  it("reports no changes for identical text", () => {
    const d = diffLines("a\nb\nc\n", "a\nb\nc\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.lines.every((l) => l.kind === "context")).toBe(true);
  });

  it("marks a single-line change as remove+add", () => {
    const d = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(d.removed).toBe(1);
    expect(d.added).toBe(1);
    const removed = d.lines.find((l) => l.kind === "removed");
    const added = d.lines.find((l) => l.kind === "added");
    expect(removed?.text).toBe("b");
    expect(removed?.oldN).toBe(2);
    expect(added?.text).toBe("B");
    expect(added?.newN).toBe(2);
  });

  it("handles pure insertions and deletions", () => {
    const ins = diffLines("a\nc\n", "a\nb\nc\n");
    expect(ins.added).toBe(1);
    expect(ins.removed).toBe(0);
    const del = diffLines("a\nb\nc\n", "a\nc\n");
    expect(del.added).toBe(0);
    expect(del.removed).toBe(1);
  });

  it("diffs empty vs content", () => {
    const d = diffLines("", "new\n");
    // "" splits to [""]; the trailing "" of "new\n" matches it.
    expect(d.added).toBe(1);
    expect(d.lines.find((l) => l.kind === "added")?.text).toBe("new");
  });
});

describe("collapseContext", () => {
  it("collapses long unchanged runs between hunks", () => {
    const old = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const lines = old.split("\n");
    lines[2] = "CHANGED_A";
    lines[27] = "CHANGED_B";
    const d = diffLines(old, lines.join("\n"));
    const collapsed = collapseContext(d, 3);
    const marker = collapsed.find((l) => l.text.includes("unchanged"));
    expect(marker).toBeDefined();
    expect(collapsed.filter((l) => l.kind !== "context").length).toBe(4);
  });

  it("keeps short context runs intact", () => {
    const d = diffLines("a\nb\nc\n", "a\nB\nc\n");
    const collapsed = collapseContext(d, 3);
    expect(collapsed.length).toBe(d.lines.length);
  });
});
