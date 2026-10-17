import React, { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ExternalLink,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { companyAuth } from "../chat/agent-client";
import { matchCounts, OrderMatches } from "./NewsOrders";
import { useNewsMatches, type StockItem } from "./news-matches";
import { SkuChip } from "./SkuChip";
import type { NewsMatch } from "../../src/api";
import { CostWhy } from "../../src/CostWhy";
import type { Order } from "../../src/data";
import "./news.css";

export type Impact = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  sourceName: string;
  publishedAt: string | null;
  severity: "high" | "medium" | "low";
  direction: "risk" | "opportunity" | "watch";
  headline: string;
  why: string;
  action: string;
  // A company's goods have no stock value, so its alerts carry none.
  affected: { sku: string; name: string; reason: string; stockValueUsd?: number }[];
  stockValueUsd?: number;
  createdAt: string;
};
type Scan = {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  articlesFetched?: number;
  articlesAnalysed?: number;
  // Articles Gemini couldn't assess; the next scan retries them.
  articlesFailed?: number;
  impactsFound?: number;
  sources?: { id: string; ok: boolean }[];
  error?: string;
};
// The age rule: a scan skips articles published more than maxAgeDays before it unless the
// company switched it off (skipOld false). Null when the AI service sets no rule.
type ScanRules = { maxAgeDays: number; skipOld: boolean } | null;
type Item = {
  sku: string;
  name: string;
  category: string;
  hsCode: string;
  material: string;
  materialOrigin: string;
  supplier: string;
  markets: string[];
  certifications: string[];
  // Origin traced to where the material was produced, e.g. plot geolocation or farm records.
  originTraced: boolean;
  warehouse: string;
  unit: string;
  qtyOnHand: number;
  unitCostUsd: number;
};
type Source = {
  id: string;
  name: string;
  url: string;
  kind: string;
  builtIn: boolean;
  // Shared by every workspace (built-in, or added before sources had owners). Switching a
  // shared source off only affects the caller's company; only a company's own sources can be removed.
  shared?: boolean;
  enabled: boolean;
  lastFetchedAt?: string;
  lastOk?: boolean;
  lastCount?: number;
  lastError?: string | null;
};

const API = (import.meta.env.VITE_CHAT_API_URL || "/api/chat").replace(/\/chat$/, "");
const SEVERITY = { high: 0, medium: 1, low: 2 };

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Every call carries the company token in a signed-in workspace (none in the demo), so the
// AI service can tell who is asking.
async function api<T>(path: string, init?: Omit<RequestInit, "headers">): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(await companyAuth()) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

// A scan runs inside its POST and can outlast the website's proxy (Vercel gives up on the AI
// service after 120 s with a 502 or 504) while it carries on in the AI service. "Scan now" then
// follows the scan record until it ends, for as long as Cloud Run lets a request run.
const SCAN_POLL_MS = 10_000;
const SCAN_FOLLOW_MS = 10 * 60_000;
const proxyGaveUp = (e: unknown) => e instanceof ApiError && (e.status === 502 || e.status === 504);

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const day = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Undated";
const when = (s?: string) =>
  s
    ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "never";
const bySeverity = (a: Impact, b: Impact) =>
  SEVERITY[a.severity] - SEVERITY[b.severity] || (b.publishedAt || "").localeCompare(a.publishedAt || "");

export function useImpacts() {
  const [impacts, setImpacts] = useState<Impact[] | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState("");
  // Resolves to the latest scan (undefined when the request failed).
  const load = () =>
    api<{ impacts: Impact[]; scan: Scan | null }>("/impacts")
      .then((d) => {
        setImpacts(d.impacts.sort(bySeverity));
        setScan(d.scan);
        setError("");
        return d.scan;
      })
      .catch((e) => {
        setError(e.message);
        return undefined;
      });
  useEffect(() => {
    load();
  }, []);
  return { impacts, scan, error, load, setScan };
}

function SeverityTag({ impact }: { impact: Impact }) {
  const tone = impact.direction === "opportunity" ? "green" : impact.severity === "high" ? "red" : "amber";
  return (
    <span className={`status ${tone}`}>
      <i />
      {impact.severity.toUpperCase()} · {impact.direction.toUpperCase()}
    </span>
  );
}

// Items listed on a full card before "Show all".
const REASONS_SHOWN = 3;
// Stock-item chips shown on a card before the "+N" button.
const SKUS_SHOWN = 4;

// Whose stock it is: a company's own goods, or the sample company's stock in the demo.
type StockOwner = { company: string; about: string };
// What alerts are matched against: a signed-in company's own goods (what About company names
// and its orders ship, with no quantities or values), or the demo's sample stock, which the
// demo matches its orders to in the browser. `watchedSince`: when the scan first read news for
// a company's goods (null: from the next scan).
type StockList = {
  kind: "company" | "sample";
  items: (StockItem & Partial<Item> & Partial<Goods>)[];
  owner?: StockOwner;
  watchedSince?: string | null;
};
type Goods = { supplier: string; orders: string[]; source: "profile" | "orders" };

// Loaded once per session token; a failure is retried.
let stockRequest: { key: string; list: Promise<StockList> } | null = null;
async function loadStockList() {
  const key = JSON.stringify(await companyAuth());
  if (stockRequest?.key !== key) {
    const list = api<StockList>("/inventory").catch((e) => {
      if (stockRequest?.list === list) stockRequest = null;
      throw e;
    });
    stockRequest = { key, list };
  }
  return stockRequest.list;
}
const loadStock = () => loadStockList().then((d) => d.items);

function useStock() {
  const [list, setList] = useState<StockList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadStockList()
      .then(setList)
      .catch(() => setError("Couldn't load the stock list, so no orders can be matched."));
  }, []);
  const stock = list ? new Map(list.items.map((i) => [i.sku, i as StockItem])) : null;
  return { stock, list, error, named: list?.kind === "company" };
}

// What a card's stock-item chips need to link to orders. `rejected`: orders a person marked
// not relevant to the alert; `named`: items are a company's goods, shown by name.
type ChipData = {
  stock: Map<string, StockItem> | null;
  orders: Order[] | null;
  error: string;
  rejected?: Set<string>;
  named?: boolean;
};

function ImpactCard({
  impact,
  compact,
  orders,
  chips,
}: {
  impact: Impact;
  compact?: boolean;
  orders?: React.ReactNode;
  chips?: ChipData;
}) {
  const [expanded, setExpanded] = useState(false);
  const [allSkus, setAllSkus] = useState(false);
  const reasons = expanded ? impact.affected : impact.affected.slice(0, REASONS_SHOWN);
  const skus = allSkus ? impact.affected : impact.affected.slice(0, SKUS_SHOWN);
  const label = (a: { sku: string; name: string }) => (chips?.named ? a.name || a.sku : a.sku);
  return (
    <article className={`news-card ${compact ? "compact" : ""}`}>
      <div className="news-card-top">
        <SeverityTag impact={impact} />
        <span className="mono muted">
          {impact.publisher} · {day(impact.publishedAt)}
        </span>
      </div>
      <h3>{impact.headline}</h3>
      <p>{impact.why}</p>
      <div className="news-skus">
        {skus.map((a) =>
          chips ? (
            <SkuChip
              key={a.sku}
              entry={a}
              item={chips.stock?.get(a.sku)}
              orders={chips.orders}
              rejected={chips.rejected || new Set()}
              named={chips.named}
              error={
                chips.error ||
                (chips.stock && !chips.stock.has(a.sku) ? "This item isn't in the stock list, so no orders can be matched." : "")
              }
            />
          ) : (
            <span key={a.sku} title={`${a.name}: ${a.reason}`}>
              {label(a)}
            </span>
          ),
        )}
        {impact.affected.length > SKUS_SHOWN && (
          <button
            type="button"
            className="news-sku news-sku-more"
            aria-expanded={allSkus}
            aria-label={allSkus ? "Show fewer stock items" : `Show ${impact.affected.length - SKUS_SHOWN} more stock items`}
            onClick={() => setAllSkus(!allSkus)}
          >
            {allSkus ? "Fewer" : `+${impact.affected.length - SKUS_SHOWN}`}
          </button>
        )}
        {typeof impact.stockValueUsd === "number" && <b>{usd(impact.stockValueUsd)} stock exposed</b>}
      </div>
      {!compact && (
        <>
          <ul className="news-reasons">
            {reasons.map((a) => (
              <li key={a.sku}>
                <strong>{chips?.named ? a.name : `${a.sku} · ${a.name}`}</strong>{" "}
                {a.reason}
              </li>
            ))}
          </ul>
          {impact.affected.length > REASONS_SHOWN && (
            <button type="button" className="news-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer items" : `Show all ${impact.affected.length} items`}
            </button>
          )}
          {impact.action && (
            <p className="news-action">
              <strong>Next step:</strong> {impact.action}
            </p>
          )}
          {orders}
        </>
      )}
      <a className="text-link news-source" href={impact.url} target="_blank" rel="noopener noreferrer">
        {compact ? "Source" : impact.title} <ExternalLink size={13} />
      </a>
    </article>
  );
}

// A signed-in company's alerts are about its own goods.
const GOODS_NOTE = "Matched against your goods: what About company says you make and what your orders ship (Your goods tab).";
// The demo's stock list and its orders are separate samples, so their exposure figures differ.
const DEMO_STOCK_NOTE = "Matched against the demo company's stock list (Stock tab), which is separate from its orders.";

/** Overview section: today's top news impacts. */
export function NewsHighlights({ live = false, orders }: { live?: boolean; orders?: Order[] }) {
  const { impacts, scan, error } = useImpacts();
  const stock = useStock();
  if (error || !impacts?.length) return null;
  const top = impacts.slice(0, 3);
  return (
    <>
      <div className="section-heading news-section">
        <div>
          <span className="eyebrow">FROM THE NEWS · SCANNED {when(scan?.finishedAt || scan?.startedAt).toUpperCase()}</span>
          <h2>{live ? "What the news means for your goods." : "What the news means for your stock."}</h2>
          <p className="news-note">{live ? GOODS_NOTE : DEMO_STOCK_NOTE}</p>
        </div>
        <a className="text-link" href="#/workspace/news">
          All {impacts.length} alerts <ArrowUpRight size={16} />
        </a>
      </div>
      <div className="news-grid">
        {top.map((i) => (
          <ImpactCard
            key={i.id}
            impact={i}
            compact
            chips={{ stock: stock.stock, error: stock.error, named: stock.named, orders: orders || null }}
          />
        ))}
      </div>
    </>
  );
}

function ScanBar({
  scan,
  onScan,
  scanning,
  message,
  locked,
}: {
  scan: Scan | null;
  onScan: () => void;
  scanning: boolean;
  message: string;
  locked?: string;
}) {
  const okSources = scan?.sources?.filter((s) => s.ok).length ?? 0;
  return (
    <section className="news-scanbar">
      <div>
        <span className="eyebrow">LAST SCAN</span>
        <strong>{scan ? when(scan.finishedAt || scan.startedAt) : "No scan yet"}</strong>
      </div>
      {scan?.status !== "running" && scan?.sources && (
        <>
          <div>
            <span className="eyebrow">SOURCES READ</span>
            <strong>
              {okSources}/{scan.sources?.length ?? 0}
            </strong>
          </div>
          <div>
            <span className="eyebrow">NEW ARTICLES</span>
            <strong>{scan.articlesAnalysed}</strong>
          </div>
          <div>
            <span className="eyebrow">ALERTS RAISED</span>
            <strong>{scan.impactsFound}</strong>
          </div>
        </>
      )}
      <div className="news-scanbar-action">
        <button className="btn" onClick={onScan} disabled={scanning || Boolean(locked)}>
          {scanning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          {scanning ? "Scanning… a few minutes" : "Scan now"}
        </button>
        {locked && !message && <small>{locked}</small>}
        {message && <small role="status">{message}</small>}
      </div>
      {scan?.error && scan.status !== "running" && (
        <p className="news-scanbar-error" role="alert">
          {scan.status === "failed" ? "The last scan failed. " : ""}
          {scan.error}
          {scan.articlesFailed ? " The next scan tries these articles again." : ""}
        </p>
      )}
    </section>
  );
}

// How many alerts name each item.
function alertCounts(impacts: Impact[]) {
  const alerts = new Map<string, number>();
  impacts.forEach((i) => i.affected.forEach((a) => alerts.set(a.sku, (alerts.get(a.sku) || 0) + 1)));
  return alerts;
}

function AlertCount({ count }: { count?: number }) {
  return count ? (
    <span className="status red">
      <i />
      {count}
    </span>
  ) : (
    <span className="muted">—</span>
  );
}

// A signed-in company's goods: what News watch reads the news for.
function GoodsTable({ list, impacts }: { list: StockList; impacts: Impact[] }) {
  const alerts = alertCounts(impacts);
  const { items } = list;
  return (
    <>
      <p className="news-note">
        {items.length} {items.length === 1 ? "item" : "items"} News watch reads the news for: what About company
        (Account) says you make and what your orders ship.{" "}
        {list.watchedSince
          ? `Watched since ${day(list.watchedSince)}.`
          : "Alerts about them start with the next scan, which also reads back over the last two weeks."}
      </p>
      {items.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>HS code</th>
                <th>Markets</th>
                <th>Suppliers</th>
                <th>Orders</th>
                <th>News alerts</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.sku}>
                  <td>
                    {i.name}
                    {i.source === "profile" && <small>From About company</small>}
                  </td>
                  <td className="mono">{i.hsCode || "—"}</td>
                  <td>{i.markets.join(", ") || "—"}</td>
                  <td>{i.supplier || "—"}</td>
                  <td className="mono">{i.orders?.join(", ") || "—"}</td>
                  <td>
                    <AlertCount count={alerts.get(i.sku)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="news-empty">
          <Newspaper size={18} /> Nothing to watch yet. Say what you make under Account › About company, or import
          orders.
        </div>
      )}
    </>
  );
}

// What a finished "Scan now" reports.
function scanMessage(scan: Scan) {
  if (scan.status === "failed") return "The scan failed.";
  const found = `${scan.impactsFound} new alert${scan.impactsFound === 1 ? "" : "s"} from ${scan.articlesAnalysed} new articles.`;
  return scan.articlesFailed ? `${found} ${scan.articlesFailed} couldn't be assessed.` : found;
}

function StockTable({ impacts }: { impacts: Impact[] }) {
  const [list, setList] = useState<StockList | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    loadStockList()
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="news-error">{error}</div>;
  if (!list) return <Loading />;
  if (list.kind === "company") return <GoodsTable list={list} impacts={impacts} />;
  const items = list.items as Item[];
  const owner = list.owner;
  const alerts = alertCounts(impacts);
  const total = items.reduce((s, i) => s + i.qtyOnHand * i.unitCostUsd, 0);
  return (
    <>
      <p className="news-note">
        {items.length} items ·{" "}
        <CostWhy why="Each item's quantity on hand × its unit cost, added up, from the sample stock list.">
          {usd(total)}
        </CostWhy>{" "}
        on hand · a made-up stock list{owner ? ` for ${owner.company}` : ""}, kept
        apart from the orders
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>SKU / item</th>
              <th>HS code</th>
              <th>Material</th>
              <th>Markets</th>
              <th>On hand</th>
              <th>Stock value</th>
              <th>Origin trace</th>
              <th>News alerts</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.sku}>
                <td>
                  <span className="order-link">{i.sku}</span>
                  <small>{i.name}</small>
                </td>
                <td className="mono">{i.hsCode}</td>
                <td>
                  {i.material}
                  <small>
                    {i.materialOrigin} · {i.supplier}
                  </small>
                </td>
                <td>{i.markets.join(", ")}</td>
                <td className="mono">
                  {i.qtyOnHand.toLocaleString()} {i.unit}
                </td>
                <td className="mono">
                  <CostWhy
                    why={`${i.qtyOnHand.toLocaleString()} ${i.unit} on hand × ${i.unitCostUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })} unit cost, from the sample stock list.`}
                  >
                    {usd(i.qtyOnHand * i.unitCostUsd)}
                  </CostWhy>
                </td>
                <td>
                  <span className={`status ${i.originTraced ? "green" : "amber"}`}>
                    <i />
                    {i.originTraced ? "On file" : "Missing"}
                  </span>
                </td>
                <td>
                  <AlertCount count={alerts.get(i.sku)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Only signed-in owners and editors can change sources (the AI service checks the token).
// `locked` explains why this session can't change them.
function Sources({ locked }: { locked?: string }) {
  const [list, setList] = useState<Source[] | null>(null);
  const [rules, setRules] = useState<ScanRules>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<{ sources: Source[]; scanRules?: ScanRules }>("/sources")
      .then((d) => {
        setList(d.sources);
        setRules(d.scanRules ?? null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const change = (path: string, method: string, body?: unknown) =>
    api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError("");
    try {
      await change("/sources", "POST", { name, url });
      setName("");
      setUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the source.");
    } finally {
      setAdding(false);
    }
  };
  const toggle = async (s: Source) => {
    setList((l) => l && l.map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x)));
    await change(`/sources/${s.id}`, "PATCH", { enabled: !s.enabled }).catch((e) => {
      setError(e.message);
      load();
    });
  };
  const toggleSkipOld = async (r: NonNullable<ScanRules>) => {
    setRules({ ...r, skipOld: !r.skipOld });
    await change("/scan-rules", "PATCH", { skipOld: !r.skipOld }).catch((e) => {
      setError(e.message);
      load();
    });
  };
  const remove = async (s: Source) => {
    await change(`/sources/${s.id}`, "DELETE").catch((e) => setError(e.message));
    load();
  };
  if (!list) return error ? <div className="news-error">{error}</div> : <Loading />;
  return (
    <>
      <p className="news-note">
        Only these approved sources are read. Each daily scan checks enabled feeds for new articles. Switching off a
        built-in source only affects your company; a source you add is only read for your company.
      </p>
      {rules && (
        <ul className="news-sources news-rules">
          <li>
            <label className="news-toggle">
              <input type="checkbox" checked={rules.skipOld} onChange={() => toggleSkipOld(rules)} disabled={Boolean(locked)} />
              <span />
              <span className="sr-only">Skip old articles</span>
            </label>
            <div>
              <strong>Skip articles published more than {rules.maxAgeDays} days before a scan</strong>
              <small>
                On by default. Switch it off and scans also read older articles from your sources; only your company sees the
                alerts they raise. Undated articles are always read.
              </small>
            </div>
          </li>
        </ul>
      )}
      <ul className="news-sources">
        {list.map((s) => (
          <li key={s.id}>
            <label className="news-toggle">
              <input type="checkbox" checked={s.enabled} onChange={() => toggle(s)} disabled={Boolean(locked)} />
              <span />
              <span className="sr-only">Read {s.name}</span>
            </label>
            <div>
              <strong>{s.name}</strong>
              <small>
                {s.kind} · {new URL(s.url).hostname}
                {s.lastFetchedAt &&
                  (s.lastOk
                    ? ` · ${s.lastCount} ${s.lastCount === 1 ? "item" : "items"} at last scan`
                    : ` · last scan failed: ${s.lastError}`)}
              </small>
            </div>
            {!s.builtIn && !s.shared && !locked && (
              <button className="icon-btn" aria-label={`Remove ${s.name}`} onClick={() => remove(s)}>
                <Trash2 size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {locked ? (
        <p className="news-note">{locked}</p>
      ) : (
        <form className="news-add" onSubmit={add}>
          <h3>Add a custom source</h3>
          <p className="news-note">Any public RSS or Atom feed over HTTPS. We test it before saving.</p>
          <div>
            <input placeholder="Name, e.g. Vietnam Customs news" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            <input placeholder="https://example.com/feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} type="url" required />
            <button className="btn" type="submit" disabled={adding}>
              {adding ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              {adding ? "Checking feed…" : "Add source"}
            </button>
          </div>
          {error && <div className="news-error">{error}</div>}
        </form>
      )}
    </>
  );
}

const SEVERITY_FILTERS = ["All", "High", "Medium", "Low", "Opportunities"];
const PERIODS = [
  { value: "", label: "Any time" },
  { value: "7", label: "Past 7 days" },
  { value: "30", label: "Past 30 days" },
];
const ORDER_FILTERS = [
  { value: "", label: "Any orders" },
  { value: "review", label: "Orders to review" },
  { value: "confirmed", label: "Confirmed for an order" },
  { value: "none", label: "No order linked" },
];
type AlertFilters = { severity: string; query: string; source: string; sku: string; period: string; orders: string };
const NO_FILTERS: AlertFilters = { severity: "All", query: "", source: "", sku: "", period: "", orders: "" };

function matches(i: Impact, f: AlertFilters, now: number, orders = matchCounts()) {
  if (f.orders === "review" && !orders.toReview) return false;
  if (f.orders === "confirmed" && !orders.confirmed) return false;
  if (f.orders === "none" && orders.total) return false;
  if (f.severity === "Opportunities" ? i.direction !== "opportunity" : f.severity !== "All" && i.severity !== f.severity.toLowerCase())
    return false;
  if (f.source && i.sourceName !== f.source) return false;
  if (f.sku && !i.affected.some((a) => a.sku === f.sku)) return false;
  // An undated article counts from when the scan raised the alert.
  if (f.period && now - new Date(i.publishedAt || i.createdAt).getTime() > Number(f.period) * 86_400_000) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return [i.headline, i.why, i.title, i.publisher, ...i.affected.flatMap((a) => [a.sku, a.name])].some((s) =>
    s?.toLowerCase().includes(q),
  );
}

function AlertFilterBar({
  impacts,
  filters,
  onChange,
  withOrders,
  named = false,
}: {
  impacts: Impact[];
  filters: AlertFilters;
  onChange: (f: AlertFilters) => void;
  withOrders: boolean;
  // Items are a company's goods, listed by name.
  named?: boolean;
}) {
  const set = (patch: Partial<AlertFilters>) => onChange({ ...filters, ...patch });
  const sources = [...new Set(impacts.map((i) => i.sourceName).filter(Boolean))].sort();
  const items = new Map<string, string>();
  impacts.forEach((i) => i.affected.forEach((a) => items.set(a.sku, a.name)));
  const skus = [...items.keys()].sort();
  return (
    <div className="news-filterbar">
      <div className="news-filters" role="group" aria-label="Severity">
        {SEVERITY_FILTERS.map((f) => (
          <button key={f} className={filters.severity === f ? "selected" : ""} aria-pressed={filters.severity === f} onClick={() => set({ severity: f })}>
            {f}
          </button>
        ))}
      </div>
      <div className="news-filter-fields">
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search alerts"
            placeholder="Search headline, item or SKU…"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
          />
        </label>
        {sources.length > 1 && (
          <select aria-label="Source" value={filters.source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        {skus.length > 1 && (
          <select aria-label={named ? "Goods" : "Stock item"} value={filters.sku} onChange={(e) => set({ sku: e.target.value })}>
            <option value="">{named ? "All goods" : "All stock items"}</option>
            {skus.map((s) => (
              <option key={s} value={s}>
                {named ? items.get(s) || s : `${s} · ${items.get(s)}`}
              </option>
            ))}
          </select>
        )}
        {withOrders && (
          <select aria-label="Orders" value={filters.orders} onChange={(e) => set({ orders: e.target.value })}>
            {ORDER_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <select aria-label="Published" value={filters.period} onChange={(e) => set({ period: e.target.value })}>
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

const Loading = () => (
  <div className="news-empty">
    <Loader2 size={18} className="spin" /> Loading…
  </div>
);

// `sourcesLocked` / `scanLocked` explain why this session can't change sources or start a scan;
// `editable`: this person may confirm or reject which orders an alert affects.
export default function NewsWatchPage({
  sourcesLocked,
  scanLocked,
  live = false,
  editable = false,
}: {
  sourcesLocked?: string;
  scanLocked?: string;
  live?: boolean;
  editable?: boolean;
}) {
  const { impacts, scan, error, load, setScan } = useImpacts();
  const news = useNewsMatches(impacts, loadStock);
  const stock = useStock();
  const byAlert = new Map<string, NewsMatch[]>();
  news.matches?.forEach((m) => byAlert.set(m.impactId, [...(byAlert.get(m.impactId) || []), m]));
  // A company's alerts are about its own goods; the demo's about its sample stock.
  const stockTab = live ? "Your goods" : "Stock";
  const [tab, setTab] = useState("Alerts");
  const [filters, setFilters] = useState(NO_FILTERS);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const scanNow = async () => {
    if (scanLocked) return;
    setScanning(true);
    setMessage("");
    const before = scan?.id;
    try {
      const d = await api<{ scan: Scan }>("/scan", { method: "POST" });
      setScan(d.scan);
      setMessage(scanMessage(d.scan));
      await load();
    } catch (e) {
      const followed = proxyGaveUp(e) ? await followScan(before) : null;
      if (followed) setMessage(followed === "running" ? "The scan is still running; its alerts appear here when it ends." : scanMessage(followed));
      else setMessage(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  };
  // The scan this click started (a record newer than `before`), once it ends; "running" if it
  // outlasts SCAN_FOLLOW_MS; null if no scan started, so the request's own error stands.
  const followScan = async (before?: string): Promise<Scan | "running" | null> => {
    let seen = false;
    for (let waited = 0; waited < SCAN_FOLLOW_MS; waited += SCAN_POLL_MS) {
      const latest = await load();
      if (latest && latest.id !== before) {
        if (latest.status !== "running") return latest;
        seen = true;
      } else if (!seen && waited > 0) return null;
      await new Promise((r) => setTimeout(r, SCAN_POLL_MS));
    }
    return "running";
  };
  const now = Date.now();
  const shown = (impacts || []).filter((i) => matches(i, filters, now, matchCounts(byAlert.get(i.id))));
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">NEWS WATCH · GEMINI ON VERTEX AI</span>
          <h1>{live ? "News that moves your goods." : "News that moves your stock."}</h1>
          <p>
            Every morning ExportMate reads your approved sources and flags the {live ? "goods" : "stock items"} each story could
            affect. Alerts are AI assessments of headlines; open the source before acting.
          </p>
          <p className="news-note">{live ? GOODS_NOTE : DEMO_STOCK_NOTE}</p>
        </div>
      </section>
      <ScanBar scan={scan} onScan={scanNow} scanning={scanning} message={message} locked={scanLocked} />
      <div className="tabs news-tabs">
        {["Alerts", stockTab, "Sources"].map((t) => (
          <button key={t} className={tab === t ? "selected" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "Alerts" && impacts ? ` (${impacts.length})` : ""}
          </button>
        ))}
      </div>
      {tab === "Alerts" &&
        (error ? (
          <div className="news-error">{error}</div>
        ) : !impacts ? (
          <Loading />
        ) : (
          <>
            <AlertFilterBar
              impacts={impacts}
              filters={filters}
              onChange={setFilters}
              withOrders={Boolean(news.matches)}
              named={stock.named}
            />
            {news.error && <div className="news-error">{news.error}</div>}
            {filtered && (
              <p className="news-note news-filter-count" role="status">
                Showing {shown.length} of {impacts.length} alerts.{" "}
                <button type="button" className="news-more" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </button>
              </p>
            )}
            {shown.length ? (
              <div className="news-list">
                {shown.map((i) => (
                  <ImpactCard
                    key={i.id}
                    impact={i}
                    chips={{
                      stock: stock.stock,
                      orders: news.matches ? news.orders : null,
                      error: stock.error || (news.error && "Couldn't load the orders, so none can be matched."),
                      named: stock.named,
                      rejected: new Set(
                        (byAlert.get(i.id) || []).filter((m) => m.review?.verdict === "not_relevant").map((m) => m.orderId),
                      ),
                    }}
                    orders={
                      news.matches && (
                        <OrderMatches
                          matches={byAlert.get(i.id) || []}
                          orders={news.orders}
                          canReview={editable}
                          onReview={(orderId, verdict, note) => news.review(i.id, orderId, verdict, note)}
                          onClear={(orderId) => news.clear(i.id, orderId)}
                        />
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="news-empty">
                <Newspaper size={18} />{" "}
                {stock.named && !stock.list?.items.length
                  ? "Nothing to watch yet. Say what you make under Account › About company, or import orders."
                  : stock.named && !stock.list?.watchedSince
                    ? "Alerts about your goods start with the next scan."
                    : "No alerts here. Run a scan or change the filters."}
              </div>
            )}
          </>
        ))}
      {tab === stockTab && <StockTable impacts={impacts || []} />}
      {tab === "Sources" && <Sources locked={sourcesLocked} />}
    </>
  );
}
