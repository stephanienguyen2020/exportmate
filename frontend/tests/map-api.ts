import type { Route } from "@playwright/test";
import type { TradeMap } from "../src/api";

/**
 * The backend's answers for what the trade map page reads, from one TradeMap fixture:
 * GET /trade-map (markets, observations, the forms' lists), GET /orders?checklist=…
 * (each order with its placement, gap count and checks), GET /suppliers and GET /sites.
 * Undefined for any other request, so a test's own mock answers it.
 */
export function mapApiData(route: Route, map: TradeMap): unknown {
  const url = new URL(route.request().url());
  const path = url.pathname.replace("/api/v1", "");
  if (route.request().method() !== "GET") return undefined;
  if (path === "/trade-map") {
    const { orders: _orders, suppliers: _suppliers, sites: _sites, ...layers } = map;
    return layers;
  }
  if (path === "/orders" && url.searchParams.has("checklist"))
    return map.orders.map(({ order, placement, gapCount, checks }) => ({
      ...order,
      placement,
      gapCount,
      checks,
    }));
  if (path === "/suppliers") return map.suppliers;
  if (path === "/sites") return map.sites;
  return undefined;
}
