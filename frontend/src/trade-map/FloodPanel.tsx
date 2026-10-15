import React, { useRef, useState } from "react";
import { ArrowUpRight, Check, CircleHelp, Copy } from "lucide-react";
import { date, type Order } from "../data";
import {
  type FloodEntry,
  type SupplierGroup,
  byShipDate,
  checkInDraft,
  plural,
} from "./model";
import { OrderLine, PanelHead } from "./panels";

export function FloodPanel({
  entry,
  checkRadiusKm,
  signature,
  renderStatus,
  onBack,
  onOpenOrder,
  onSupplier,
}: {
  entry: FloodEntry;
  checkRadiusKm: number;
  signature: string;
  renderStatus: (order: Order) => React.ReactNode;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  onSupplier: (name: string) => void;
}) {
  const { flood, suppliers, sites } = entry;
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const openDraft = (group: SupplierGroup, km: number) => {
    setDraftFor(group.key);
    setDraft(checkInDraft(flood, group, km, signature));
    setCopied(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      draftRef.current?.select();
    }
  };
  const affected = suppliers.flatMap((s) => s.group.rows).sort(byShipDate);
  return (
    <>
      <PanelHead
        eyebrow={`SATELLITE EVIDENCE${flood.isSample ? " · SAMPLE OBSERVATION" : ""}`}
        title={flood.title + "."}
        sub={flood.place}
        onBack={onBack}
      />
      <dl className="tm-facts">
        <dt>Observed</dt>
        <dd>
          {date(flood.observedOn)} {flood.observedOn.slice(0, 4)}
        </dd>
        <dt>Source</dt>
        <dd>
          {flood.sourceUrl ? (
            <a href={flood.sourceUrl} target="_blank" rel="noreferrer">
              {flood.sensor}
            </a>
          ) : (
            flood.sensor
          )}
        </dd>
        <dt>Water extent</dt>
        <dd>≈ {flood.areaKm2} km²</dd>
        <dt>Confidence</dt>
        <dd
          className={
            "tm-confidence " + (flood.confidence === "low" ? "warn" : "")
          }
        >
          {flood.confidence}
        </dd>
      </dl>
      <p className="tm-muted">{flood.confidenceNote}</p>
      <section className="tm-section">
        <h3>Who to check in with</h3>
        {!suppliers.length && !sites.length && (
          <p className="tm-muted">
            No suppliers or sites within {checkRadiusKm} km of the observed
            edge.
          </p>
        )}
        <ul className="tm-list">
          {suppliers.map(({ group, km }) => (
            <li key={group.key} className="tm-contact">
              <button onClick={() => onSupplier(group.name)}>
                <i className="tm-key supplier" />
                <span>
                  <b>{group.name}</b>
                  <small>
                    {km === 0
                      ? "Inside the observed extent"
                      : `${km} km from the observed edge`}{" "}
                    ·{" "}
                    {group.rows.length
                      ? plural(group.rows.length, "open order")
                      : "no open orders"}
                  </small>
                </span>
                <ArrowUpRight size={14} />
              </button>
              <button
                className="btn secondary"
                aria-expanded={draftFor === group.key}
                onClick={() =>
                  draftFor === group.key
                    ? setDraftFor(null)
                    : openDraft(group, km)
                }
              >
                {draftFor === group.key ? "Hide draft" : "Draft a check-in"}
              </button>
              {draftFor === group.key && (
                <div className="tm-draft">
                  <label htmlFor={`draft-${group.key}`} className="sr-only">
                    Check-in message to {group.name}
                  </label>
                  <textarea
                    id={`draft-${group.key}`}
                    ref={draftRef}
                    className="message-editor"
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setCopied(false);
                    }}
                  />
                  <div className="tm-draft-foot">
                    <button className="btn" onClick={() => void copy()}>
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      {copied ? "Copied" : "Copy message"}
                    </button>
                    <span>Nothing is sent from ExportMate.</span>
                  </div>
                </div>
              )}
            </li>
          ))}
          {sites.map(({ site, km }) => (
            <li key={site.key} className="tm-plain-row">
              <i className="tm-key site" />
              <span>
                <b>{site.name}</b>
                <small>
                  Your site · {km} km from the observed edge. Check stock and
                  road access.
                </small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {affected.length > 0 && (
        <section className="tm-section">
          <h3>Orders that may be affected</h3>
          <ul className="tm-orders">
            {affected.map((row) => (
              <OrderLine
                key={row.order.id}
                row={row}
                renderStatus={renderStatus}
                onOpen={onOpenOrder}
                note={
                  <span className="status amber">
                    <i />
                    Unconfirmed
                  </span>
                }
              />
            ))}
          </ul>
        </section>
      )}
      <div className="notice tm-caveat">
        <CircleHelp size={18} />
        Satellite shows water on the ground, not damage. It can't tell whether a
        supplier's site, stock or schedule is affected. Confirm with the
        supplier before changing any plan. Order statuses are unchanged.
      </div>
    </>
  );
}
