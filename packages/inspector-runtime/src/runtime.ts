/**
 * RootRay inspector runtime — the small client injected into the inspected
 * Vite app. Connects to the RootRay loopback bridge, authenticates with the
 * ephemeral session token, then drives local hover/select visualization.
 *
 * Only meaningful events cross the wire (hello/ready/selection/inspect
 * requests). All mousemove work stays local and rAF-throttled.
 */

import {
  type BridgeMessage,
  elementSelectedMessage,
  helloMessage,
  inspectSetMessage,
  parseBridgeMessage,
  readyMessage,
  serializeMessage,
} from "@rootray/source-protocol";
import { elementFacts, findInstrumentedElement, readSourceLocation } from "./metadata";
import { InspectorOverlay } from "./overlay";
import { collectStyleDetails } from "./styles";

/**
 * How the runtime picks the element a pointer event inspects.
 *
 * - `"jsx-meta"` — legacy framework path: inspection tracks the nearest
 *   *instrumented* ancestor (`data-rootray-file`). Elements without
 *   instrumentation are not selectable.
 * - `"generic-dom"` — framework-free inspection: EVERY real DOM element
 *   is selectable. Source mapping still resolves when the element itself
 *   carries trusted `data-rootray-*` stamps (authored HTML), and is
 *   genuinely absent otherwise — never guessed.
 */
export type RuntimeMode = "generic-dom" | "jsx-meta";

export interface RuntimeConfig {
  bridgeUrl: string;
  sessionId: string;
  token: string;
  protocolVersion: number;
  /**
   * Canonical project root — used only to relativize stylesheet source
   * hints before they leave the page. Never sent to the bridge.
   */
  projectRoot?: string;
  /** Element picking strategy — defaults to `generic-dom`. */
  mode?: RuntimeMode;
  /**
   * Same-origin `EventSource` endpoint served by the RootRay static
   * server. On any message the page reloads — how Quick Edit saves get
   * applied when the app has no HMR machinery of its own.
   */
  reloadUrl?: string;
}

/** Minimal socket contract — `WebSocket` satisfies this structurally. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type RuntimePhase = "idle" | "connecting" | "ready" | "inspecting" | "disconnected";

export interface RuntimeOptions {
  config: RuntimeConfig;
  socketFactory: (url: string) => BridgeSocket;
  document?: Document;
  window?: Pick<Window, "requestAnimationFrame" | "addEventListener" | "removeEventListener">;
  /** Called on every phase transition — used by tests and diagnostics. */
  onPhaseChange?: (phase: RuntimePhase) => void;
}

const SOCKET_OPEN = 1;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

export class InspectorRuntime {
  private cfg: RuntimeConfig;
  private socketFactory: (url: string) => BridgeSocket;
  private doc: Document;
  private win: Pick<Window, "requestAnimationFrame" | "addEventListener" | "removeEventListener">;
  private onPhaseChange: ((phase: RuntimePhase) => void) | undefined;

  private socket: BridgeSocket | null = null;
  private overlay: InspectorOverlay;
  private phase: RuntimePhase = "idle";
  private inspecting = false;
  private destroyed = false;
  private rejected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFrame = 0;
  private lastPointerTarget: unknown = null;
  private listenersActive = false;
  private reloadSource: { close(): void } | null = null;

  constructor(opts: RuntimeOptions) {
    this.cfg = opts.config;
    this.socketFactory = opts.socketFactory;
    this.doc = opts.document ?? document;
    this.win = opts.window ?? window;
    this.onPhaseChange = opts.onPhaseChange;
    this.overlay = new InspectorOverlay(this.doc);
  }

  getPhase(): RuntimePhase {
    return this.phase;
  }

  isInspecting(): boolean {
    return this.inspecting;
  }

  start(): void {
    if (this.destroyed) return;
    // The inspect toggle works regardless of mode — unlike the inspect
    // listeners, this one is always attached.
    this.doc.addEventListener("keydown", this.onToggleKey, true);
    this.connect();
    this.connectReload();
  }

  /** Full teardown: listeners off, overlay removed, socket closed, no retry. */
  destroy(): void {
    this.destroyed = true;
    this.doc.removeEventListener("keydown", this.onToggleKey, true);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.removeListeners();
    this.overlay.destroy();
    try {
      this.socket?.close();
    } catch {
      /* socket may already be dead */
    }
    this.socket = null;
    this.reloadSource?.close();
    this.reloadSource = null;
    this.setPhase("idle");
  }

  /**
   * Static-server reload channel. A bare SSE `data:` frame means "files
   * changed" — the whole page reloads so re-served HTML/CSS/JS applies.
   * EventSource auto-reconnects; failures are silent and harmless.
   */
  private connectReload(): void {
    if (!this.cfg.reloadUrl || this.reloadSource) return;
    try {
      const es = new EventSource(this.cfg.reloadUrl);
      es.onmessage = () => this.doc.location.reload();
      this.reloadSource = es;
    } catch {
      /* EventSource unavailable — reload channel simply absent */
    }
  }

  // --- connection -----------------------------------------------------------

  private connect(): void {
    if (this.destroyed || this.rejected) return;
    this.setPhase("connecting");
    let socket: BridgeSocket;
    try {
      socket = this.socketFactory(this.cfg.bridgeUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.send(serializeMessage(helloMessage(this.cfg.sessionId, this.cfg.token, this.doc.URL)));
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => {
      this.socket = null;
      if (this.destroyed || this.rejected) return;
      this.setInspecting(false);
      this.setPhase("disconnected");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.rejected) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.setPhase("disconnected");
  }

  private send(data: string): void {
    try {
      if (this.socket && this.socket.readyState === SOCKET_OPEN) this.socket.send(data);
    } catch {
      /* send failures surface via onclose */
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const parsed = parseBridgeMessage(data);
    if (!parsed.ok) return;
    const msg = parsed.message;
    switch (msg.type) {
      case "session:accepted":
        if (msg.sessionId !== this.cfg.sessionId) return;
        this.reconnectAttempts = 0;
        this.send(serializeMessage(readyMessage(this.cfg.sessionId)));
        this.setPhase(this.inspecting ? "inspecting" : "ready");
        break;
      case "session:rejected":
        this.rejected = true;
        this.setPhase("disconnected");
        break;
      case "inspect:set":
        this.applyInspectSet(msg);
        break;
    }
  }

  private applyInspectSet(msg: BridgeMessage & { type: "inspect:set" }): void {
    this.setInspecting(msg.enabled);
    this.setPhase(msg.enabled ? "inspecting" : "ready");
  }

  private setPhase(phase: RuntimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhaseChange?.(phase);
  }

  // --- inspection -------------------------------------------------------------

  private setInspecting(enabled: boolean): void {
    if (this.inspecting === enabled) return;
    this.inspecting = enabled;
    if (enabled) {
      this.addListeners();
    } else {
      this.removeListeners();
      this.overlay.hide();
    }
  }

  private addListeners(): void {
    if (this.listenersActive) return;
    this.listenersActive = true;
    // Capture phase: we see events before app handlers and can suppress them.
    this.doc.addEventListener("mouseover", this.onPointerMove, true);
    this.doc.addEventListener("mousemove", this.onPointerMove, true);
    this.doc.addEventListener("mousedown", this.onSuppress, true);
    this.doc.addEventListener("click", this.onSelect, true);
    this.doc.addEventListener("keydown", this.onKeydown, true);
    this.doc.addEventListener("scroll", this.onRefresh, true);
    this.win.addEventListener("resize", this.onRefresh);
  }

  private removeListeners(): void {
    if (!this.listenersActive) return;
    this.listenersActive = false;
    this.doc.removeEventListener("mouseover", this.onPointerMove, true);
    this.doc.removeEventListener("mousemove", this.onPointerMove, true);
    this.doc.removeEventListener("mousedown", this.onSuppress, true);
    this.doc.removeEventListener("click", this.onSelect, true);
    this.doc.removeEventListener("keydown", this.onKeydown, true);
    this.doc.removeEventListener("scroll", this.onRefresh, true);
    this.win.removeEventListener("resize", this.onRefresh);
  }

  private onPointerMove = (event: Event): void => {
    this.lastPointerTarget = event.target;
    if (this.pendingFrame) return;
    this.pendingFrame = this.win.requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.highlight(this.lastPointerTarget);
    });
  };

  /**
   * The element a pointer event inspects.
   * `jsx-meta`: nearest instrumented ancestor (unchanged legacy path).
   * `generic-dom`: the element itself — every DOM node is inspectable,
   * including `<canvas>` surfaces and runtime-created elements.
   */
  private pickTarget(target: unknown): Element | null {
    if (this.cfg.mode === "jsx-meta") {
      return findInstrumentedElement(target);
    }
    if (
      target &&
      typeof target === "object" &&
      "nodeType" in target &&
      (target as Node).nodeType === 1
    ) {
      return target as Element;
    }
    return null;
  }

  private highlight(target: unknown): void {
    if (!this.inspecting) return;
    const el = this.pickTarget(target);
    if (!el) {
      this.overlay.hide();
      return;
    }
    // Source is optional — an unresolved element still highlights and
    // reports facts/styles; the label just has no location to show.
    const source = readSourceLocation(el);
    this.overlay.show(el, elementFacts(el), source);
  }

  /** Suppresses focus/active side-effects of a click on an inspected target. */
  private onSuppress = (event: Event): void => {
    if (!this.inspecting) return;
    if (this.pickTarget(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private onSelect = (event: Event): void => {
    if (!this.inspecting) return;
    const el = this.pickTarget(event.target);
    if (!el) return;
    // The selected click never reaches the app: no navigation, no submit,
    // no React handlers.
    event.preventDefault();
    event.stopImmediatePropagation();
    const source = readSourceLocation(el);
    // jsx-meta keeps the legacy contract: only elements that resolve to
    // an authored source are selectable — a corrupt/absent stamp is not
    // reported as "unmapped". generic-dom reports the element anyway.
    if (this.cfg.mode === "jsx-meta" && !source) return;
    this.overlay.show(el, elementFacts(el), source);
    // Style details are collected on selection only — never on hover.
    const styles = collectStyleDetails(el, this.cfg.projectRoot ?? "") ?? undefined;
    this.send(
      serializeMessage(
        elementSelectedMessage(this.cfg.sessionId, elementFacts(el), source ?? undefined, styles),
      ),
    );
  };

  private onKeydown = (event: KeyboardEvent): void => {
    if (!this.inspecting || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Report the request so RootRay stays the single source of truth; the
    // bridge echoes an authoritative inspect:set(false) back.
    this.send(serializeMessage(inspectSetMessage(false)));
    this.setInspecting(false);
    this.setPhase("ready");
  };

  /**
   * Ctrl+Shift+C — the inspect toggle for keyboard-first use. Always
   * listening (inspect or not), applies locally and reports the request
   * so the bridge stays the single source of truth.
   */
  private onToggleKey = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== "KeyC") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const next = !this.inspecting;
    this.send(serializeMessage(inspectSetMessage(next)));
    this.setInspecting(next);
    this.setPhase(next ? "inspecting" : "ready");
  };

  private onRefresh = (): void => {
    if (this.pendingFrame) return;
    this.pendingFrame = this.win.requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.overlay.refresh();
    });
  };
}
