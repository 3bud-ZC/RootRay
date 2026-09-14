import { describe, expect, it } from "vitest";
import { instrumentSource, relativeSourcePath, shouldInstrument } from "./instrument";
import rootrayInspector from "./plugin";

const ROOT = "/project";
const ID = "/project/src/App.tsx";

function instrument(code: string, id = ID) {
  return instrumentSource({ id, projectRoot: ROOT, code });
}

describe("shouldInstrument", () => {
  it("accepts project-owned jsx/tsx files", () => {
    for (const id of [
      "/project/src/App.tsx",
      "/project/src/main.jsx",
      "/project/src/util.ts",
      "/project/src/legacy.js",
    ]) {
      expect(shouldInstrument(id, ROOT), id).toBe(true);
    }
  });

  it("skips node_modules, virtual modules, queries and .d.ts", () => {
    for (const id of [
      "/project/node_modules/react/index.js",
      "/project/node_modules/pkg/Comp.tsx",
      "\0virtual:plugin",
      "/project/src/App.tsx?raw",
      "/project/src/types.d.ts",
      "/project/dist/bundle.js",
    ]) {
      expect(shouldInstrument(id, ROOT), id).toBe(false);
    }
  });

  it("rejects files outside the project root", () => {
    expect(shouldInstrument("/other/pkg/Comp.tsx", ROOT)).toBe(false);
    expect(relativeSourcePath("/other/x.tsx", ROOT)).toBeNull();
  });

  it("normalizes windows paths to forward slashes", () => {
    const winRoot = "C:\\Users\\dev\\proj";
    expect(relativeSourcePath("C:\\Users\\dev\\proj\\src\\App.tsx", winRoot)).toBe("src/App.tsx");
  });
});

describe("instrumentSource", () => {
  it("stamps file/line/column on a JSX element", () => {
    const code = [
      "export function App() {",
      "  return (",
      '    <button className="login">',
      "      Login",
      "    </button>",
      "  );",
      "}",
    ].join("\n");
    const out = instrument(code)!;
    expect(out.changed).toBe(true);
    expect(out.code).toContain('data-rootray-file="src/App.tsx"');
    expect(out.code).toContain("data-rootray-line={3}");
    expect(out.code).toContain("data-rootray-column={5}");
    expect(out.code).toContain('data-rootray-component="App"');
    expect(out.map).toBeTruthy();
    expect(out.map.mappings.length).toBeGreaterThan(0);
  });

  it("instruments nested and self-closing elements distinctly", () => {
    const code = [
      "const Card = () => (",
      "  <section>",
      "    <h2>Title</h2>",
      '    <img src="x.png" />',
      "    <input value={v} />",
      "  </section>",
      ");",
    ].join("\n");
    const out = instrument(code)!;
    expect(out.code).toContain("data-rootray-line={2}"); // section
    expect(out.code).toContain("data-rootray-line={3}"); // h2
    expect(out.code).toContain("data-rootray-line={4}"); // img
    expect(out.code).toContain("data-rootray-line={5}"); // input
    expect(out.code.match(/data-rootray-file=/g)).toHaveLength(4);
  });

  it("keeps spread props valid and places attrs after the tag", () => {
    const code = `const B = () => <button {...rest} onClick={go}>x</button>;`;
    const out = instrument(code)!;
    expect(out.code).toMatch(/<button\s+data-rootray-file="src\/App\.tsx"[^>]*\{\.\.\.rest\}/);
  });

  it("ignores fragments and non-intrinsic components", () => {
    const code = [
      "const A = () => (",
      "  <>",
      "    <Icon />",
      "    <Foo.Bar />",
      "    <span>ok</span>",
      "  </>",
      ");",
    ].join("\n");
    const out = instrument(code)!;
    // Only the lowercase <span> is instrumented.
    expect(out.code.match(/data-rootray-file=/g)).toHaveLength(1);
    expect(out.code).toContain("<span data-rootray-file");
    expect(out.code).not.toContain("<Icon data-rootray");
    expect(out.code).not.toContain("<Foo.Bar data-rootray");
  });

  it("does not double-instrument existing metadata", () => {
    const code = `const A = () => <div data-rootray-file="src/App.tsx" data-rootray-line={1} data-rootray-column={3}>x</div>;`;
    // Nothing to add → no transform at all.
    expect(instrument(code)).toBeNull();
  });

  it("supports svg and namespaced-free native tags", () => {
    const code = `const I = () => <svg><path d="M0 0"/><circle r="2"/></svg>;`;
    const out = instrument(code)!;
    expect(out.code.match(/data-rootray-file=/g)).toHaveLength(3);
  });

  it("attributes JSX to the enclosing arrow-component variable", () => {
    const code = `const LoginButton = () => <button>Login</button>;`;
    const out = instrument(code)!;
    expect(out.code).toContain('data-rootray-component="LoginButton"');
  });

  it("attributes JSX inside class render() to the class", () => {
    const code = [
      "class Card extends React.Component {",
      "  render() {",
      "    return <div>{this.props.x}</div>;",
      "  }",
      "}",
    ].join("\n");
    const out = instrument(code)!;
    expect(out.code).toContain('data-rootray-component="Card"');
  });

  it("attributes JSX in render callbacks to the outer component", () => {
    const code = [
      "function List({ items }) {",
      "  return <ul>{items.map(i => <li key={i}>{i}</li>)}</ul>;",
      "}",
    ].join("\n");
    const out = instrument(code)!;
    expect(out.code).toMatch(/<li[^>]*data-rootray-component="List"/);
    expect(out.code).toMatch(/<ul[^>]*data-rootray-component="List"/);
  });

  it("omits componentName when ownership is ambiguous", () => {
    const code = `export default function () { return <div />; }`;
    const out = instrument(code)!;
    expect(out.code).toContain('data-rootray-file="src/App.tsx"');
    expect(out.code).not.toContain("data-rootray-component");
  });

  it("instruments plain .js files containing JSX", () => {
    const out = instrument("export const A = () => <p>hi</p>;", "/project/src/a.js")!;
    expect(out.code).toContain('data-rootray-file="src/a.js"');
  });

  it("returns null for files without JSX and for unparseable code", () => {
    expect(instrument("export const x = 1 + 1;")).toBeNull();
    expect(instrument("const = broken <<<")).toBeNull();
  });
});

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
