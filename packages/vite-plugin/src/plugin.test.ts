import { describe, expect, it } from "vitest";
import rootrayInspector from "./plugin";

const ROOT = "/project";

describe("plugin", () => {
  const opts = {
    bridgeUrl: "ws://127.0.0.1:4000/rootray",
    sessionId: "s",
    sessionToken: "t",
    runtimePath: "/tmp/runtime.js",
    projectRoot: ROOT,
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

  it("transformIndexHtml injects config + runtime script", () => {
    const p = rootrayInspector(opts);
    const hook = p.transformIndexHtml as unknown as (html: string) => {
      tags: { tag: string; children?: string }[];
    };
    const result = hook("<html><head></head><body></body></html>");
    const tags = Array.isArray(result) ? result : result.tags;
    expect(tags.some((t) => t.children?.includes("window.__ROOTRAY__"))).toBe(true);
    const cfg = tags.find((t) => t.children?.includes("window.__ROOTRAY__"))!.children!;
    expect(cfg).toContain('"sessionId":"s"');
    expect(cfg).toContain('"bridgeUrl":"ws://127.0.0.1:4000/rootray"');
  });
});
