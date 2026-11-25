// Unit, component and property tests (`npm run test:unit`). Playwright's end-to-end specs in
// tests/ run separately (`npm test`).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "ai/**/*.test.{ts,tsx}", "api/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    restoreMocks: true,
    coverage: { provider: "v8", include: ["src/**", "ai/**", "api/**"], reporter: ["text-summary"] },
  },
});
