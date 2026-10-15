import { test, expect } from "@playwright/test";

const finished = new Date().toISOString();
// A scan whose Gemini calls all failed (as on 15 October 2026, when GEMINI_MODEL named a model
// that rejects thinking levels): the feeds were read but no article was assessed.
const failedScan = {
  id: "scan-1",
  status: "failed",
  startedAt: finished,
  finishedAt: finished,
  sources: [{ id: "source-1", ok: true }],
  articlesFetched: 32,
  articlesAnalysed: 0,
  articlesFailed: 32,
  impactsFound: 0,
  error: "Gemini couldn't assess 32 of 32 articles: thinking_level is not supported by this model.",
};

async function openNews(page: import("@playwright/test").Page) {
  await page.route("**/api/impacts**", (route) => route.fulfill({ json: { impacts: [], scan: failedScan } }));
  await page.route("**/api/sources**", (route) =>
    route.fulfill({
      json: {
        sources: [{ id: "source-1", name: "Timber news", url: "https://news.example/feed.xml", kind: "News", builtIn: true, enabled: true }],
        scanRules: { maxAgeDays: 365, skipOld: true },
      },
    }),
  );
  await page.goto("/");
  await page.evaluate(() => sessionStorage.setItem("em-session", "demo"));
  await page.goto("/#/workspace/news");
}

test("a scan that couldn't assess any article says so instead of reporting no news", async ({ page }) => {
  await openNews(page);
  const bar = page.locator(".news-scanbar");
  await expect(bar.getByRole("alert")).toHaveText(
    "The last scan failed. Gemini couldn't assess 32 of 32 articles: thinking_level is not supported by this model. The next scan tries these articles again.",
  );
  await expect(bar.getByText("SOURCES READ")).toBeVisible();
});

test("the sample demo shows the age rule switched on, read-only", async ({ page }) => {
  await openNews(page);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page.getByText("Skip articles published more than 365 days before a scan")).toBeVisible();
  const rule = page.getByRole("checkbox", { name: "Skip old articles" });
  await expect(rule).toBeChecked();
  await expect(rule).toBeDisabled();
});
