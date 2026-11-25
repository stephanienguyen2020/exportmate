// The order statuses GET /api/v1/order-statuses returns, read from the backend's own seed
// (backend/app/seed_data/reference.json), so the tests word statuses as the database does.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { OrderStatusOption } from "../src/api";

const reference = JSON.parse(
  readFileSync(new URL("../../backend/app/seed_data/reference.json", import.meta.url), "utf8"),
);
export const seededStatuses: OrderStatusOption[] = reference.orderStatuses.map(
  (s: OrderStatusOption) => ({ retired: false, ...s }),
);
export const statusLabel = (code: string) =>
  seededStatuses.find((s) => s.code === code)!.label;

/** Serves the public status list, as the backend does for the demo and signed-in pages. */
export const serveOrderStatuses = (page: Page) =>
  page.route("**/api/v1/order-statuses", (route) =>
    route.fulfill({ json: { data: seededStatuses, meta: {} } }),
  );
