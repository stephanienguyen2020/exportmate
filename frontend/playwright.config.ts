import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:5175",
    headless: true,
    // The first-visit tour would cover every workspace page; tour.spec.ts clears this.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:5175",
          localStorage: [{ name: "em-tour-done", value: "1" }],
        },
      ],
    },
  },
  webServer: {
    command: "VITE_AUTH_MODE=dev npm run dev -- --port 5175 --strictPort",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
  },
});
