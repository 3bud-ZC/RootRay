import { describe, expect, it } from "vitest";
import { languageIdFor } from "./language";

describe("languageIdFor", () => {
  it("maps supported source extensions", () => {
    expect(languageIdFor("src/App.tsx")).toBe("tsx");
    expect(languageIdFor("src/App.jsx")).toBe("jsx");
    expect(languageIdFor("src/main.ts")).toBe("typescript");
    expect(languageIdFor("src/util.js")).toBe("javascript");
    expect(languageIdFor("src/app.mjs")).toBe("javascript");
    expect(languageIdFor("src/app.css")).toBe("css");
    expect(languageIdFor("src/app.scss")).toBe("scss");
    expect(languageIdFor("index.html")).toBe("html");
    expect(languageIdFor("package.json")).toBe("json");
  });

  it("falls back to text for safe unknowns", () => {
    expect(languageIdFor("README.txt")).toBe("text");
    expect(languageIdFor("notes.md")).toBe("markdown");
    expect(languageIdFor("Makefile.am")).toBe("text");
    expect(languageIdFor("Dockerfile")).toBe("text");
  });
});
