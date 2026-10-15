import { ArrowUpRight, Globe2, Play, ShieldCheck } from "lucide-react";
import { sampleObligation, sampleSources } from "../data";
import { routeStops } from "../account-store";
import CompanyRuleWatch from "../RuleWatch";
import type { Workspace } from "./store";
import { Button, PageHeading, go, plural } from "./ui";

export default function RuleWatchPage({
  ws,
  startDemo,
  showOrders,
}: {
  ws: Workspace;
  startDemo: () => void;
  showOrders: (filter: string) => void;
}) {
  const { live, exposed } = ws;
  return (
    <>
      <PageHeading
        label="THE WORLD CHANGES. STAY AHEAD."
        title="Rule watch."
        description={
          live
            ? "What changes soon in the markets you ship to, and what applies to your orders now."
            : "Changes affecting your products and markets."
        }
        action={
          live ? undefined : (
            <Button onClick={startDemo}>
              <Play size={16} />
              Run rule-change demo
            </Button>
          )
        }
      />
      <div className="notice">
        <ShieldCheck size={18} />
        {live
          ? "Built from your orders' market checklists and the dates in each line's official text. ExportMate doesn't read new rule texts by itself yet: add a new version under Regulations and its dates show up here."
          : "Sample rule-change scenario: one illustrative rule, checked against every order in this demo, including ones you import."}
      </div>
      {live ? (
        <CompanyRuleWatch
          onOrder={(id) => go("map/order/" + encodeURIComponent(id))}
        />
      ) : (
        <>
          <div className="source-grid">
            {sampleSources.map(({ code, name, scope, source }) => (
              <section className="source-card" key={code}>
                <span className="country-code">{code}</span>
                <span className="status green">
                  <i />
                  Sample source
                </span>
                <h3>{name}</h3>
                <p>{scope}</p>
                <div className="source-foot">
                  <span>{source}</span>
                  <Globe2 size={17} />
                </div>
              </section>
            ))}
          </div>
          <div className="section-heading">
            <h2>One change. The full picture.</h2>
            <span className="eyebrow">ILLUSTRATIVE OBLIGATION</span>
          </div>
          <section className="panel">
            <div className="rule-change-title">
              <h3>{sampleObligation.title}</h3>
              <span className={`status ${exposed.length ? "red" : "green"}`}>
                <i />
                {plural(exposed.length, "order")} affected
              </span>
            </div>
            <div className="diff-grid">
              <div>
                <span className="eyebrow">PREVIOUS SAMPLE</span>
                <p>{sampleObligation.before}</p>
              </div>
              <div>
                <span className="eyebrow">NEW SAMPLE REQUIREMENT</span>
                <p>
                  Provide <mark>{sampleObligation.requirement}</mark> for the
                  wood in each affected lot.
                </p>
              </div>
            </div>
            <div className="action-footer">
              <span>
                HS {sampleObligation.hsPrefixes.join(", ")} or{" "}
                {sampleObligation.materials.join(", ")} ·{" "}
                {routeStops(ws.profile).join(" → ")}
              </span>
              <button
                className="text-link"
                onClick={() => showOrders(ws.actionFilter)}
              >
                See affected orders
                <ArrowUpRight size={17} />
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}
