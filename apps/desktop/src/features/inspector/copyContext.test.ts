import { analyzeSources, findComponent, usagesOf } from "@rootray/intelligence";
import type { ElementSelection, SourcePreview, StyleDetails } from "@rootray/shared";
import { describe, expect, it } from "vitest";
import { buildContextBlock } from "./copyContext";

const selection: ElementSelection = {
  element: { tagName: "button", className: "action-button primary" },
  source: {
    relativePath: "src/components/ActionButton.tsx",
    line: 6,
    column: 5,
    componentName: "ActionButton",
  },
};

const styles: StyleDetails = {
  classes: ["action-button", "primary"],
  box: {
    x: 10,
    y: 20,
    width: 120,
    height: 40,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    padding: { top: 12, right: 12, bottom: 12, left: 12 },
    border: { top: 1, right: 1, bottom: 1, left: 1 },
  },
  computed: { display: "block", color: "rgb(230, 237, 243)" },
  matchedRules: [
    {
      selector: ".action-button",
      declarations: [{ property: "padding", value: "12px", important: false }],
      sourcePath: "src/styles/button.css",
    },
  ],
};

const preview: SourcePreview = {
  relativePath: "src/components/ActionButton.tsx",
  selectedLine: 6,
  startLine: 3,
  endLine: 9,
  lines: [
    { n: 3, text: "export function ActionButton() {" },
    { n: 4, text: "  const [count, setCount] = useState(0);" },
    { n: 5, text: "  return (" },
    { n: 6, text: "    <button" },
    { n: 7, text: '      className="action-button primary"' },
  ],
};

const intel = analyzeSources([
  {
    relativePath: "src/components/ActionButton.tsx",
    content: "export function ActionButton() { return <button/> }",
  },
  {
    relativePath: "src/components/Card.tsx",
    content:
      'import { ActionButton } from "./ActionButton"; export function Card() { return <ActionButton/> }',
  },
]);
const def = findComponent(intel, "ActionButton", "src/components/ActionButton.tsx")!;
const usedBy = usagesOf(intel, def).map((u) => u.usedIn);

describe("buildContextBlock", () => {
  const block = buildContextBlock({ ...selection, styles }, preview, usedBy);

  it("includes component, source and tag", () => {
    expect(block).toContain("Component: ActionButton");
    expect(block).toContain("Source: src/components/ActionButton.tsx:6:5");
    expect(block).toContain("Tag: button");
  });

  it("includes classes and matched style sources", () => {
    expect(block).toContain("Classes: action-button primary");
    expect(block).toContain("- src/styles/button.css");
  });

  it("includes resolved used-by entries", () => {
    expect(block).toContain("Used by:");
    expect(block).toContain("- src/components/Card.tsx:");
  });

  it("includes a bounded source snippet", () => {
    expect(block).toContain("Selected source:");
    expect(block).toContain("6:     <button");
    expect(block.length).toBeLessThanOrEqual(4000);
  });

  it("never contains absolute paths or secret material", () => {
    expect(block).not.toMatch(/[A-Z]:\\/);
    expect(block).not.toMatch(/\/Users\//);
    expect(block).not.toContain(".env");
  });

  it("works without styles, preview or intel", () => {
    const minimal = buildContextBlock(
      { element: { tagName: "div" }, source: { relativePath: "src/a.tsx", line: 1, column: 1 } },
      null,
      null,
    );
    expect(minimal).toContain("Source: src/a.tsx:1:1");
    expect(minimal).not.toContain("Used by:");
  });
});
