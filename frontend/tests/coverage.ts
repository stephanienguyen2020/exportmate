// The specs' `test`: Playwright's own, plus V8 coverage of each page when COVERAGE=1
// (see coverage-report.ts). Without COVERAGE it adds nothing.
import { test as base, expect } from "@playwright/test";
import MCR from "monocart-coverage-reports";
import { coverageOptions } from "./coverage-report";

const enabled = process.env.COVERAGE === "1";

export const test = base.extend<{ jsCoverage: void }>({
  jsCoverage: [
    async ({ page }, use) => {
      if (!enabled) return use();
      // Kept across page.goto calls: one test's visits all count.
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
      const coverage = await page.coverage.stopJSCoverage();
      // A test that skips itself before opening a page has nothing to add.
      if (Array.isArray(coverage) && coverage.length) await MCR(coverageOptions).add(coverage);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from "@playwright/test";
