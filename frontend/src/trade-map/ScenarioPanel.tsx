import React, { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Loader2,
} from "lucide-react";
import { date, type Order } from "../data";
import { api, type MapMarket, type MarketComparison } from "../api";
import { errorMessage } from "../auth";
import { type Row, type Scenario, type ScenarioMode } from "./model";
import { PanelHead } from "./panels";

const ROUTE_OPTIONS = [
  { code: "direct", label: "Direct" },
  { code: "SG", label: "Singapore" },
  { code: "MY", label: "Port Klang" },
  { code: "HK", label: "Hong Kong" },
  { code: "AE", label: "Jebel Ali" },
  { code: "LK", label: "Colombo" },
];

export function ScenarioPanel({
  rows,
  markets,
  scenario,
  renderStatus,
  onChange,
  onComparison,
  onClose,
  onOpenOrder,
}: {
  rows: Row[];
  markets: MapMarket[];
  scenario: Scenario;
  renderStatus: (order: Order) => React.ReactNode;
  onChange: (scenario: Scenario) => void;
  onComparison: (
    result: { key: string; comparison: MarketComparison } | null,
  ) => void;
  onClose: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const row = rows.find((r) => r.order.id === scenario.orderId) ?? rows[0];
  const [result, setResult] = useState<{
    key: string;
    comparison?: MarketComparison;
    error?: string;
  } | null>(null);
  const requestKey =
    row && scenario.target
      ? JSON.stringify([row.order.id, scenario.mode, scenario.target])
      : "";
  useEffect(() => {
    onComparison(null);
    if (!requestKey) return;
    const [orderId, mode, target] = JSON.parse(requestKey) as [
      string,
      ScenarioMode,
      string,
    ];
    const controller = new AbortController();
    const call =
      mode === "date"
        ? api.compareShipDate(orderId, target, controller.signal)
        : mode === "route"
          ? api.compareRoute(orderId, target, controller.signal)
          : api.compareMarkets(orderId, target, controller.signal);
    call
      .then((comparison) => {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, comparison });
          onComparison({ key: requestKey, comparison });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, error: errorMessage(e) });
      });
    return () => controller.abort();
  }, [requestKey, onComparison]);
  if (!row) return null;
  const from = row.placement.market;
  const nameOf = (code: string | null) =>
    markets.find((m) => m.code === code)?.name ?? "Unknown market";
  const current = result?.key === requestKey ? result : null;
  const comparison = current?.comparison;
  return (
    <>
      <PanelHead
        eyebrow="WHAT IF"
        title={
          scenario.mode === "date"
            ? "Move the ship date."
            : scenario.mode === "route"
              ? "Change the route."
              : "Compare markets."
        }
        sub={
          scenario.mode === "date"
            ? "See which checklist dates start, stop, or change. This does not estimate an arrival."
            : scenario.mode === "route"
              ? "See what to recheck if the goods stop somewhere else. Cost and sailing time are not in this data."
              : "See which documents carry over, what needs another look, and what the data can't answer yet."
        }
        onBack={onClose}
      />
      <div className="tm-chips" role="group" aria-label="What to compare">
        {(
          [
            ["market", "Market"],
            ["date", "Ship date"],
            ["route", "Route"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            aria-pressed={scenario.mode === mode}
            className={scenario.mode === mode ? "selected" : ""}
            onClick={() => onChange({ ...scenario, mode, target: null })}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="tm-field" htmlFor="tm-order">
        Order
      </label>
      <select
        id="tm-order"
        className="tm-select"
        value={row.order.id}
        onChange={(e) =>
          onChange({
            orderId: e.target.value,
            mode: scenario.mode,
            target: null,
          })
        }
      >
        {rows.map((r) => (
          <option key={r.order.id} value={r.order.id}>
            {r.order.id} · {r.order.product} → {r.order.destination}
          </option>
        ))}
      </select>
      <div className="tm-current">
        <span>
          <small>NOW</small>
          <b>{nameOf(from)}</b>
          <small>
            {row.order.supplier} → {row.order.destination} · ships{" "}
            {date(row.order.shipDate)} · HS {row.order.hsCode}
          </small>
        </span>
        {renderStatus(row.order)}
      </div>
      {scenario.mode === "market" && (
        <>
          <span className="tm-field">Compare with</span>
          <div
            className="tm-chips"
            role="group"
            aria-label="Market to compare with"
          >
            {markets
              .filter((m) => m.code !== from)
              .map((m) => (
                <button
                  key={m.code}
                  aria-pressed={scenario.target === m.code}
                  className={scenario.target === m.code ? "selected" : ""}
                  onClick={() => onChange({ ...scenario, target: m.code })}
                >
                  {m.name}
                </button>
              ))}
          </div>
          {!scenario.target && (
            <p className="tm-muted">Pick a market here or on the map.</p>
          )}
        </>
      )}
      {scenario.mode === "date" && (
        <>
          <label className="tm-field" htmlFor="tm-ship-date">
            Proposed ship date
          </label>
          <input
            id="tm-ship-date"
            className="tm-select"
            type="date"
            value={scenario.target ?? ""}
            onChange={(e) =>
              onChange({ ...scenario, target: e.target.value || null })
            }
          />
          {!scenario.target && (
            <p className="tm-muted">
              Planned date is {date(row.order.shipDate)}. Pick another day.
            </p>
          )}
        </>
      )}
      {scenario.mode === "route" && (
        <>
          <span className="tm-field">Route via</span>
          <div className="tm-chips" role="group" aria-label="Route to compare">
            {ROUTE_OPTIONS.map((stop) => (
              <button
                key={stop.code}
                aria-pressed={scenario.target === stop.code}
                className={scenario.target === stop.code ? "selected" : ""}
                onClick={() => onChange({ ...scenario, target: stop.code })}
              >
                {stop.label}
              </button>
            ))}
          </div>
          {!scenario.target && (
            <p className="tm-muted">
              Pick a direct routing or an intermediate stop.
            </p>
          )}
        </>
      )}
      <div className="notice tm-caveat">
        <CircleHelp size={18} />
        {scenario.mode === "date"
          ? "Moving the ship date does not change the destination or the documents on file."
          : scenario.mode === "route"
            ? "A different stop does not price the freight or promise a transit time."
            : "Changing market still depends on your customer, the contract and whether you can actually sell there. This compares paperwork only."}
      </div>
      {scenario.target && !current && (
        <p className="tm-muted" role="status">
          <Loader2 size={14} /> Comparing…
        </p>
      )}
      {current?.error && (
        <p className="tm-muted" role="alert">
          {current.error}
        </p>
      )}
      {comparison && (
        <>
          <section className="tm-section tm-compare reuse">
            <h3>
              <Check size={16} /> On file for review{" "}
              <span>{comparison.reuse.length}</span>
            </h3>
            {!comparison.reuse.length && (
              <p className="tm-muted">
                No matching supplier evidence is on file.
              </p>
            )}
            <ul>
              {comparison.reuse.map((item) => (
                <li key={item.title}>
                  <b>{item.title}</b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
          </section>
          <section className="tm-section tm-compare review">
            <h3>
              <ArrowLeftRight size={16} /> Re-evaluate{" "}
              <span>{comparison.reevaluate.length}</span>
            </h3>
            <ul>
              {comparison.reevaluate.map((item) => (
                <li key={item.title}>
                  <b>
                    {item.title}
                    {item.tag && <em>{item.tag}</em>}
                  </b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
            {comparison.dropped.length > 0 && (
              <p className="fine-print">
                Not listed in the current {nameOf(comparison.toMarket)}{" "}
                checklist: {comparison.dropped.join(", ")}.
              </p>
            )}
          </section>
          <section className="tm-section tm-compare unknown">
            <h3>
              <CircleHelp size={16} /> Not enough information{" "}
              <span>{comparison.unknown.length}</span>
            </h3>
            <ul>
              {comparison.unknown.map((item) => (
                <li key={item.title}>
                  <b>{item.title}</b>
                  <p>{item.note}</p>
                </li>
              ))}
            </ul>
          </section>
          {!!comparison.assumptions?.length && (
            <ul className="fine-print">
              {comparison.assumptions.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="fine-print">
            Based on the market checklists and the documents on file for{" "}
            {row.order.supplier}. Illustrative, not legal guidance.
          </p>
        </>
      )}
      <button className="text-link" onClick={() => onOpenOrder(row.order.id)}>
        Open {row.order.id} <ArrowUpRight size={14} />
      </button>
    </>
  );
}
