import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import rootrayInspector from "./plugin";

// HTML stamping is only applied when the served markup is byte-identical
// to a real authored file, so tests exercise real on-disk documents.
function htmlFixture(rel: string, content: string): { root: string; filename: string } {
  const root = mkdtempSync(join(tmpdir(), "rootray-plugin-"));
  const filename = join(root, rel);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content, "utf8");
  return { root, filename };
}

type HtmlResult = { html: string; tags: { tag: string; children?: string }[] };

/** Extracts the handler from the `{ order: "pre", handler }` hook form. */
function htmlHook(p: ReturnType<typeof rootrayInspector>) {
  const hook = p.transformIndexHtml as unknown as {
    order: string;
    handler: (html: string, ctx: { filename: string }) => HtmlResult;
  };
  expect(hook.order).toBe("pre");
  return hook.handler;
}

describe("plugin", () => {
  const opts = {
    bridgeUrl: "ws://127.0.0.1:4000/rootray",
    sessionId: "s",
    sessionToken: "t",
    runtimePath: "/tmp/runtime.js",
    projectRoot: "/project",
  };

  it("is serve-only and runs pre-transform", () => {
    const p = rootrayInspector(opts);
    expect(p.apply).toBe("serve");
    expect(p.enforce).toBe("pre");
  });

  it("transform returns null for out-of-scope ids", () => {
    const p = rootrayInspector(opts);
    const t = p.transform as (code: string, id: string) => unknown;
    expect(t.call({} as never, "const x = <div/>;", "/project/node_modules/a/b.js")).toBeNull();
  });

  it("transformIndexHtml runs pre-order so stamps match authored lines", () => {
    const p = rootrayInspector(opts);
    const hook = p.transformIndexHtml as unknown as { order?: string };
    // Must be "pre": Vite's internal devHtmlHook prepends /@vite/client
    // before "normal" hooks — stamping after it would offset line numbers.
    expect(hook.order).toBe("pre");
  });

  it("transformIndexHtml injects config + runtime script", () => {
    const html = "<html><head></head><body></body></html>";
    const { root, filename } = htmlFixture("index.html", html);
    const p = rootrayInspector({ ...opts, projectRoot: root });
    const hook = htmlHook(p);
    const result = hook(html, { filename });
    const tags = Array.isArray(result) ? result : result.tags;
    expect(tags.some((t) => t.children?.includes("window.__ROOTRAY__"))).toBe(true);
    const cfg = tags.find((t) => t.children?.includes("window.__ROOTRAY__"))!.children!;
    expect(cfg).toContain('"sessionId":"s"');
    expect(cfg).toContain('"bridgeUrl":"ws://127.0.0.1:4000/rootray"');
    // The runtime reads cfg.token — a sessionToken-keyed config fails auth.
    expect(cfg).toContain('"token":"t"');
  });

  it("transformIndexHtml stamps authored elements and defaults to jsx-meta", () => {
    const html =
      '<html>\n<body>\n<div id="root"></div>\n<canvas id="c"></canvas>\n</body>\n</html>';
    const { root, filename } = htmlFixture("index.html", html);
    const p = rootrayInspector({ ...opts, projectRoot: root });
    const hook = htmlHook(p);
    const result = hook(html, { filename });
    // Authored DOM elements carry exact source locations.
    expect(result.html).toContain(
      '<div data-rootray-file="index.html" data-rootray-line="3" data-rootray-column="1" id="root">',
    );
    expect(result.html).toContain(
      '<canvas data-rootray-file="index.html" data-rootray-line="4" data-rootray-column="1" id="c">',
    );
    const cfg = result.tags.find((t) => t.children?.includes("window.__ROOTRAY__"))!.children!;
    // No mode key when the option is absent — runtime default is used.
    expect(cfg).not.toContain('"mode"');
  });

  it("transformIndexHtml strips spoofed metadata and carries generic-dom mode", () => {
    const html =
      '<html><body><div data-rootray-file="evil.ts" data-rootray-line="1" data-rootray-column="1"></div></body></html>';
    const { root, filename } = htmlFixture("index.html", html);
    const p = rootrayInspector({ ...opts, projectRoot: root, mode: "generic-dom" });
    const hook = htmlHook(p);
    const result = hook(html, { filename });
    expect(result.html).not.toContain("evil.ts");
    expect(result.html).toContain('data-rootray-file="index.html"');
    const cfg = result.tags.find((t) => t.children?.includes("window.__ROOTRAY__"))!.children!;
    expect(cfg).toContain('"mode":"generic-dom"');
  });

  it("transformIndexHtml works for nested html pages", () => {
    const html = "<html><body><p>hi</p></body></html>";
    const { root, filename } = htmlFixture("pages/about/index.html", html);
    const p = rootrayInspector({ ...opts, projectRoot: root });
    const hook = htmlHook(p);
    const result = hook(html, { filename });
    expect(result.html).toContain('data-rootray-file="pages/about/index.html"');
  });

  it("never stamps rendered/SSR HTML — positions must match an authored file", () => {
    // Frameworks that pipe synthesized markup through transformIndexHtml
    // (SSR output, virtual templates) must not get positions attributed to
    // a file whose bytes differ — misattributed source is worse than none.
    const { root: dir, filename } = htmlFixture(
      "index.html",
      "<html><body><p>authored</p></body></html>",
    );
    const p = rootrayInspector({ ...opts, projectRoot: dir });
    const hook = htmlHook(p);
    // Served markup differs from the file (SSR output) → no stamps, but
    // the runtime/config injection must still be present.
    const rendered = "<html><body><main><p>rendered</p></main></body></html>";
    const result = hook(rendered, { filename });
    expect(result.html).toBe(rendered);
    expect(result.html).not.toContain("data-rootray-file");
    expect(result.tags.some((t) => t.children?.includes("window.__ROOTRAY__"))).toBe(true);
    // And a verbatim file serve still stamps.
    const verbatim = hook("<html><body><p>authored</p></body></html>", { filename });
    expect(verbatim.html).toContain('data-rootray-file="index.html"');
  });
});
