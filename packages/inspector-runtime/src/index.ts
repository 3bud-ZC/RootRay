/**
 * RootRay inspector runtime entry point.
 *
 * Injected into the inspected Vite app by `@rootray/vite-plugin`. Reads the
 * ephemeral session config stamped on `window.__ROOTRAY__`, then starts the
 * runtime. Absent config → complete no-op (production builds are untouched).
 */

import { ROOTRAY_PROTOCOL_VERSION } from "@rootray/source-protocol";
import { InspectorRuntime } from "./runtime";

interface RootRayBootstrap {
  bridgeUrl?: string;
  sessionId?: string;
  token?: string;
  version?: number;
  projectRoot?: string;
  mode?: string;
  reloadUrl?: string;
}

const cfg = (window as unknown as { __ROOTRAY__?: RootRayBootstrap }).__ROOTRAY__;

if (
  cfg &&
  typeof cfg.bridgeUrl === "string" &&
  typeof cfg.sessionId === "string" &&
  typeof cfg.token === "string"
) {
  const runtime = new InspectorRuntime({
    config: {
      bridgeUrl: cfg.bridgeUrl,
      sessionId: cfg.sessionId,
      token: cfg.token,
      protocolVersion: cfg.version ?? ROOTRAY_PROTOCOL_VERSION,
      ...(typeof cfg.projectRoot === "string" ? { projectRoot: cfg.projectRoot } : {}),
      ...(cfg.mode === "jsx-meta"
        ? { mode: "jsx-meta" as const }
        : { mode: "generic-dom" as const }),
      ...(typeof cfg.reloadUrl === "string" ? { reloadUrl: cfg.reloadUrl } : {}),
    },
    socketFactory: (url) => new WebSocket(url) as unknown as import("./runtime").BridgeSocket,
  });
  runtime.start();
  // Exposed for debugging only — carries no privileged capability.
  (window as unknown as { __ROOTRAY_RUNTIME__?: InspectorRuntime }).__ROOTRAY_RUNTIME__ = runtime;
}

export * from "./metadata";
export { InspectorOverlay } from "./overlay";
export { InspectorRuntime } from "./runtime";
