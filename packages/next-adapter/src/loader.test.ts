import { describe, expect, it } from "vitest";
import loader, { relativeSpecifier } from "./loader";

const ROOT = "/project";
const ENTRY = "/project/node_modules/.cache/rootray-s/entry.js";

function run(code: string, resourcePath: string) {
  let out: { code?: string | undefined; map?: unknown } = {};
  const result = loader.call(
    {
      resourcePath,
      getOptions: () => ({ projectRoot: ROOT, entryPath: ENTRY }),
      callback: (_err, c, m) => {
        out = { code: c, map: m };
      },
    },
    code,
  );
  return result === undefined ? out : { code: result };
}

describe("relativeSpecifier", () => {
  it("emits a relative posix specifier", () => {
    expect(relativeSpecifier("/project/app/page.tsx", ENTRY)).toBe(
      "../node_modules/.cache/rootray-s/entry.js",
    );
    expect(relativeSpecifier("/project/page.tsx", ENTRY)).toBe(
      "./node_modules/.cache/rootray-s/entry.js",
    );
  });
});

describe("rootrayJsxLoader", () => {
  it("instruments project JSX and imports the entry relatively", () => {
    const { code, map } = run(
      ["export function Page() {", "  return <main><p>hi</p></main>;", "}"].join("\n"),
      "/project/app/page.tsx",
    );
    expect(code).toContain('data-rootray-file="app/page.tsx"');
    expect(code).toContain('import "../node_modules/.cache/rootray-s/entry.js"');
    expect(map).toBeTruthy();
    expect(typeof map).toBe("object");
  });

  it('keeps the "use client" directive before the entry import', () => {
    const { code } = run(
      ['"use client";', "export const B = () => <button>x</button>;"].join("\n"),
      "/project/components/B.tsx",
    );
    expect(code!.indexOf('"use client"')).toBeLessThan(code!.indexOf("entry.js"));
  });

  it("passes through node_modules, .next and non-project files", () => {
    for (const p of [
      "/project/node_modules/pkg/index.js",
      "/project/.next/cache/x.js",
      "/other/file.tsx",
    ]) {
      const { code } = run("const A = () => <div/>;", p);
      expect(code).toBe("const A = () => <div/>;");
    }
  });

  it("passes through files without JSX unchanged", () => {
    const { code } = run("export const x = 1;", "/project/lib/x.ts");
    expect(code).toBe("export const x = 1;");
  });
});
