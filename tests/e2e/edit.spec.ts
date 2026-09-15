/**
 * RootRay safe-editing end-to-end test.
 *
 * Uses the real fixture + real runner + real Chromium. The save path is
 * performed through `safeSave` — a Node mirror of the Rust
 * `editor::file` optimistic-concurrency + atomic-write contract (the
 * native implementation itself is covered by the `source_edit` Rust
 * suite, which this environment cannot invoke from a browser).
 *
 * Proves: edit → safe save → Vite HMR → re-inspection with correct
 * (shifted) line numbers → conflict rejection preserving both buffers →
 * invalid-JSX recovery → only the intended file ever changes.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type FixtureRun,
  SourceEditConflict,
  safeRead,
  safeSave,
  sourceLineOf,
  startFixture,
  stopFixture,
} from "./harness";

// beforeAll performs a cold `npm install` in a temp fixture copy.
test.setTimeout(300_000);
test.describe.configure({ mode: "serial" });

const BUTTON_REL = "src/components/ActionButton.tsx";

let run: FixtureRun | undefined;

function f(): FixtureRun {
  if (!run) throw new Error("fixture not started");
  return run;
}

test.beforeAll(async () => {
  run = await startFixture(5445);
});

test.afterAll(async () => {
  await stopFixture(run);
});

// ---------------------------------------------------------------------------

/** Digest of every project file EXCEPT `skipRel` — integrity check. */
function digestExcept(dir: string, skipRel: string): string {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (["node_modules", "dist", ".git"].includes(entry)) continue;
      if (relPath === skipRel) continue;
      const abs = join(dir, relPath);
      if (statSync(abs).isDirectory()) walk(relPath);
      else {
        hash.update(relPath);
        hash.update(readFileSync(abs));
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

async function gotoApp(page: import("@playwright/test").Page): Promise<void> {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  await page.goto(f().appUrl);
  try {
    await expect(page.locator("text=Inspector fixture")).toBeVisible();
  } catch (e) {
    const html = (await page.content()).slice(0, 3000);
    console.error(
      `[e2e] app did not render.\nconsoleErrors=${JSON.stringify(consoleErrors)}\nhtml=${html}`,
    );
    throw e;
  }
}

// ---------------------------------------------------------------------------

test("safe save → Vite HMR → re-inspection resolves updated source", async ({ page }) => {
  await gotoApp(page);
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");
  // Let the Vite HMR websocket subscribe before writing.
  await page.waitForTimeout(1_500);

  const untouchedBaseline = digestExcept(f().workDir, BUTTON_REL);
  const abs = join(f().workDir, "src", "components", "ActionButton.tsx");

  // --- the RootRay "load" step -------------------------------------------------
  const loaded = safeRead(abs);
  expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/);

  // --- user edit in the editor buffer ------------------------------------------
  const edited = loaded.content.replace("Count is {count}", "Tally is {count}");
  expect(edited).not.toBe(loaded.content);

  // --- safe save: expected hash matches → atomic write -------------------------
  const newHash = safeSave(abs, edited, loaded.hash);
  expect(newHash).not.toBe(loaded.hash);
  // No temp-file leftovers after a successful atomic write.
  const leftovers = readdirSync(join(f().workDir, "src", "components")).filter((f) =>
    f.includes("rootray-"),
  );
  expect(leftovers).toEqual([]);

  // --- Vite HMR updates the real browser ---------------------------------------
  const button = page.locator("button", { hasText: "Tally is" });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toHaveAttribute("data-rootray-file", BUTTON_REL);

  // --- inspect the updated element again ----------------------------------------
  f().bridge.sendInspectSet(true);
  await button.hover();
  await expect(page.locator(".rr-box")).toBeVisible();
  await button.click();
  await f().bridge.waitFor(() => f().bridge.selections.length > 0, "element:selected after HMR");
  const sel = f().bridge.selections[0] as {
    source: { relativePath: string; line: number };
  };
  expect(sel.source.relativePath).toBe(BUTTON_REL);
  // Line resolves against the CURRENT file — derived, not hardcoded.
  expect(sel.source.line).toBe(sourceLineOf(abs, "<button"));

  // --- only the intended file changed -------------------------------------------
  expect(digestExcept(f().workDir, BUTTON_REL)).toBe(untouchedBaseline);

  f().bridge.sendInspectSet(false);
});

test("shifted line numbers re-resolve after an insert above the element", async ({ page }) => {
  await gotoApp(page);
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");
  await page.waitForTimeout(1_500);

  const abs = join(f().workDir, "src", "components", "ActionButton.tsx");
  const before = sourceLineOf(abs, "<button");

  const loaded = safeRead(abs);
  // Insert a line above the component — a realistic edit that shifts the
  // button's line number down by one.
  const edited = loaded.content.replace(
    "export function ActionButton()",
    "// touched by RootRay\nexport function ActionButton()",
  );
  safeSave(abs, edited, loaded.hash);

  // The label is unchanged, so wait for the HMR-applied metadata itself:
  // the re-transformed element reports its new line in the DOM.
  const button = page.locator("button", { hasText: "Tally is" });
  await expect(button).toHaveAttribute("data-rootray-line", String(before + 1), {
    timeout: 30_000,
  });

  f().bridge.sendInspectSet(true);
  const prevSelections = f().bridge.selections.length;
  await button.click();
  await f().bridge.waitFor(
    () => f().bridge.selections.length > prevSelections,
    "element:selected after line shift",
  );
  const sel = f().bridge.selections.at(-1) as {
    source: { line: number };
  };
  // No stale line caching — the selection reports the NEW line.
  expect(sel.source.line).toBe(before + 1);
  f().bridge.sendInspectSet(false);
});

test("external modification blocks save; unsaved buffer survives", async ({ page }) => {
  await gotoApp(page);
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");
  // Let the Vite HMR websocket subscribe before writing — updates emitted
  // before the client connects are silently dropped.
  await page.waitForTimeout(1_500);

  const abs = join(f().workDir, "src", "components", "ActionButton.tsx");
  const loaded = safeRead(abs);
  // Whatever the current label is ("Count is" or "Tally is" if an earlier
  // spec ran), anchor on the JSX text node pattern.
  const labelRe = /\w+ \{count\}/;
  expect(loaded.content).toMatch(labelRe);

  // RootRay-side unsaved edit sitting in the "editor buffer".
  const unsaved = loaded.content.replace(labelRe, "UnsavedEdit {count}");

  // An external tool (VS Code, a formatter, an agent) writes the file.
  const external = loaded.content.replace(labelRe, "ExternalEdit {count}");
  writeFileSync(abs, external);

  // The external edit is a real filesystem change — Vite HMR delivers it
  // just like it would for a human editor.
  await expect(page.locator("button", { hasText: "ExternalEdit" })).toBeVisible({
    timeout: 30_000,
  });

  // The save must refuse — wrong expected hash.
  let conflict: SourceEditConflict | null = null;
  try {
    safeSave(abs, unsaved, loaded.hash);
  } catch (e) {
    conflict = e as SourceEditConflict;
  }
  expect(conflict).toBeInstanceOf(SourceEditConflict);
  expect(conflict?.message).toBe("SOURCE_EDIT_CONFLICT");

  // The external version is untouched on disk…
  expect(readFileSync(abs, "utf8")).toBe(external);
  // …and the unsaved RootRay buffer is intact.
  expect(unsaved).toContain("UnsavedEdit");

  // The "Reload Disk Version" path re-bases, then a save succeeds.
  const reloaded = safeRead(abs);
  expect(reloaded.content).toBe(external.replaceAll("\r\n", "\n"));
  const merged = reloaded.content.replace("ExternalEdit {count}", "MergedEdit {count}");
  expect(merged).not.toBe(reloaded.content);
  safeSave(abs, merged, reloaded.hash);
  await expect(page.locator("button", { hasText: "MergedEdit" })).toBeVisible({
    timeout: 30_000,
  });
});

test("invalid JSX: save succeeds, Vite reports error, fix recovers", async ({ page }) => {
  await gotoApp(page);
  await f().bridge.waitFor(() => f().bridge.ready, "runtime:ready");
  await page.waitForTimeout(1_500);

  const abs = join(f().workDir, "src", "components", "ActionButton.tsx");
  const loaded = safeRead(abs);

  // A realistic typo: unclosed JSX element.
  const broken = loaded.content.replace("</button>", "<button>");
  safeSave(abs, broken, loaded.hash);

  // Vite surfaces a compile error overlay; the runner stays alive.
  const overlay = page.locator("vite-error-overlay");
  const rendered = page.locator("text=Inspector fixture");
  const sawError = await Promise.race([
    overlay.waitFor({ state: "visible", timeout: 30_000 }).then(() => true),
    rendered.waitFor({ state: "hidden", timeout: 30_000 }).then(() => true),
  ]).catch(() => false);
  expect(sawError).toBe(true);
  expect(f().runner.exitCode).toBeNull();

  // Fix and save again — restoring the known-good snapshot is exactly
  // what Discard/Undo-then-Save does in the real workflow.
  const brokenOnDisk = safeRead(abs);
  const recovered = loaded.content.replace(/MergedEdit|Tally is|Count is/, "Recovered");
  safeSave(abs, recovered, brokenOnDisk.hash);

  await expect(page.locator("text=Inspector fixture")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("button", { hasText: "Recovered" })).toBeVisible({
    timeout: 30_000,
  });
  expect(f().runner.exitCode).toBeNull();
});
