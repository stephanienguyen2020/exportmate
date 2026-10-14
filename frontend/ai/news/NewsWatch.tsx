import React, { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ExternalLink,
  Loader2,
  Newspaper,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { companyAuth } from "../chat/agent-client";
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
  affected: { sku: string; name: string; reason: string; stockValueUsd: number }[];
  stockValueUsd: number;
  createdAt: string;
};
type Scan = {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  articlesFetched?: number;
  articlesAnalysed?: number;
  impactsFound?: number;
  sources?: { id: string; ok: boolean }[];
  error?: string;
};
type Item = {
  sku: string;
  name: string;
  category: string;
  hsCode: string;
  species: string;
  timberOrigin: string;
  supplier: string;
  markets: string[];
  certifications: string[];
  geolocationOnFile: boolean;
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

// Every call carries the company token in a signed-in workspace (none in the demo), so the
// AI service can tell who is asking.
async function api<T>(path: string, init?: Omit<RequestInit, "headers">): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(await companyAuth()) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

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
  const load = () =>
    api<{ impacts: Impact[]; scan: Scan | null }>("/impacts")
      .then((d) => {
        setImpacts(d.impacts.sort(bySeverity));
        setScan(d.scan);
        setError("");
      })
      .catch((e) => setError(e.message));
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

function ImpactCard({ impact, compact }: { impact: Impact; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const reasons = expanded ? impact.affected : impact.affected.slice(0, REASONS_SHOWN);
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
        {impact.affected.slice(0, 4).map((a) => (
          <span key={a.sku} title={`${a.name}: ${a.reason}`}>
            {a.sku}
          </span>
        ))}
        {impact.affected.length > 4 && <span>+{impact.affected.length - 4}</span>}
        <b>{usd(impact.stockValueUsd)} stock exposed</b>
      </div>
      {!compact && (
        <>
          <ul className="news-reasons">
            {reasons.map((a) => (
              <li key={a.sku}>
                <strong>
                  {a.sku} · {a.name}
                </strong>{" "}
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
        </>
      )}
      <a className="text-link news-source" href={impact.url} target="_blank" rel="noopener noreferrer">
        {compact ? "Source" : impact.title} <ExternalLink size={13} />
      </a>
    </article>
  );
}

// Alerts are matched against the synthetic demo inventory, not a signed-in company's own stock.
const SAMPLE_STOCK_NOTE = "Matched against ExportMate's sample inventory, not your company's own stock.";
// The demo's stock list and its orders are separate samples, so their exposure figures differ.
const DEMO_STOCK_NOTE = "Matched against the demo company's stock list (Stock tab), which is separate from its orders.";

/** Overview section: today's top news impacts. */
export function NewsHighlights({ live = false }: { live?: boolean }) {
  const { impacts, scan, error } = useImpacts();
  if (error || !impacts?.length) return null;
  const top = impacts.slice(0, 3);
  return (
    <>
      <div className="section-heading news-section">
        <div>
          <span className="eyebrow">FROM THE NEWS · SCANNED {when(scan?.finishedAt || scan?.startedAt).toUpperCase()}</span>
          <h2>{live ? "What the news means for the sample stock." : "What the news means for your stock."}</h2>
          <p className="news-note">{live ? SAMPLE_STOCK_NOTE : DEMO_STOCK_NOTE}</p>
        </div>
        <a className="text-link" href="#/workspace/news">
          All {impacts.length} alerts <ArrowUpRight size={16} />
        </a>
      </div>
      <div className="news-grid">
        {top.map((i) => (
          <ImpactCard key={i.id} impact={i} compact />
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
      {scan?.status === "done" && (
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
          {scanning ? "Scanning… about a minute" : "Scan now"}
        </button>
        {locked && !message && <small>{locked}</small>}
        {message && <small role="status">{message}</small>}
      </div>
    </section>
  );
}

function StockTable({ impacts }: { impacts: Impact[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ items: Item[] }>("/inventory")
      .then((d) => setItems(d.items))
      .catch((e) => setError(e.message));
  }, []);
  if (error) return <div className="news-error">{error}</div>;
  if (!items) return <Loading />;
  const alerts = new Map<string, number>();
  impacts.forEach((i) => i.affected.forEach((a) => alerts.set(a.sku, (alerts.get(a.sku) || 0) + 1)));
  const total = items.reduce((s, i) => s + i.qtyOnHand * i.unitCostUsd, 0);
  return (
    <>
      <p className="news-note">
        {items.length} items · {usd(total)} on hand · a made-up stock list for the sample wood exporter, kept apart from
        the orders
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>SKU / item</th>
              <th>HS code</th>
              <th>Timber</th>
              <th>Markets</th>
              <th>On hand</th>
              <th>Stock value</th>
              <th>Geolocation</th>
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
                  {i.species}
                  <small>
                    {i.timberOrigin} · {i.supplier}
                  </small>
                </td>
                <td>{i.markets.join(", ")}</td>
                <td className="mono">
                  {i.qtyOnHand.toLocaleString()} {i.unit}
                </td>
                <td className="mono">{usd(i.qtyOnHand * i.unitCostUsd)}</td>
                <td>
                  <span className={`status ${i.geolocationOnFile ? "green" : "amber"}`}>
                    <i />
                    {i.geolocationOnFile ? "On file" : "Missing"}
                  </span>
                </td>
                <td>
                  {alerts.get(i.sku) ? (
                    <span className="status red">
                      <i />
                      {alerts.get(i.sku)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
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
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<{ sources: Source[] }>("/sources")
      .then((d) => setList(d.sources))
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

const Loading = () => (
  <div className="news-empty">
    <Loader2 size={18} className="spin" /> Loading…
  </div>
);

// `sourcesLocked` / `scanLocked` explain why this session can't change sources or start a scan.
export default function NewsWatchPage({
  sourcesLocked,
  scanLocked,
  live = false,
}: {
  sourcesLocked?: string;
  scanLocked?: string;
  live?: boolean;
}) {
  const { impacts, scan, error, load, setScan } = useImpacts();
  const [tab, setTab] = useState("Alerts");
  const [filter, setFilter] = useState("All");
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const scanNow = async () => {
    if (scanLocked) return;
    setScanning(true);
    setMessage("");
    try {
      const d = await api<{ scan: Scan }>("/scan", { method: "POST" });
      setScan(d.scan);
      setMessage(`${d.scan.impactsFound} new alert${d.scan.impactsFound === 1 ? "" : "s"} from ${d.scan.articlesAnalysed} new articles.`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Scan failed.");
    } finally {
      setScanning(false);
    }
  };
  const shown = (impacts || []).filter(
    (i) => filter === "All" || (filter === "Opportunities" ? i.direction === "opportunity" : i.severity === filter.toLowerCase()),
  );
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">NEWS WATCH · GEMINI ON VERTEX AI</span>
          <h1>News that moves your stock.</h1>
          <p>
            Every morning ExportMate reads your approved sources and flags the stock items each story could affect. Alerts are
            AI assessments of headlines; open the source before acting.
          </p>
          <p className="news-note">{live ? SAMPLE_STOCK_NOTE : DEMO_STOCK_NOTE}</p>
        </div>
      </section>
      <ScanBar scan={scan} onScan={scanNow} scanning={scanning} message={message} locked={scanLocked} />
      <div className="tabs news-tabs">
        {["Alerts", "Stock", "Sources"].map((t) => (
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
            <div className="news-filters">
              {["All", "High", "Medium", "Low", "Opportunities"].map((f) => (
                <button key={f} className={filter === f ? "selected" : ""} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
            {shown.length ? (
              <div className="news-list">
                {shown.map((i) => (
                  <ImpactCard key={i.id} impact={i} />
                ))}
              </div>
            ) : (
              <div className="news-empty">
                <Newspaper size={18} /> No alerts here. Run a scan or change the filter.
              </div>
            )}
          </>
        ))}
      {tab === "Stock" && <StockTable impacts={impacts || []} />}
      {tab === "Sources" && <Sources locked={sourcesLocked} />}
    </>
  );
}
