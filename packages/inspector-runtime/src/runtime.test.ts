// @vitest-environment happy-dom

import { ROOTRAY_PROTOCOL_VERSION } from "@rootray/source-protocol";
import { describe, expect, it, vi } from "vitest";
import { elementFacts, findInstrumentedElement, readSourceLocation } from "./metadata";
import { InspectorOverlay, OVERLAY_HOST_ATTR } from "./overlay";
import { type BridgeSocket, InspectorRuntime, type RuntimeConfig } from "./runtime";

const CFG = {
  bridgeUrl: "ws://127.0.0.1:4444/rootray",
  sessionId: "sess-test",
  token: "tok-test",
  protocolVersion: ROOTRAY_PROTOCOL_VERSION,
  mode: "jsx-meta" as const,
};

const CFG_GENERIC = { ...CFG, mode: "generic-dom" as const };

/** Controllable fake bridge socket. */
class FakeSocket implements BridgeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function makeRuntime(config: RuntimeConfig = CFG) {
  const socket = new FakeSocket();
  const phases: string[] = [];
  const rt = new InspectorRuntime({
    config,
    socketFactory: () => socket,
    document,
    window,
    onPhaseChange: (p) => phases.push(p),
  });
  return { socket, rt, phases };
}

function handshake(socket: FakeSocket) {
  socket.open();
  socket.receive({ version: 1, type: "session:accepted", sessionId: CFG.sessionId });
}

function instrumentedButton(): HTMLElement {
  document.body.innerHTML = `
    <main><section>
      <button id="go" class="cta"
        data-rootray-file="src/components/Btn.tsx"
        data-rootray-line="12" data-rootray-column="9"
        data-rootray-component="Btn">Go now</button>
    </section></main>`;
  return document.querySelector("button")!;
}

describe("metadata", () => {
  it("reads a stamped source location", () => {
    const btn = instrumentedButton();
    expect(readSourceLocation(btn)).toEqual({
      relativePath: "src/components/Btn.tsx",
      line: 12,
      column: 9,
      componentName: "Btn",
      confidence: "exact",
    });
  });

  it("fills componentName from the fiber owner chain when unstamped", () => {
    document.body.innerHTML = `
      <div data-rootray-file="src/App.tsx" data-rootray-line="4"
        data-rootray-column="3"></div>`;
    const el = document.querySelector("div")!;
    // Simulate React 19 dev internals: host fiber whose _debugOwner is the
    // component that authored the element.
    function Card() {}
    (el as unknown as Record<string, unknown>).__reactFiber$abc = {
      type: "div",
      _debugOwner: { type: Card },
    };
    expect(readSourceLocation(el)!.componentName).toBe("Card");
  });

  it("leaves componentName unset when no fiber exists", () => {
    document.body.innerHTML = `
      <div data-rootray-file="src/App.tsx" data-rootray-line="4"
        data-rootray-column="3"></div>`;
    const loc = readSourceLocation(document.querySelector("div")!)!;
    expect(loc.componentName).toBeUndefined();
    expect(loc.confidence).toBe("exact");
  });

  it("finds the nearest instrumented ancestor from a child", () => {
    document.body.innerHTML = `
      <div data-rootray-file="src/App.tsx" data-rootray-line="4" data-rootray-column="3">
        <span id="inner">text</span></div>`;
    const inner = document.getElementById("inner")!;
    const found = findInstrumentedElement(inner);
    expect(found?.getAttribute("data-rootray-file")).toBe("src/App.tsx");
  });

  it("returns null for non-instrumented trees", () => {
    document.body.innerHTML = "<div><p>plain</p></div>";
    expect(findInstrumentedElement(document.querySelector("p"))).toBeNull();
  });

  it("rejects malformed metadata", () => {
    document.body.innerHTML =
      '<div data-rootray-file="x.tsx" data-rootray-line="0" data-rootray-column="2"></div>';
    expect(readSourceLocation(document.querySelector("div")!)).toBeNull();
  });

  it("bounds the text preview", () => {
    document.body.innerHTML = `<div>${"x".repeat(500)}</div>`;
    const facts = elementFacts(document.querySelector("div")!);
    expect(facts.textPreview!.length).toBeLessThanOrEqual(80);
  });
});

describe("overlay", () => {
  it("injects an isolated shadow host and cleans it up", () => {
    const overlay = new InspectorOverlay(document);
    const btn = instrumentedButton();
    overlay.show(btn, elementFacts(btn), readSourceLocation(btn)!);
    const host = document.documentElement.querySelector(`[${OVERLAY_HOST_ATTR}]`);
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).not.toBeNull();
    const label = host!.shadowRoot!.querySelector(".rr-label");
    expect(label?.textContent).toContain("Btn");
    expect(label?.textContent).toContain("src/components/Btn.tsx:12");
    overlay.destroy();
    expect(document.documentElement.querySelector(`[${OVERLAY_HOST_ATTR}]`)).toBeNull();
  });
});

describe("runtime protocol flow", () => {
  it("sends hello on open and ready after accept", () => {
    const { socket, rt } = makeRuntime();
    rt.start();
    socket.open();
    const hello = JSON.parse(socket.sent[0]!);
    expect(hello).toMatchObject({
      type: "runtime:hello",
      sessionId: "sess-test",
      token: "tok-test",
    });
    socket.receive({ version: 1, type: "session:accepted", sessionId: "sess-test" });
    const ready = JSON.parse(socket.sent[1]!);
    expect(ready.type).toBe("runtime:ready");
    rt.destroy();
  });

  it("ignores an accept for a different session", () => {
    const { socket, rt } = makeRuntime();
    rt.start();
    socket.open();
    socket.receive({ version: 1, type: "session:accepted", sessionId: "other" });
    expect(socket.sent).toHaveLength(1);
    rt.destroy();
  });

  it("does not reconnect after session:rejected", () => {
    vi.useFakeTimers();
    try {
      const { socket, rt } = makeRuntime();
      rt.start();
      socket.open();
      socket.receive({ version: 1, type: "session:rejected", reason: "bad token" });
      socket.close();
      vi.advanceTimersByTime(60_000);
      expect(rt.getPhase()).not.toBe("connecting");
      rt.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inspection", () => {
  it("sends a selection on click while inspecting", () => {
    const { socket, rt } = makeRuntime();
    const btn = instrumentedButton();
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const sel = socket.sent.map((m) => JSON.parse(m)).find((m) => m.type === "element:selected");
    expect(sel).toBeTruthy();
    expect(sel.source).toMatchObject({
      relativePath: "src/components/Btn.tsx",
      line: 12,
      column: 9,
    });
    rt.destroy();
  });

  it("suppresses the app click while inspecting, restores it after", () => {
    const { socket, rt } = makeRuntime();
    const btn = instrumentedButton();
    let clicks = 0;
    btn.addEventListener("click", () => clicks++);
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(0);
    socket.receive({ version: 1, type: "inspect:set", enabled: false });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    rt.destroy();
  });

  it("does not select non-instrumented elements", () => {
    const { socket, rt } = makeRuntime();
    document.body.innerHTML = "<p>plain</p>";
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(socket.sent.some((m) => m.includes("element:selected"))).toBe(false);
    rt.destroy();
  });

  it("does not select instrumented elements with invalid stamped paths", () => {
    const { socket, rt } = makeRuntime();
    document.body.innerHTML =
      '<div data-rootray-file="../../secret.txt" data-rootray-line="1" data-rootray-column="1"></div>';
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document.querySelector("div")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(socket.sent.some((m) => m.includes("element:selected"))).toBe(false);
    rt.destroy();
  });

  it("Escape requests inspection off and restores app clicks", () => {
    const { socket, rt } = makeRuntime();
    const btn = instrumentedButton();
    let clicks = 0;
    btn.addEventListener("click", () => clicks++);
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    const req = socket.sent.map((m) => JSON.parse(m)).find((m) => m.type === "inspect:set");
    expect(req).toMatchObject({ enabled: false });
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    rt.destroy();
  });

  it("cleans up listeners and overlay on destroy", () => {
    const { socket, rt } = makeRuntime();
    const btn = instrumentedButton();
    let clicks = 0;
    btn.addEventListener("click", () => clicks++);
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    rt.destroy();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(1);
    expect(document.documentElement.querySelector(`[${OVERLAY_HOST_ATTR}]`)).toBeNull();
  });
});

describe("generic-dom mode", () => {
  it("selects elements with no source metadata and omits source", () => {
    const { socket, rt } = makeRuntime(CFG_GENERIC);
    document.body.innerHTML = '<div class="runtime-card"><span id="t">made by JS</span></div>';
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document
      .getElementById("t")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const sel = socket.sent.map((m) => JSON.parse(m)).find((m) => m.type === "element:selected");
    expect(sel).toBeTruthy();
    expect(sel.element.tagName).toBe("span");
    expect("source" in sel).toBe(false);
    rt.destroy();
  });

  it("maps authored stamped elements to their HTML source", () => {
    const { socket, rt } = makeRuntime(CFG_GENERIC);
    document.body.innerHTML =
      '<canvas id="arena" data-rootray-file="index.html" data-rootray-line="4" data-rootray-column="3"></canvas>';
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document
      .getElementById("arena")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const sel = socket.sent.map((m) => JSON.parse(m)).find((m) => m.type === "element:selected");
    expect(sel.element.tagName).toBe("canvas");
    expect(sel.source).toMatchObject({
      relativePath: "index.html",
      line: 4,
      column: 3,
      confidence: "exact",
    });
    rt.destroy();
  });

  it("shows the overlay for source-less elements", () => {
    const { socket, rt } = makeRuntime(CFG_GENERIC);
    document.body.innerHTML = "<div><p id='p'>plain</p></div>";
    const overlay = new InspectorOverlay(document);
    void overlay; // runtime owns its own overlay
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document.getElementById("p")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    // Flush the rAF-throttled highlight.
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const host = document.documentElement.querySelector(`[${OVERLAY_HOST_ATTR}]`);
        const label = host?.shadowRoot?.querySelector(".rr-label");
        expect(label?.textContent).toContain("no source");
        rt.destroy();
        resolve();
      });
    });
  });

  it("suppresses clicks on every element while inspecting", () => {
    const { socket, rt } = makeRuntime(CFG_GENERIC);
    document.body.innerHTML = "<p>plain</p>";
    let clicks = 0;
    document.querySelector("p")!.addEventListener("click", () => clicks++);
    rt.start();
    handshake(socket);
    socket.receive({ version: 1, type: "inspect:set", enabled: true });
    document
      .querySelector("p")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(clicks).toBe(0);
    rt.destroy();
  });
});
