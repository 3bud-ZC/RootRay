import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

const PATHS = [
  "src/App.tsx",
  "src/components/Navbar.tsx",
  "src/components/Logo.tsx",
  "src/components/Card.tsx",
  "src/components/ActionButton.tsx",
  "src/styles/app.css",
  "src/styles/button.css",
  "package.json",
];

describe("fuzzyScore", () => {
  it("matches subsequences", () => {
    expect(fuzzyScore("nav", "src/components/Navbar.tsx")).not.toBeNull();
    expect(fuzzyScore("abtsx", "src/components/ActionButton.tsx")).not.toBeNull();
  });

  it("rejects non-subsequences", () => {
    expect(fuzzyScore("zzz", "src/App.tsx")).toBeNull();
    expect(fuzzyScore("xyzq", "src/App.tsx")).toBeNull();
  });

  it("ranks exact basename hits first", () => {
    const results = fuzzyFilter("button", PATHS);
    expect(results[0]).toBe("src/styles/button.css"); // exact basename
    expect(results).toContain("src/components/ActionButton.tsx");
    expect(fuzzyFilter("actionb", PATHS)[0]).toBe("src/components/ActionButton.tsx");
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("APP", "src/styles/app.css")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  it("returns all paths (capped) for an empty query", () => {
    expect(fuzzyFilter("", PATHS)).toEqual(PATHS);
  });

  it("enforces the result cap", () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    expect(fuzzyFilter("f", many, 50)).toHaveLength(50);
  });

  it("finds files by partial path", () => {
    const results = fuzzyFilter("comp/nav", PATHS);
    expect(results[0]).toBe("src/components/Navbar.tsx");
  });
});
