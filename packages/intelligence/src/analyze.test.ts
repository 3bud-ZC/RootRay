import { describe, expect, it } from "vitest";
import { analyzeSources, findComponent, usagesOf } from "./analyze";

const NAVBAR = `import Logo from "./Logo";

export function Navbar() {
  return (
    <nav className="navbar">
      <Logo />
      <a href="#home">Home</a>
    </nav>
  );
}
`;

const LOGO = `export const Logo = () => {
  return <span className="logo">R</span>;
};

export default Logo;
`;

const CARD = `import type { ReactNode } from "react";
import { ActionButton } from "./ActionButton";

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
      <ActionButton />
      <ActionButton />
    </section>
  );
}
`;

const BUTTON = `export function ActionButton() {
  return <button type="button" className="action-button primary">Go</button>;
}
`;

const APP = `import { Card } from "./components/Card";
import { Navbar } from "./components/Navbar";

export function App() {
  return (
    <main>
      <Navbar />
      <Card title="t"><p>x</p></Card>
    </main>
  );
}
`;

const FIXTURE = [
  { relativePath: "src/App.tsx", content: APP },
  { relativePath: "src/components/Navbar.tsx", content: NAVBAR },
  { relativePath: "src/components/Logo.tsx", content: LOGO },
  { relativePath: "src/components/Card.tsx", content: CARD },
  { relativePath: "src/components/ActionButton.tsx", content: BUTTON },
];

describe("component discovery", () => {
  const intel = analyzeSources(FIXTURE);

  it("finds function components", () => {
    const app = findComponent(intel, "App", "src/App.tsx");
    expect(app?.kind).toBe("function");
    expect(app?.exports.named).toBe(true);
  });

  it("finds arrow components", () => {
    const logo = findComponent(intel, "Logo", "src/components/Logo.tsx");
    expect(logo?.kind).toBe("arrow");
  });

  it("detects default + named export", () => {
    const logo = findComponent(intel, "Logo", "src/components/Logo.tsx");
    expect(logo?.exports.named).toBe(true);
    expect(logo?.exports.default).toBe(true);
  });

  it("detects default export of a function declaration", () => {
    const intel2 = analyzeSources([
      {
        relativePath: "src/Page.tsx",
        content: "export default function Page() { return <div />; }",
      },
    ]);
    const page = findComponent(intel2, "Page", "src/Page.tsx");
    expect(page?.exports.default).toBe(true);
  });

  it("detects class components", () => {
    const intel2 = analyzeSources([
      {
        relativePath: "src/Old.tsx",
        content:
          "import React from 'react'; export class Old extends React.Component { render() { return <div/> } }",
      },
    ]);
    expect(findComponent(intel2, "Old", "src/Old.tsx")?.kind).toBe("class");
  });

  it("reports real line/column positions", () => {
    const nav = findComponent(intel, "Navbar", "src/components/Navbar.tsx");
    expect(nav?.line).toBe(3);
    expect(nav?.column).toBeGreaterThan(0);
  });
});

describe("usage resolution", () => {
  const intel = analyzeSources(FIXTURE);

  it("resolves a local import usage to its definition", () => {
    const cardUse = intel.usages.find((u) => u.name === "Card" && u.usedIn.path === "src/App.tsx");
    expect(cardUse?.resolved).toBe(true);
    expect(cardUse?.definedIn?.path).toBe("src/components/Card.tsx");
    expect(cardUse?.definedIn?.line).toBe(4);
  });

  it("resolves default imports to default-exported components", () => {
    const logoUse = intel.usages.find(
      (u) => u.name === "Logo" && u.usedIn.path === "src/components/Navbar.tsx",
    );
    expect(logoUse?.resolved).toBe(true);
    expect(logoUse?.definedIn?.path).toBe("src/components/Logo.tsx");
  });

  it("records repeated usages", () => {
    const uses = intel.usages.filter(
      (u) => u.name === "ActionButton" && u.usedIn.path === "src/components/Card.tsx",
    );
    expect(uses).toHaveLength(2);
    expect(uses.every((u) => u.resolved)).toBe(true);
  });

  it("marks external components unresolved — never invents a link", () => {
    const intel2 = analyzeSources([
      {
        relativePath: "src/App.tsx",
        content: `import { Table } from "some-lib";
export function App() { return <Table />; }`,
      },
    ]);
    const u = intel2.usages.find((x) => x.name === "Table");
    expect(u?.resolved).toBe(false);
    expect(u?.definedIn).toBeNull();
    expect(u?.note).toBe("external or unresolvable import");
  });

  it("resolves index re-exports when unambiguous", () => {
    const intel2 = analyzeSources([
      {
        relativePath: "src/widgets/index.ts",
        content: 'export { Widget } from "./Widget";',
      },
      {
        relativePath: "src/widgets/Widget.tsx",
        content: "export function Widget() { return <div />; }",
      },
      {
        relativePath: "src/App.tsx",
        content: `import { Widget } from "./widgets";
export function App() { return <Widget />; }`,
      },
    ]);
    const u = intel2.usages.find((x) => x.name === "Widget");
    expect(u?.resolved).toBe(true);
    expect(u?.definedIn?.path).toBe("src/widgets/Widget.tsx");
  });

  it("refuses ambiguous extension collisions", () => {
    const intel2 = analyzeSources([
      { relativePath: "src/A.ts", content: "export const A = 1;" },
      { relativePath: "src/A.tsx", content: "export function A() { return <div/> }" },
      {
        relativePath: "src/App.tsx",
        content: `import { A } from "./A"; export function App() { return <A/> }`,
      },
    ]);
    const u = intel2.usages.find((x) => x.name === "A");
    expect(u?.resolved).toBe(false);
  });

  it("builds a used-by list per definition", () => {
    const def = findComponent(intel, "ActionButton", "src/components/ActionButton.tsx");
    expect(def).not.toBeNull();
    const callers = usagesOf(intel, def!);
    expect(callers).toHaveLength(2);
    expect(callers[0]?.usedIn.path).toBe("src/components/Card.tsx");
  });
});

describe("robustness", () => {
  it("survives malformed source without failing the whole analysis", () => {
    const intel = analyzeSources([
      { relativePath: "src/Broken.tsx", content: "export function Broken( { return <" },
      { relativePath: "src/Ok.tsx", content: "export function Ok() { return <div/> }" },
    ]);
    expect(intel.filesFailed).toBe(1); // the broken file is skipped, not fatal
    expect(intel.filesAnalyzed).toBe(1);
    expect(findComponent(intel, "Ok", "src/Ok.tsx")).not.toBeNull();
  });

  it("counts truly unparseable files as failed", () => {
    const intel = analyzeSources([
      { relativePath: "src/No.tsx", content: "export function No() { return <div/> }" },
      { relativePath: "src/Junk.tsx", content: "} } } {{{" },
    ]);
    expect(intel.filesAnalyzed).toBe(1);
  });

  it("does not treat lowercase JSX as components", () => {
    const intel = analyzeSources([
      { relativePath: "src/A.tsx", content: "export function A() { return <div><span/></div> }" },
    ]);
    expect(intel.usages).toHaveLength(0);
  });

  it("handles .js/.jsx sources", () => {
    const intel = analyzeSources([
      {
        relativePath: "src/App.jsx",
        content: "import { B } from './B.jsx'; export function App() { return <B/> }",
      },
      { relativePath: "src/B.jsx", content: "export function B() { return <p/> }" },
    ]);
    const u = intel.usages.find((x) => x.name === "B");
    expect(u?.resolved).toBe(true);
    expect(u?.definedIn?.path).toBe("src/B.jsx");
  });
});
