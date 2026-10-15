import { useCallback, useEffect, useState } from "react";
import { getProfile, isApiSession } from "../../src/account-store";
import { api as backend, type NewsMatch, type NewsVerdict } from "../../src/api";
import { destinationMarket, initialOrders, readSaved, save, type Order } from "../../src/data";

// Which orders a News watch alert may affect, and people's verdicts. A signed-in company's
// come from the backend (backend/app/services/news_matches.py); the browser demo works them
// out here the same way and keeps its verdicts in this browser.

type AffectedItem = { sku: string; name: string };
export type StockItem = { sku: string; name: string; hsCode: string; markets: string[] };
type Alert = { id: string; headline: string; affected: AffectedItem[] };

const LINKED_REASON = "Linked by a reviewer; ExportMate did not suggest this order.";
const DEMO_REVIEWS = "em-news-reviews";
type DemoReview = { verdict: NewsVerdict; note: string | null; suggested: boolean; reason: string; reviewedAt: string };

/** "4412.33" → "4412"; "" when there are fewer than four digits. */
export function hsHeading(hs: string | undefined) {
  const digits = String(hs || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(0, 4) : "";
}

/** Open orders sharing an HS heading and a market with an item the alert names. */
export function suggestOrders(alert: Alert, stock: Map<string, StockItem>, open: Order[]) {
  const found = new Map<string, { order: Order; market: string | null; reason: string }>();
  for (const entry of alert.affected) {
    const item = stock.get(entry.sku);
    const heading = hsHeading(item?.hsCode);
    if (!item || !heading) continue;
    // "Raw material" and the like aren't export markets: match on the heading alone.
    const markets = item.markets.filter((m) => /^[A-Z]{2}$/.test(m));
    for (const order of open) {
      const market = destinationMarket(order.destination);
      if (found.has(order.id) || hsHeading(order.hsCode) !== heading) continue;
      if (markets.length && !(market && markets.includes(market))) continue;
      const where = markets.length ? ` and ships to ${market}` : "";
      found.set(order.id, {
        order,
        market,
        reason: `HS ${heading}${where}, like ${entry.sku} ${item.name || entry.name} named in this alert.`,
      });
    }
  }
  return [...found.values()];
}

const key = (impactId: string, orderId: string) => `${impactId}/${orderId}`;
const demoOrders = () =>
  readSaved<Order[]>("em-orders", initialOrders, Array.isArray).filter((o) => o && typeof o.id === "string");
const demoReviews = () =>
  readSaved<Record<string, DemoReview>>(DEMO_REVIEWS, {}, (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v));

function demoMatches(alerts: Alert[], stock: StockItem[]): NewsMatch[] {
  const orders = demoOrders();
  const byId = new Map(orders.map((o) => [o.id, o]));
  const today = new Date().toISOString().slice(0, 10);
  const open = orders.filter((o) => o.shipDate >= today);
  const items = new Map(stock.map((i) => [i.sku, i]));
  const reviews = demoReviews();
  const reviewer = { id: "demo", name: getProfile().name || "You" };
  const out = (impactId: string, o: Order, suggested: boolean, reason: string, r?: DemoReview): NewsMatch => ({
    impactId,
    orderId: o.id,
    product: o.product,
    destination: o.destination,
    market: destinationMarket(o.destination),
    shipDate: o.shipDate,
    suggested,
    reason,
    review: r ? { verdict: r.verdict, note: r.note, reviewedBy: reviewer, reviewedAt: r.reviewedAt } : null,
  });
  return alerts.flatMap((alert) => {
    const suggested = suggestOrders(alert, items, open).map((s) =>
      out(alert.id, s.order, true, s.reason, reviews[key(alert.id, s.order.id)]),
    );
    const shown = new Set(suggested.map((m) => m.orderId));
    const kept = Object.entries(reviews).flatMap(([k, r]) => {
      const [impactId, orderId] = [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)];
      const order = byId.get(orderId);
      return impactId === alert.id && order && !shown.has(orderId) ? [out(alert.id, order, r.suggested, r.reason, r)] : [];
    });
    return [...suggested, ...kept];
  });
}

/** The alerts' order matches, the orders a person may link, and the actions on them. */
export function useNewsMatches(alerts: Alert[] | null, loadStock: () => Promise<StockItem[]>) {
  const live = isApiSession();
  const [matches, setMatches] = useState<NewsMatch[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!alerts) return;
    try {
      if (live) {
        const [data, all] = await Promise.all([backend.newsMatches(), backend.orders()]);
        setMatches(data.newsAvailable ? data.matches : []);
        setOrders(all);
      } else {
        setMatches(demoMatches(alerts, await loadStock()));
        setOrders(demoOrders());
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the orders these alerts may affect.");
    }
  }, [alerts, live, loadStock]);
  useEffect(() => {
    load();
  }, [load]);

  const review = async (impactId: string, orderId: string, verdict: NewsVerdict, note: string | null) => {
    if (live) await backend.reviewNewsMatch(impactId, orderId, verdict, note);
    else {
      const reviews = demoReviews();
      const current = (matches || []).find((m) => m.impactId === impactId && m.orderId === orderId);
      const previous = reviews[key(impactId, orderId)];
      reviews[key(impactId, orderId)] = {
        verdict,
        note,
        suggested: previous?.suggested ?? Boolean(current?.suggested),
        reason: previous?.reason ?? current?.reason ?? LINKED_REASON,
        reviewedAt: new Date().toISOString(),
      };
      save(DEMO_REVIEWS, reviews);
    }
    await load();
  };
  const clear = async (impactId: string, orderId: string) => {
    if (live) await backend.clearNewsReview(impactId, orderId);
    else {
      const reviews = demoReviews();
      delete reviews[key(impactId, orderId)];
      save(DEMO_REVIEWS, reviews);
    }
    await load();
  };
  return { matches, orders, error, review, clear };
}
