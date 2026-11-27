import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, type TradeRisk } from "./api";
import { errorMessage } from "./auth";
import "./trade-risk.css";

// A new market and product is scored by the Order features job in a minute or two.
const POLL_MS = 10_000;
const MAX_POLLS = 12;

const LEVELS = {
  high: "High",
  medium: "Medium",
  low: "Low",
} as const;
const LEVEL_MEANING = {
  high: "in the top 1% of trade flows the model ranks",
  medium: "in the top 5% of trade flows the model ranks",
  low: "below the top 5% of trade flows the model ranks",
} as const;
const KINDS: Record<string, string> = {
  AD: "Anti-dumping",
  CVD: "Anti-subsidy",
};
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

// "2025-09" → "Sep 2025"; a year stays as it is.
function period(value: string) {
  const [year, month] = value.split("-");
  return month ? `${MONTHS[Number(month) - 1]} ${year}` : year;
}

function figuresLine(risk: TradeRisk) {
  if (!risk.dataFrom || !risk.dataTo) return null;
  const span =
    risk.dataFrom === risk.dataTo
      ? period(risk.dataTo)
      : `${period(risk.dataFrom)} to ${period(risk.dataTo)}`;
  return risk.dataSource === "baci"
    ? `Import figures: CEPII BACI, ${span} (yearly figures, a year or more old).`
    : `Import figures: UN Comtrade, ${span}.`;
}

// Loads a risk and asks again while it is pending.
function useTradeRisk(key: string, load: (signal: AbortSignal) => Promise<TradeRisk>) {
  const [state, setState] = useState<{
    key: string;
    risk?: TradeRisk;
    error?: string;
    gaveUp?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let polls = 0;
    const fetchRisk = () =>
      load(controller.signal)
        .then((risk) => {
          if (controller.signal.aborted) return;
          const waiting = risk.status === "pending" && polls < MAX_POLLS;
          setState({
            key,
            risk,
            gaveUp: risk.status === "pending" && !waiting,
          });
          if (waiting) {
            polls += 1;
            timer = window.setTimeout(fetchRisk, POLL_MS);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setState({ key, error: errorMessage(e) });
        });
    void fetchRisk();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // `load` is rebuilt each render; `key` names what it loads.
  }, [key]);
  return state?.key === key ? state : null;
}

function LevelBadge({ risk }: { risk: TradeRisk }) {
  if (!risk.level) return null;
  return (
    <span className={`risk-level ${risk.level}`}>{LEVELS[risk.level]}</span>
  );
}

function PendingLine({ gaveUp }: { gaveUp?: boolean }) {
  return gaveUp ? (
    <p className="tm-muted">
      Still being scored. Come back to this page in a few minutes.
    </p>
  ) : (
    <p className="tm-muted" role="status">
      <Loader2 size={14} /> Scoring this market and product for the first
      time. It takes a minute or two.
    </p>
  );
}

// The order page's panel: level, reasons, the figures behind it and the closest past cases.
export default function OrderTradeRisk({ orderId }: { orderId: string }) {
  const state = useTradeRisk(orderId, (signal) =>
    api.orderTradeRisk(orderId, signal),
  );
  const risk = state?.risk;
  return (
    <section className="panel trade-risk" aria-label="Trade defence risk">
      <h2>Trade defence risk</h2>
      <p>
        How likely {risk?.market ?? "the destination market"} is to open an
        anti-dumping or anti-subsidy case on this product from{" "}
        {risk?.exporter ?? "your country"} in the next 12 months, ranked against
        every trade flow the model scores.
      </p>
      {!state && (
        <p className="tm-muted" role="status">
          <Loader2 size={14} /> Loading the risk…
        </p>
      )}
      {state?.error && <p role="alert">{state.error}</p>}
      {risk?.status === "pending" && <PendingLine gaveUp={state?.gaveUp} />}
      {risk?.status === "no_data" && <p>{risk.note}</p>}
      {risk?.status === "scored" && (
        <>
          <p className="risk-headline">
            <LevelBadge risk={risk} />
            {risk.level && risk.percentile != null && (
              <span>{LEVEL_MEANING[risk.level]}.</span>
            )}
          </p>
          {risk.note && <p>{risk.note}</p>}
          {risk.reasons.length > 0 && (
            <>
              <h3>Why</h3>
              <ul className="risk-reasons">
                {risk.reasons.map((reason) => (
                  <li key={reason.feature}>{reason.text}</li>
                ))}
              </ul>
            </>
          )}
          {risk.similarCases.length > 0 && (
            <>
              <h3>Closest past cases</h3>
              <ul className="risk-cases">
                {risk.similarCases.slice(0, 3).map((c) => (
                  <li key={c.caseId + c.market + c.exporter + c.hs6}>
                    <b>
                      {KINDS[c.kind] ?? c.kind} case by {c.market} on{" "}
                      {c.product || `HS ${c.hs6}`} from {c.exporter}, {c.year}
                    </b>
                    <span>
                      {c.outcome}
                      {c.dutyPct != null && ` (${c.dutyPct}%)`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {figuresLine(risk) && <p className="fine-print">{figuresLine(risk)}</p>}
        </>
      )}
      {risk && (
        <p className="fine-print">
          A ranking from past cases and trade figures, not a forecast of any one
          case, and not legal advice. {risk.sources.join(" ")}
        </p>
      )}
    </section>
  );
}

// One line for the trade map's what-if: the level for a market, or why there is none.
export function TradeRiskLine({
  label,
  orderId,
  destination,
  hsCode,
}: {
  label: string;
  orderId?: string;
  destination?: string;
  hsCode: string;
}) {
  const key = JSON.stringify([orderId ?? null, destination ?? null, hsCode]);
  const state = useTradeRisk(key, (signal) =>
    orderId
      ? api.orderTradeRisk(orderId, signal)
      : api.tradeRisk(destination ?? "", hsCode, signal),
  );
  const risk = state?.risk;
  return (
    <li className="trade-risk-line">
      <b>{label}</b>
      {!state && (
        <p className="tm-muted" role="status">
          <Loader2 size={14} /> Loading…
        </p>
      )}
      {state?.error && <p className="tm-muted">{state.error}</p>}
      {risk?.status === "pending" && <PendingLine gaveUp={state?.gaveUp} />}
      {risk?.status === "no_data" && <p className="tm-muted">{risk.note}</p>}
      {risk?.status === "scored" && (
        <p>
          <LevelBadge risk={risk} />{" "}
          {risk.reasons[0]?.text ?? risk.note ?? ""}
        </p>
      )}
    </li>
  );
}
