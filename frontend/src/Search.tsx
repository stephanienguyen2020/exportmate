import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  ClipboardList,
  CornerDownLeft,
  ExternalLink,
  Factory,
  FileText,
  Globe2,
  Loader2,
  MapPin,
  Newspaper,
  Package,
  Search,
  Settings2,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { date, money, type Order, type Rule } from "./data";
import { api, type ReportSummary, type Regulation, type TradeMap } from "./api";
import { companyAuth } from "../ai/chat/agent-client";
import type { Impact } from "../ai/news/NewsWatch";
import "./search.css";

// One search over everything the workspace shows: pages, orders, news alerts, stock, the
// trade map's suppliers, sites and markets, regulations, report drafts and playbook rules.
// Orders and rules come from the workspace; the rest is fetched when the search opens.

type Kind =
  | "page"
  | "order"
  | "news"
  | "stock"
  | "supplier"
  | "site"
  | "market"
  | "regulation"
  | "report"
  | "rule";
type Hit = {
  key: string;
  kind: Kind;
  title: string;
  detail: string;
  haystack: string;
  path?: string; // workspace route
  url?: string; // external article
};
type StockItem = {
  sku: string;
  name: string;
  category: string;
  hsCode: string;
  species: string;
  supplier: string;
  markets: string[];
};
type Fetched = {
  impacts?: Impact[];
  stock?: StockItem[];
  map?: TradeMap;
  regulations?: Regulation[];
  reports?: ReportSummary[];
};

const GROUPS: { kind: Kind; label: string; icon: typeof Search }[] = [
  { kind: "page", label: "Pages", icon: SquareArrowOutUpRight },
  { kind: "order", label: "Orders", icon: Package },
  { kind: "news", label: "News alerts", icon: Newspaper },
  { kind: "stock", label: "Stock", icon: Boxes },
  { kind: "supplier", label: "Suppliers", icon: Factory },
  { kind: "site", label: "Sites", icon: MapPin },
  { kind: "market", label: "Markets", icon: Globe2 },
  { kind: "regulation", label: "Regulations", icon: FileText },
  { kind: "report", label: "Reports", icon: ClipboardList },
  { kind: "rule", label: "Playbook rules", icon: Settings2 },
];
const PER_GROUP = 5;
const AI_API = (import.meta.env.VITE_CHAT_API_URL || "/api/chat").replace(/\/chat$/, "");

async function aiService<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(AI_API + path, { signal, headers: await companyAuth() });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

const hit = (
  kind: Kind,
  key: string,
  title: string,
  detail: string,
  terms: (string | null | undefined)[],
  target: { path?: string; url?: string },
): Hit => ({
  kind,
  key: kind + ":" + key,
  title,
  detail,
  haystack: [title, detail, ...terms].filter(Boolean).join(" ").toLowerCase(),
  ...target,
});

function buildHits(
  pages: [string, string][],
  orders: Order[],
  rules: Rule[],
  data: Fetched,
): Hit[] {
  const hits: Hit[] = pages.map(([path, label]) =>
    hit("page", path || "overview", label, "Go to page", [], { path }),
  );
  for (const o of orders)
    hits.push(
      hit(
        "order",
        o.id,
        `${o.id} · ${o.product}`,
        `${o.supplier} → ${o.destination} · ${money(o.value, o.currency)} · ships ${date(o.shipDate)}`,
        [o.hsCode, o.status?.replace("_", " "), o.risk ? "action needed exposed" : ""],
        { path: "orders/" + encodeURIComponent(o.id) },
      ),
    );
  for (const i of data.impacts ?? [])
    hits.push(
      hit(
        "news",
        i.id,
        i.headline || i.title,
        `${i.publisher || i.sourceName} · ${i.severity} ${i.direction}${
          i.publishedAt ? " · " + date(i.publishedAt.slice(0, 10)) : ""
        }`,
        [i.title, i.why, i.action, i.sourceName, ...i.affected.flatMap((a) => [a.sku, a.name])],
        { url: i.url },
      ),
    );
  for (const s of data.stock ?? [])
    hits.push(
      hit(
        "stock",
        s.sku,
        `${s.sku} · ${s.name}`,
        [s.category, s.species, s.supplier].filter(Boolean).join(" · "),
        [s.hsCode, ...s.markets],
        { path: "news" },
      ),
    );
  for (const s of data.map?.suppliers ?? [])
    hits.push(
      hit(
        "supplier",
        s.id ?? s.name,
        s.name,
        [s.place, s.country, s.supplies].filter(Boolean).join(" · ") || "Supplier",
        [s.contactName, ...s.orderIds, ...(s.documents ?? []).map((d) => d.label)],
        { path: "map/supplier/" + encodeURIComponent(s.name) },
      ),
    );
  for (const s of data.map?.sites ?? [])
    hits.push(
      hit("site", s.id, s.name, `${s.kind} · ${s.place}`, [s.shortName, s.country, s.note], {
        path: "map",
      }),
    );
  for (const m of data.map?.markets ?? [])
    hits.push(
      hit("market", m.code, m.name, `Market · ${m.code}`, [m.shortName, ...m.searchTerms], {
        path: "map/market/" + encodeURIComponent(m.code),
      }),
    );
  for (const r of data.regulations ?? [])
    hits.push(
      hit(
        "regulation",
        r.id,
        r.title,
        [r.officialId, `${r.versionCount} version${r.versionCount === 1 ? "" : "s"}`, r.shared ? "shared" : "yours"]
          .filter(Boolean)
          .join(" · "),
        [r.latestVersion?.filename],
        { path: "regulations/" + encodeURIComponent(r.id) },
      ),
    );
  for (const r of data.reports ?? [])
    hits.push(
      hit(
        "report",
        r.id,
        r.title,
        `${r.kind === "order" ? "Order" : "Company"} report · ${r.sentAt ? "sent" : "draft"} · ${date(r.updatedAt.slice(0, 10))}`,
        [r.scope.orderId],
        { path: "reports/" + encodeURIComponent(r.id) },
      ),
    );
  for (const r of rules)
    hits.push(
      hit("rule", r.id, r.text, `${r.category} · ${r.enabled ? "on" : "off"}`, [], {
        path: "playbook",
      }),
    );
  return hits;
}

// Every word must appear somewhere; a title that starts with or contains the query ranks first.
function rank(hits: Hit[], query: string) {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return hits.filter((h) => h.kind === "page");
  return hits
    .filter((h) => words.every((w) => h.haystack.includes(w)))
    .map((h) => {
      const title = h.title.toLowerCase();
      const score = title.startsWith(q) ? 3 : title.includes(q) ? 2 : words.every((w) => title.includes(w)) ? 1 : 0;
      return { h, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ h }) => h);
}

function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(
    "(" + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")",
    "gi",
  );
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>,
      )}
    </>
  );
}

export default function WorkspaceSearch({
  live,
  pages,
  orders,
  rules,
  onNavigate,
}: {
  live: boolean;
  pages: [string, string][];
  orders: Order[];
  rules: Rule[];
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [data, setData] = useState<Fetched>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  // ⌘K / Ctrl+K anywhere, or "/" outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing && !open)) {
        e.preventDefault();
        opener.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Fresh data each time the search opens; what was loaded before shows meanwhile.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
    const controller = new AbortController();
    const { signal } = controller;
    const missed: string[] = [];
    const load = <T,>(label: string, task: Promise<T>, put: (v: T) => Fetched) =>
      task.then(
        (v) => !signal.aborted && setData((d) => ({ ...d, ...put(v) })),
        () => !signal.aborted && missed.push(label),
      );
    setLoading(true);
    const tasks = [
      load("news", aiService<{ impacts: Impact[] }>("/impacts", signal), (v) => ({ impacts: v.impacts })),
      load("stock", aiService<{ items: StockItem[] }>("/inventory", signal), (v) => ({ stock: v.items })),
    ];
    // Suppliers, sites, markets, regulations and reports exist only for a signed-in company.
    if (live)
      tasks.push(
        load("trade map", api.tradeMap(signal), (map) => ({ map })),
        load("regulations", api.regulations(signal), (regulations) => ({ regulations })),
        load("reports", api.reports(signal), (reports) => ({ reports })),
      );
    void Promise.all(tasks).then(() => {
      if (signal.aborted) return;
      setLoading(false);
      setFailed(missed);
    });
    return () => controller.abort();
  }, [open, live]);

  const hits = useMemo(() => buildHits(pages, orders, rules, data), [pages, orders, rules, data]);
  const groups = useMemo(() => {
    const ranked = rank(hits, query);
    return GROUPS.map((g) => {
      const all = ranked.filter((h) => h.kind === g.kind);
      return { ...g, total: all.length, items: query.trim() ? all.slice(0, PER_GROUP) : all };
    }).filter((g) => g.items.length);
  }, [hits, query]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => {
    setOpen(false);
    setQuery("");
    opener.current?.focus();
  };
  const choose = (h: Hit | undefined) => {
    if (!h) return;
    if (h.url) window.open(h.url, "_blank", "noopener,noreferrer");
    else if (h.path !== undefined) onNavigate(h.path);
    setOpen(false);
    setQuery("");
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // Focus stays in the dialog: the input is its only focusable control besides close.
      e.preventDefault();
    }
  };

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  let index = -1;
  return (
    <>
      <button
        className="search-trigger"
        data-tour="search"
        aria-label="Search the workspace"
        aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
        onClick={(e) => {
          opener.current = e.currentTarget;
          setOpen(true);
        }}
      >
        <Search size={15} />
        <span>Search orders, news, suppliers…</span>
        <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {open && (
        <div className="search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search the workspace" onKeyDown={onKeyDown}>
            <div className="search-field">
              <Search size={18} />
              <input
                ref={input}
                role="combobox"
                aria-expanded="true"
                aria-controls="workspace-search-results"
                aria-activedescendant={flat[active] ? "search-hit-" + active : undefined}
                aria-autocomplete="list"
                placeholder="Search orders, news, stock, suppliers, regulations…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {loading && <Loader2 size={16} className="search-spin" aria-label="Loading" />}
              <button className="icon-btn" aria-label="Close search" onClick={close}>
                <X size={16} />
              </button>
            </div>
            <div className="search-results" id="workspace-search-results" role="listbox" ref={list} aria-label="Results">
              {groups.map((g) => (
                <div role="group" aria-labelledby={"search-group-" + g.kind} key={g.kind}>
                  <div className="search-group" id={"search-group-" + g.kind}>
                    {g.label}
                    {g.total > g.items.length && <span>{g.items.length} of {g.total}</span>}
                  </div>
                  {g.items.map((h) => {
                    index += 1;
                    const i = index;
                    const Icon = g.icon;
                    return (
                      <div
                        key={h.key}
                        id={"search-hit-" + i}
                        data-index={i}
                        role="option"
                        aria-selected={i === active}
                        className="search-hit"
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={() => choose(h)}
                      >
                        <Icon size={16} />
                        <span className="search-hit-text">
                          <strong>
                            <Highlight text={h.title} query={query} />
                          </strong>
                          <small>
                            <Highlight text={h.detail} query={query} />
                          </small>
                        </span>
                        {h.url ? <ExternalLink size={14} aria-label="Opens the article" /> : <CornerDownLeft size={14} aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              ))}
              {query.trim() && !flat.length && !loading && (
                <div className="search-empty">No matches for “{query.trim()}”.</div>
              )}
            </div>
            <div className="search-foot">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
              </span>
              {failed.length > 0 ? (
                <span role="status">Couldn’t load {failed.join(", ")}.</span>
              ) : (
                !live && <span>Sign in to search suppliers, regulations and reports.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
