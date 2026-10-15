// Rule watch for a signed-in company: checklist lines that take effect or change soon in its
// markets (GET /api/v1/trade-map/changes), then the requirements that apply to its orders,
// grouped from the market checklists in GET /api/v1/trade-map, with the official text behind each.
import { useEffect, useState } from "react";
import { ArrowUpRight, CalendarClock, FileText, Loader2 } from "lucide-react";
import {
  api,
  type ChecklistChanges,
  type CheckStatus,
  type RequirementCheck,
  type TradeMap,
} from "./api";
import { errorMessage } from "./auth";

const GAPS = new Set<CheckStatus>(["missing", "mismatch"]);
const WINDOW_DAYS = 90;
const LABELS: Record<CheckStatus, string> = {
  on_file: "on file",
  missing: "missing",
  mismatch: "wrong standard",
  prepare: "to prepare",
  check: "to check",
  unknown: "unknown",
};

type Requirement = {
  key: string;
  title: string;
  market: string;
  source?: RequirementCheck["source"];
  orders: { id: string; status: CheckStatus }[];
};

/** One entry per requirement and market, with every order it applies to. */
export function groupRequirements(map: TradeMap): Requirement[] {
  const names = new Map(map.markets.map((m) => [m.code, m.name]));
  const byKey = new Map<string, Requirement>();
  for (const { order, placement, checks } of map.orders)
    for (const check of checks) {
      const market = placement.market || "";
      const key = `${market}:${check.requirementKey}`;
      if (!byKey.has(key))
        byKey.set(key, {
          key,
          title: check.title,
          market: names.get(market) || market || "No market",
          source: check.source,
          orders: [],
        });
      byKey.get(key)!.orders.push({ id: order.id, status: check.status });
    }
  const gaps = (r: Requirement) =>
    r.orders.filter((o) => GAPS.has(o.status)).length;
  return [...byKey.values()].sort(
    (a, b) => gaps(b) - gaps(a) || a.title.localeCompare(b.title),
  );
}

const formatDay = (day: string) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** Checklist lines that take effect or change in the next WINDOW_DAYS days. */
function ComingUp({ onOrder }: { onOrder: (id: string) => void }) {
  const [data, setData] = useState<ChecklistChanges | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api
      .checklistChanges(WINDOW_DAYS, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, []);
  return (
    <>
      <div className="section-heading">
        <h2>Coming up.</h2>
        <span className="eyebrow">NEXT {WINDOW_DAYS} DAYS</span>
      </div>
      {error ? (
        <section className="panel" role="alert">
          <p>Couldn’t load upcoming changes: {error}</p>
        </section>
      ) : !data ? (
        <section className="panel" role="status">
          <Loader2 size={20} /> Checking for upcoming changes…
        </section>
      ) : !data.changes.length ? (
        <section className="panel">
          <p>
            No checklist line in the markets you ship to takes effect or changes
            before {formatDay(data.until)}.
          </p>
        </section>
      ) : (
        data.changes.map((c) => (
          <section
            className="panel"
            key={`${c.market}:${c.requirementKey}:${c.kind}`}
          >
            <div className="rule-change-title">
              <h3>{c.title}</h3>
              <span className={`status ${c.orderIds.length ? "amber" : "green"}`}>
                <i />
                {c.orderIds.length
                  ? `${c.orderIds.length} open ${c.orderIds.length === 1 ? "order" : "orders"} affected`
                  : "No open order ships after it"}
              </span>
            </div>
            <p>
              <CalendarClock size={15} />{" "}
              {c.kind === "effective" ? "Takes effect" : "Changes"} on{" "}
              {formatDay(c.on)} · {c.marketName}
            </p>
            <p>{c.whatChanges}</p>
            <div className="action-footer">
              <a
                className="text-link"
                href={`#/workspace/regulations/documents/${encodeURIComponent(c.source.documentId)}`}
              >
                {c.source.regulationTitle}, version {c.source.versionNumber}
                <ArrowUpRight size={15} />
              </a>
              {c.orderIds.length > 0 && (
                <span className="rule-change-orders">
                  {c.orderIds.map((id) => (
                    <button
                      className="text-link"
                      key={id}
                      onClick={() => onOrder(id)}
                    >
                      {id}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </section>
        ))
      )}
    </>
  );
}

export default function CompanyRuleWatch({
  onOrder,
}: {
  onOrder: (id: string) => void;
}) {
  const [map, setMap] = useState<TradeMap | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api
      .tradeMap(controller.signal)
      .then(setMap)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <section className="panel" role="alert">
        <p>{error}</p>
      </section>
    );
  if (!map)
    return (
      <section className="panel" role="status">
        <Loader2 size={20} /> Loading your requirements…
      </section>
    );
  const requirements = groupRequirements(map);
  const sources = [
    ...new Map(
      requirements
        .filter((r) => r.source)
        .map((r) => [r.source!.documentId, r.source!]),
    ).values(),
  ];
  if (!requirements.length)
    return (
      <>
      <ComingUp onOrder={onOrder} />
      <section className="panel">
        <h2>No requirements yet.</h2>
        <p>
          Requirements appear here once your orders ship to a market ExportMate
          has checklists for. Import orders in the Data room.
        </p>
      </section>
      </>
    );
  return (
    <>
      <ComingUp onOrder={onOrder} />
      <div className="section-heading">
        <h2>The texts behind your checklists.</h2>
        <span className="eyebrow">{sources.length} OFFICIAL TEXTS</span>
      </div>
      <div className="source-grid">
        {sources.map((s) => (
          <a
            className="source-card"
            key={s.documentId}
            href={`#/workspace/regulations/documents/${encodeURIComponent(s.documentId)}`}
          >
            <span className="status green">
              <i />
              Version {s.versionNumber}
            </span>
            <h3>{s.regulationTitle}</h3>
            <p>{s.officialId || s.documentTitle}</p>
            <div className="source-foot">
              <span>Open the text</span>
              <FileText size={17} />
            </div>
          </a>
        ))}
      </div>
      <div className="section-heading">
        <h2>What applies to your orders.</h2>
        <span className="eyebrow">{requirements.length} REQUIREMENTS</span>
      </div>
      {requirements.map((r) => {
        const gaps = r.orders.filter((o) => GAPS.has(o.status));
        const counts = Object.entries(
          r.orders.reduce<Record<string, number>>((acc, o) => {
            acc[LABELS[o.status]] = (acc[LABELS[o.status]] || 0) + 1;
            return acc;
          }, {}),
        );
        return (
          <section className="panel" key={r.key}>
            <div className="rule-change-title">
              <h3>{r.title}</h3>
              <span className={`status ${gaps.length ? "red" : "green"}`}>
                <i />
                {gaps.length
                  ? `${gaps.length} of ${r.orders.length} orders have a gap`
                  : `${r.orders.length} orders covered`}
              </span>
            </div>
            <p>
              {r.market} ·{" "}
              {counts.map(([label, n]) => `${n} ${label}`).join(" · ")}
            </p>
            {r.source?.quote && <blockquote>“{r.source.quote}”</blockquote>}
            <div className="action-footer">
              <span>
                {r.source
                  ? `${r.source.regulationTitle}, version ${r.source.versionNumber}`
                  : "No official text linked"}
              </span>
              {gaps[0] && (
                <button className="text-link" onClick={() => onOrder(gaps[0].id)}>
                  Open {gaps[0].id} on the map
                  <ArrowUpRight size={17} />
                </button>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
