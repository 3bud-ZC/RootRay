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
    w.__RR_EMIT__ = (event: string, payload: unknown) => {
      const id = listeners.get(event);
      const cb = id !== undefined ? callbacks.get(id) : undefined;
      cb?.({ event, payload });
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
