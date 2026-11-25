import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { fetchHsBenchmark, type BenchmarkRate, type HsBenchmark } from "./api";
import "./accuracy.css";

// Every figure here comes from the latest full benchmark run (backend app/hs_benchmark.py);
// nothing is typed into the page. Before the first run, the section says so.
type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; run: HsBenchmark };

const percent = (value: number | null) =>
  value === null
    ? "—"
    : new Intl.NumberFormat("en", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);

const day = (iso: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso));

function RateRow({
  label,
  detail,
  rate,
  baseline = false,
}: {
  label: string;
  detail: string;
  rate: BenchmarkRate;
  baseline?: boolean;
}) {
  const pct = (v: number | null) => `${((v ?? 0) * 100).toFixed(2)}%`;
  return (
    <li className={baseline ? "accuracy-row baseline" : "accuracy-row"}>
      <div className="accuracy-row-label">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div
        className="accuracy-bar"
        role="img"
        aria-label={`${percent(rate.rate)}, 95% interval ${percent(rate.low)} to ${percent(rate.high)}`}
      >
        <span className="accuracy-fill" style={{ width: pct(rate.rate) }} />
        <span
          className="accuracy-interval"
          style={{
            left: pct(rate.low),
            width: `calc(${pct(rate.high)} - ${pct(rate.low)})`,
          }}
        />
      </div>
      <div className="accuracy-row-value">
        <strong>{percent(rate.rate)}</strong>
        <span>
          {rate.right} of {rate.of}
        </span>
      </div>
    </li>
  );
}

export default function AccuracySection() {
  const [state, setState] = useState<State>({ kind: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    fetchHsBenchmark(abort.signal)
      .then((run) =>
        setState(run ? { kind: "ready", run } : { kind: "missing" }),
      )
      .catch(() => {
        if (!abort.signal.aborted) setState({ kind: "failed" });
      });
    return () => abort.abort();
  }, []);

  const run = state.kind === "ready" ? state.run : null;
  const m = run?.metrics;
  return (
    <section
      className="story-accuracy story-section"
      id="accuracy"
      aria-labelledby="accuracy-title"
      aria-busy={state.kind === "loading"}
    >
      <div className="story-section-top">
        <span>02 / HOW ACCURATE IS IT</span>
        <span>MEASURED, NOT CLAIMED</span>
      </div>
      <div className="accuracy-layout">
        <div className="accuracy-copy">
          <h2 id="accuracy-title">
            {run ? (
              <>
                Tested on {run.caseCount}
                <br />
                <strong>real customs rulings.</strong>
              </>
            ) : (
              <>
                Tested on
                <br />
                <strong>real customs rulings.</strong>
              </>
            )}
          </h2>
          <p>
            Each ruling is a product description and the code customs ruled for
            it. ExportMate suggested codes for every one, the way it does for an
            order without a code, with no company history to lean on. Scored
            once; the rulings are never used to tune it. Gemini may have seen
            some of these rulings in training; we can't measure how many.
          </p>
          {run && m && (
            <div className="accuracy-headline">
              <strong>{percent(m.top3.rate)}</strong>
              <span>
                of the time the ruled code is among its suggestions
                <em>
                  95% interval {percent(m.top3.low)}–{percent(m.top3.high)}
                </em>
              </span>
            </div>
          )}
        </div>
        <div className="accuracy-figures">
          {state.kind === "loading" && (
            <p className="accuracy-status">Loading the latest measured run…</p>
          )}
          {state.kind === "missing" && (
            <p className="accuracy-status">
              <strong>Not measured yet.</strong> The benchmark hasn't finished a
              full run. Its results appear here as soon as one does, not before.
            </p>
          )}
          {state.kind === "failed" && (
            <p className="accuracy-status">
              <strong>Couldn't load the measured results.</strong> Try again in
              a minute.
            </p>
          )}
          {run && m && (
            <>
              <ul className="accuracy-rows">
                <RateRow
                  label="First suggestion right"
                  detail="the exact 6-digit HS code"
                  rate={m.top1}
                />
                <RateRow
                  label="Right code suggested"
                  detail="among its (up to 3) suggestions"
                  rate={m.top3}
                />
                <RateRow
                  label="Right heading"
                  detail="first suggestion, first 4 digits"
                  rate={m.heading}
                />
                <RateRow
                  label="Without AI"
                  detail="the closest tariff line by meaning"
                  rate={m.nearestLine}
                  baseline
                />
              </ul>
              <p className="accuracy-legend">
                Bar: the measured rate. Bracket: its 95% Wilson interval.
                {m.errors > 0 &&
                  ` ${m.errors} ${m.errors === 1 ? "call" : "calls"} failed and count as wrong.`}
              </p>
              <dl className="accuracy-meta">
                <div>
                  <dt>Rulings</dt>
                  <dd>
                    <a
                      href={run.dataset.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {run.dataset.source}
                      <ArrowUpRight size={12} />
                    </a>
                    , {run.caseCount} of{" "}
                    {run.dataset.rulingsListed.toLocaleString("en")}
                  </dd>
                </div>
                <div>
                  <dt>Licence</dt>
                  <dd>
                    <a
                      href={run.dataset.licenceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {run.dataset.licence}
                      <ArrowUpRight size={12} />
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>
                    {run.model} · {run.embeddingModel}, Gemini on Vertex AI
                    (Google Cloud)
                  </dd>
                </div>
                <div>
                  <dt>Measured</dt>
                  <dd>{day(run.createdAt)}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </div>
      <p className="accuracy-note">
        Not a ruling. Confirm a code with customs or a licensed broker before
        you ship.
      </p>
    </section>
  );
}
