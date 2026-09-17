import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { ATTR_COLUMN, ATTR_FILE, ATTR_LINE, instrumentHtml } from "./index.js";

const FILE = "index.html";

function stampCount(html: string): number {
  return (html.match(/data-rootray-file=/g) ?? []).length;
}

/** Reparse output and return { tag → [line, column] } for stamped attrs. */
function stampedPositions(html: string): Map<string, { line: number; column: number }[]> {
  const out = new Map<string, { line: number; column: number }[]>();
  const doc = parse(html);
  const walk = (n: unknown) => {
    const el = n as {
      tagName?: string;
      attrs?: { name: string; value: string }[];
      childNodes?: unknown[];
      content?: { childNodes?: unknown[] };
    };
    if (el.tagName && el.attrs) {
      const f = el.attrs.find((a) => a.name === ATTR_FILE);
      const l = el.attrs.find((a) => a.name === ATTR_LINE);
      const c = el.attrs.find((a) => a.name === ATTR_COLUMN);
      if (f && l && c) {
        const list = out.get(el.tagName) ?? [];
        list.push({ line: Number(l.value), column: Number(c.value) });
        out.set(el.tagName, list);
      }
      if (el.tagName === "template" && el.content?.childNodes) {
        for (const ch of el.content.childNodes) walk(ch);
      }
    }
    for (const ch of el.childNodes ?? []) walk(ch);
  };
  walk(doc);
  return out;
}

describe("instrumentHtml", () => {
  it("stamps authored elements with exact line/column", () => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head><title>t</title></head>",
      "<body>",
      '  <div id="app">',
      '    <button class="go">Go</button>',
      "  </div>",
      "</body>",
      "</html>",
    ].join("\n");
    const out = instrumentHtml(html, FILE);
    // div + button stamped; html/head/body/title skipped.
    expect(out.stamped).toBe(2);
    const positions = stampedPositions(out.code);
    expect(positions.get("div")).toEqual([{ line: 5, column: 3 }]);
    expect(positions.get("button")).toEqual([{ line: 6, column: 5 }]);
    // Stamped values land on real attributes that reparse identically.
    expect(out.code).toContain(
      '<div data-rootray-file="index.html" data-rootray-line="5" data-rootray-column="3" id="app">',
    );
    expect(out.code).toContain(
      '<button data-rootray-file="index.html" data-rootray-line="6" data-rootray-column="5" class="go">',
    );
  });

  it("skips non-renderable tags but stamps authored body children", () => {
    const html =
      '<html><head><meta charset="utf-8"><script src="x.js"></script><style>a{}</style></head><body><p>hi</p></body></html>';
    const out = instrumentHtml(html, FILE);
    expect(out.stamped).toBe(1);
    expect(out.code).toContain("<p data-rootray-file=");
    expect(out.code).not.toContain("<script data-rootray-file=");
    expect(out.code).not.toContain("<style data-rootray-file=");
    expect(out.code).not.toContain("<meta data-rootray-file=");
    expect(out.code).not.toContain("<body data-rootray-file=");
  });

  it("stamps a canvas element like any other authored DOM node", () => {
    const html = '<body><canvas id="arena" width="640"></canvas></body>';
    const out = instrumentHtml(html, FILE);
    expect(out.code).toContain(
      '<canvas data-rootray-file="index.html" data-rootray-line="1" data-rootray-column="7" id="arena" width="640">',
    );
  });

  it("stamps self-closing foreign elements without corrupting the tag", () => {
    const html = '<body><svg><path d="M0 0"/><circle r="2"/></svg></body>';
    const out = instrumentHtml(html, FILE);
    expect(out.stamped).toBe(3);
    const reparsed = stampedPositions(out.code);
    expect(reparsed.get("path")?.length).toBe(1);
    expect(reparsed.get("circle")?.length).toBe(1);
    // `/>` preserved.
    expect(out.code).toContain('r="2"/>');
  });

  it("strips authored data-rootray-* attributes before stamping", () => {
    const html = [
      "<body>",
      '  <div data-rootray-file="etc/passwd" data-rootray-line="1" data-rootray-column="1">x</div>',
      '  <span DATA-ROOTRAY-FILE="spoof.ts">y</span>',
      "</body>",
    ].join("\n");
    const out = instrumentHtml(html, FILE);
    expect(out.removedReserved).toBe(4);
    expect(out.code).not.toContain("etc/passwd");
    expect(out.code).not.toContain("spoof.ts");
    // Fresh trusted stamps exist.
    expect(out.code).toContain('<div data-rootray-file="index.html" data-rootray-line="2"');
    const reparsed = stampedPositions(out.code);
    expect(reparsed.get("span")).toEqual([{ line: 3, column: 3 }]);
  });

  it("stamps elements inside <template> content", () => {
    const html = '<body><template><li class="row">x</li></template></body>';
    const out = instrumentHtml(html, FILE);
    expect(out.stamped).toBe(1);
    const reparsed = stampedPositions(out.code);
    expect(reparsed.get("li")).toEqual([{ line: 1, column: 17 }]);
  });

  it("leaves comments, scripts and raw text byte-identical", () => {
    const html = [
      "<!-- a <div> inside a comment -->",
      '<script>const s = "<div data-rootray-file=\\"fake\\">";</script>',
      "<style>.x{content:'<p>'}</style>",
      '<div id="real">ok</div>',
    ].join("\n");
    const out = instrumentHtml(html, FILE);
    expect(out.code).toContain("a <div> inside a comment");
    expect(out.code).toContain('data-rootray-file=\\"fake\\"'); // script text untouched
    expect(stampCount(out.code)).toBe(2); // script text div is NOT a tag; real div is — plus none inside comment
    const reparsed = stampedPositions(out.code);
    expect(reparsed.get("div")).toEqual([{ line: 4, column: 1 }]);
  });

  it("handles malformed-but-recoverable markup", () => {
    const html = "<body><p>one<p>two<li>a<li>b</body>";
    const out = instrumentHtml(html, FILE);
    // Every authored start tag is stamped regardless of implied closes.
    expect(stampCount(out.code)).toBe(4);
  });

  it("stamps void elements", () => {
    const html = '<body><img src="a.png"><br><input type="text"></body>';
    const out = instrumentHtml(html, FILE);
    expect(out.stamped).toBe(3);
  });

  it("escapes attribute values", () => {
    const html = '<body><div title="a&quot;b">x</div></body>';
    const out = instrumentHtml(html, 'dir/"quoted".html');
    expect(out.code).toContain('data-rootray-file="dir/&quot;quoted&quot;.html"');
  });

  it("is idempotent across double instrumentation", () => {
    const html = "<body><div>x</div></body>";
    const once = instrumentHtml(html, FILE);
    const twice = instrumentHtml(once.code, FILE);
    expect(stampCount(twice.code)).toBe(1);
    expect(twice.stamped).toBe(1);
    expect(twice.removedReserved).toBe(3); // prior stamp stripped, then restamped
  });
});
