import { describe, expect, it } from "vitest";
import {
  elementSelectedMessage,
  helloMessage,
  inspectSetMessage,
  parseBridgeMessage,
  parseRuntimeMessage,
  parseSourceLocation,
  ROOTRAY_PROTOCOL_VERSION,
  serializeMessage,
} from "./index.js";

const hello = JSON.stringify(helloMessage("sess-1", "tok-abc", "http://localhost:5173/"));

const selection = JSON.stringify(
  elementSelectedMessage(
    "sess-1",
    { tagName: "button", className: "login", textPreview: "Login" },
    {
      relativePath: "src/components/LoginButton.tsx",
      line: 3,
      column: 5,
      componentName: "LoginButton",
    },
  ),
);

describe("runtime message parsing", () => {
  it("parses a valid hello", () => {
    const r = parseRuntimeMessage(hello);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.type).toBe("runtime:hello");
      if (r.message.type === "runtime:hello") {
        expect(r.message.token).toBe("tok-abc");
      }
    }
  });

  it("parses a valid selection", () => {
    const r = parseRuntimeMessage(selection);
    expect(r.ok).toBe(true);
    if (r.ok && r.message.type === "element:selected") {
      expect(r.message.source.relativePath).toBe("src/components/LoginButton.tsx");
      expect(r.message.source.line).toBe(3);
      expect(r.message.element.tagName).toBe("button");
    }
  });

  it("rejects non-JSON", () => {
    expect(parseRuntimeMessage("not json").ok).toBe(false);
  });

  it("rejects non-object", () => {
    expect(parseRuntimeMessage("[1,2]").ok).toBe(false);
    expect(parseRuntimeMessage('"hi"').ok).toBe(false);
  });

  it("rejects unknown protocol versions", () => {
    const msg = JSON.parse(hello);
    msg.version = 99;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
    msg.version = "1";
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
  });

  it("rejects unknown message types", () => {
    const msg = { version: ROOTRAY_PROTOCOL_VERSION, type: "shell:exec", command: "rm -rf /" };
    const r = parseRuntimeMessage(JSON.stringify(msg));
    expect(r.ok).toBe(false);
  });

  it("rejects hello without a token", () => {
    const msg = JSON.parse(hello);
    delete msg.token;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
  });

  it("rejects a selection without source", () => {
    const msg = JSON.parse(selection);
    delete msg.source;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
  });

  it("rejects invalid line/column", () => {
    const msg = JSON.parse(selection);
    msg.source.line = 0;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
    msg.source.line = 3;
    msg.source.column = -1;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
    msg.source.column = 2.5;
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
  });
});

describe("source location validation", () => {
  it("rejects absolute and escaping paths", () => {
    for (const p of [
      "C:\\Users\\x\\f.tsx",
      "C:/Users/x/f.tsx",
      "/etc/passwd",
      "../outside.tsx",
      "src/../../secret.tsx",
      "src\\win\\style.tsx",
    ]) {
      expect(parseSourceLocation({ relativePath: p, line: 1, column: 1 }), p).toBeNull();
    }
  });

  it("accepts nested project-relative paths", () => {
    expect(
      parseSourceLocation({ relativePath: "src/components/deep/Card.tsx", line: 10, column: 4 }),
    ).toEqual({ relativePath: "src/components/deep/Card.tsx", line: 10, column: 4 });
  });

  it("accepts a v1 payload with no confidence (backward compatible)", () => {
    expect(parseSourceLocation({ relativePath: "src/App.tsx", line: 1, column: 1 })).toEqual({
      relativePath: "src/App.tsx",
      line: 1,
      column: 1,
    });
  });

  it("accepts all confidence values (additive v1 extension)", () => {
    for (const confidence of ["exact", "approximate", "component"] as const) {
      const loc = parseSourceLocation({
        relativePath: "src/App.tsx",
        line: 1,
        column: 1,
        confidence,
      });
      expect(loc?.confidence).toBe(confidence);
    }
  });

  it("rejects an unknown confidence value", () => {
    expect(
      parseSourceLocation({
        relativePath: "src/App.tsx",
        line: 1,
        column: 1,
        confidence: "guessed",
      }),
    ).toBeNull();
    // …and at the message level the selection is rejected, not degraded.
    const msg = JSON.parse(selection);
    msg.source.confidence = "guessed";
    expect(parseRuntimeMessage(JSON.stringify(msg)).ok).toBe(false);
  });

  it("rejects a present-but-invalid confidence (null is not 'absent')", () => {
    expect(
      parseSourceLocation({
        relativePath: "src/App.tsx",
        line: 1,
        column: 1,
        confidence: null,
      }),
    ).toBeNull();
  });
});

describe("bridge message parsing", () => {
  it("parses inspect:set", () => {
    const r = parseBridgeMessage(serializeMessage(inspectSetMessage(true)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual({ version: 1, type: "inspect:set", enabled: true });
  });

  it("rejects malformed inspect:set", () => {
    expect(
      parseBridgeMessage(JSON.stringify({ version: 1, type: "inspect:set", enabled: "yes" })).ok,
    ).toBe(false);
  });

  it("round-trips a session:accepted", () => {
    const r = parseBridgeMessage(
      JSON.stringify({ version: 1, type: "session:accepted", sessionId: "s" }),
    );
    expect(r.ok).toBe(true);
  });
});
