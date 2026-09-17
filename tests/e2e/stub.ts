/**
 * Shared Tauri-IPC stub for specs that drive the real built UI without a
 * WebView2 driver. Commands resolve to canned data; `rootray://` events
 * can be pushed from the test via `__RR_EMIT__`.
 */

import type { Page } from "@playwright/test";

export interface StubbedWorkspace {
  canned: Record<string, unknown>;
  /** The runtime snapshot emitted after analyze_project / set_active_target. */
  runtime: Record<string, unknown>;
}

/** Installs a minimal Tauri IPC stub before any app code runs. */
export async function stubTauri(page: Page, stub: StubbedWorkspace) {
  await page.addInitScript((args: StubbedWorkspace) => {
    const { canned, runtime } = args;
    const w = window as unknown as Record<string, unknown>;
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners = new Map<string, number>();
    let nextId = 1;
    const calls: { cmd: string; args: unknown }[] = [];
    w.__RR_CALLS__ = calls;
    // Latest inspector snapshot the page has seen — set_inspection echoes
    // build on this (like the real bridge), not on the stale canned value.
    let inspectorCurrent: Record<string, unknown> | null = null;
    w.__RR_EMIT__ = (event: string, payload: unknown) => {
      if (event === "rootray://inspector-state") {
        inspectorCurrent = payload as Record<string, unknown>;
      }
      const id = listeners.get(event);
      const cb = id !== undefined ? callbacks.get(id) : undefined;
      cb?.({ event, payload });
    };
    // Mirrors the native preview contract: commands mutate a stub-side
    // snapshot and emit rootray://preview-state, like PreviewManager does.
    let preview = {
      phase: "hidden" as string,
      url: null as string | null,
      error: null as string | null,
      generation: 0,
    };
    const emitPreview = () => {
      preview = { ...preview, generation: preview.generation + 1 };
      const id = listeners.get("rootray://preview-state");
      const cb = id !== undefined ? callbacks.get(id) : undefined;
      cb?.({ event: "rootray://preview-state", payload: { ...preview } });
    };
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "plugin:event|listen") {
          const handler = args.handler as number;
          listeners.set(args.event as string, handler);
          return Promise.resolve(nextId++);
        }
        if (cmd === "list_project_dir") {
          // Path-aware canned listing — a static value can't be used because
          // expanding "src" would then re-render "src" (same relativePath).
          const rel = args.relativeDir as string;
          return Promise.resolve(
            rel === ""
              ? {
                  relativePath: "",
                  truncated: false,
                  entries: [
                    {
                      name: "src",
                      relativePath: "src",
                      kind: "dir",
                      editable: false,
                      sizeBytes: null,
                    },
                    {
                      name: "package.json",
                      relativePath: "package.json",
                      kind: "file",
                      editable: true,
                      sizeBytes: 512,
                    },
                  ],
                }
              : {
                  relativePath: rel,
                  truncated: false,
                  entries: [
                    {
                      name: "App.tsx",
                      relativePath: `${rel}/App.tsx`,
                      kind: "file",
                      editable: true,
                      sizeBytes: 1024,
                    },
                  ],
                },
          );
        }
        if (cmd === "plugin:dialog|open") {
          return Promise.resolve("C:/fixture/project");
        }
        if (cmd === "analyze_project") {
          // Mirrors the FIXED Tauri contract: the command emits a fresh
          // rootray://state snapshot after mutating RuntimeState, then
          // resolves the analysis. v0.1.0 skipped the emit — the UI
          // stayed on HomeView.
          const id = listeners.get("rootray://state");
          const cb = id !== undefined ? callbacks.get(id) : undefined;
          cb?.({ event: "rootray://state", payload: runtime });
          return Promise.resolve(canned.analyze_project);
        }
        if (cmd === "set_active_target") {
          // Mirror the real contract: mutate the workspace snapshot,
          // emit fresh state, resolve the updated analysis.
          const targetId = args.targetId as string;
          const ws = (runtime as { workspace: Record<string, unknown> }).workspace;
          ws.activeTargetId = targetId;
          const id = listeners.get("rootray://state");
          const cb = id !== undefined ? callbacks.get(id) : undefined;
          cb?.({ event: "rootray://state", payload: runtime });
          return Promise.resolve(ws);
        }
        // Path-aware editor responses — a fixed canned read can't model
        // rapid cross-file selection, whose correctness depends on the
        // reducer's relativePath guards.
        if (
          cmd === "open_source_editor" ||
          cmd === "reload_source_file" ||
          cmd === "peek_source_file"
        ) {
          const rel = args.relativePath as string;
          const content = `// ${rel}\nexport const x = 1;\n`;
          return Promise.resolve({
            relativePath: rel,
            content,
            hash: `hash-${rel}`,
            lineEnding: "lf",
            bom: false,
            sizeBytes: content.length,
          });
        }
        if (cmd === "read_source_preview") {
          const line = (args.line as number) ?? 1;
          return Promise.resolve({
            relativePath: args.relativePath,
            selectedLine: line,
            startLine: Math.max(1, line - 2),
            endLine: line + 2,
            lines: [
              { n: line, text: `// line ${line}` },
              { n: line + 1, text: `// line ${line + 1}` },
            ],
          });
        }
        if (
          cmd === "save_source_file" ||
          cmd === "check_source_file" ||
          cmd === "revert_source_save"
        ) {
          const rel = args.relativePath as string;
          const content = (args.content as string) ?? `// ${rel}\n`;
          const read = {
            relativePath: rel,
            content,
            hash: `saved-${rel}`,
            lineEnding: "lf",
            bom: false,
            sizeBytes: content.length,
          };
          return Promise.resolve(
            cmd === "check_source_file"
              ? { relativePath: rel, hash: `saved-${rel}`, sizeBytes: content.length }
              : cmd === "save_source_file"
                ? { relativePath: rel, hash: `saved-${rel}` }
                : read,
          );
        }
        // --- embedded preview commands --------------------------------------
        if (cmd === "preview_create") {
          preview = { ...preview, phase: "ready", url: args.url as string };
          emitPreview();
          return Promise.resolve(undefined);
        }
        if (cmd === "preview_navigate") {
          preview = { ...preview, phase: "ready", url: args.url as string };
          emitPreview();
          return Promise.resolve(undefined);
        }
        if (cmd === "preview_state") return Promise.resolve({ ...preview });
        if (cmd === "preview_url") return Promise.resolve(preview.url);
        if (cmd === "preview_mark_waiting") {
          preview = { ...preview, phase: "waiting" };
          emitPreview();
          return Promise.resolve(undefined);
        }
        if (cmd === "preview_mark_stopped") {
          preview = { ...preview, phase: "stopped" };
          emitPreview();
          return Promise.resolve(undefined);
        }
        if (cmd === "preview_dispose") {
          preview = { ...preview, phase: "hidden", url: null, error: null };
          emitPreview();
          return Promise.resolve(undefined);
        }
        // Bounds/visibility/history calls just record the invocation.
        if (cmd.startsWith("preview_")) return Promise.resolve(undefined);
        // set_inspection mirrors the bridge echo: the authoritative
        // inspector-state snapshot reflects the requested flag, and the
        // phase tracks inspecting ↔ connected like the real session does.
        if (cmd === "set_inspection") {
          const ins = (inspectorCurrent ?? canned.get_inspector_state ?? {}) as Record<
            string,
            unknown
          >;
          const enabled = Boolean(args.enabled);
          const live = ins.phase === "connected" || ins.phase === "inspecting" || enabled;
          const next = {
            ...ins,
            inspectionEnabled: enabled,
            phase: enabled ? "inspecting" : live ? "connected" : ins.phase,
          };
          inspectorCurrent = next;
          canned.get_inspector_state = next;
          const id = listeners.get("rootray://inspector-state");
          const cb = id !== undefined ? callbacks.get(id) : undefined;
          cb?.({ event: "rootray://inspector-state", payload: next });
          return Promise.resolve(undefined);
        }
        return Promise.resolve(canned[cmd]);
      },
      transformCallback: (cb: (e: unknown) => void) => {
        const id = nextId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
      callbacks,
      convertFileSrc: (p: string) => p,
      metadata: {},
      plugins: {},
    };
  }, stub);
}
