import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "inspector.spec.ts",
  timeout: 60_000,
  globalTimeout: 600_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    headless: true,
  },
});
