import { describe, expect, it } from "vitest";
import { isLoopbackUrl, urlPort } from "./url.js";

describe("isLoopbackUrl", () => {
  it("accepts localhost URLs", () => {
    expect(isLoopbackUrl("http://localhost:5173/")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
  });

  it("accepts IPv4 loopback URLs", () => {
    expect(isLoopbackUrl("http://127.0.0.1:5173/")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3:8080")).toBe(true);
  });

  it("accepts IPv6 loopback and wildcard addresses", () => {
    expect(isLoopbackUrl("http://[::1]:5173/")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:5173/")).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(isLoopbackUrl("http://example.com/")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.20:5173/")).toBe(false);
    expect(isLoopbackUrl("https://evil.localhost.example.com/")).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("javascript:alert(1)")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

describe("urlPort", () => {
  it("extracts explicit ports", () => {
    expect(urlPort("http://localhost:5173/")).toBe(5173);
    expect(urlPort("http://127.0.0.1:3000")).toBe(3000);
  });

  it("returns null for invalid input", () => {
    expect(urlPort("nope")).toBeNull();
  });
});
