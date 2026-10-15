// Knowledge base: every solution the company saved, grouped by the problem it solves (market,
// requirement, missing or wrong), outside any one order. People read the steps and their team's
// notes, add notes, and adopt or reject; using one for an order stays on the order's report.
import { useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, Search } from "lucide-react";
import { api, type Solution, type SolutionProblem } from "./api";
import { errorMessage } from "./auth";
import { SolutionCard } from "./Solutions";
import "./solutions.css";

type Notify = (text: string, error?: boolean) => void;
type Show = "valid" | "expired" | "all";

const SHOW: [Show, string][] = [
  ["valid", "Valid"],
  ["expired", "Expired"],
  ["all", "All"],
];

const matches = (problem: SolutionProblem, solution: Solution, words: string[]) => {
  const text = [
    problem.title,
    problem.market,
    solution.summary,
    ...solution.steps,
    solution.writtenFor || "",
    solution.basis.regulationTitle,
    ...solution.notes.map((n) => n.text),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
};

function Heading() {
  return (
    <header className="page-heading">
      <div>
        <div className="eyebrow">WHAT YOUR TEAM HAS LEARNED. KEPT.</div>
        <h1>Knowledge base.</h1>
        <p>
          Every solution saved from an order's analysis, with your team's notes
          on how they handle it.
        </p>
      </div>
    </header>
  );
}

export default function KnowledgeBase({
  live,
  editable,
  notify,
}: {
  live: boolean;
  editable: boolean;
  notify: Notify;
}) {
  const [problems, setProblems] = useState<SolutionProblem[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [show, setShow] = useState<Show>("valid");
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    api
      .solutions(controller.signal)
      .then((value) => !controller.signal.aborted && setProblems(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [live]);
  // A note changes one solution; a review can reorder its problem, so reload.
  const replaceSolution = (next: Solution) =>
    setProblems((all) =>
      (all || []).map((p) => ({
        ...p,
        solutions: p.solutions.map((s) => (s.id === next.id ? next : s)),
      })),
    );
  const reload = async () => setProblems(await api.solutions());
  const markets = useMemo(
    () => [...new Set((problems || []).map((p) => p.market))].sort(),
    [problems],
  );
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (problems || [])
      .filter((p) => market === "all" || p.market === market)
      .map((p) => ({
        ...p,
        solutions: p.solutions.filter(
          (s) =>
            (show === "all" || s.expired === (show === "expired")) &&
            matches(p, s, words),
        ),
      }))
      .filter((p) => p.solutions.length > 0);
  }, [problems, query, market, show]);

  if (!live)
    return (
      <>
        <Heading />
        <section className="panel kb-empty">
          <BookOpen size={30} />
          <h2>Sign in to your company workspace</h2>
          <p>
            Solutions are written from your company's analysed orders and kept
            with your team's notes, so they need a connected workspace.
          </p>
          <a className="btn" href="#/login">
            Sign in
          </a>
        </section>
      </>
    );
  const count = (problems || []).reduce((n, p) => n + p.solutions.length, 0);
  return (
    <>
      <Heading />
      <div className="toolbar kb-toolbar">
        <div className="tabs" role="tablist" aria-label="Which solutions">
          {SHOW.map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={show === value}
              className={show === value ? "selected" : ""}
              onClick={() => setShow(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="kb-filters">
          {markets.length > 1 && (
            <select
              aria-label="Market"
              value={market}
              onChange={(e) => setMarket(e.target.value)}
            >
              <option value="all">All markets</option>
              {markets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Search solutions"
              placeholder="Search steps, notes, orders…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </div>
      {error && (
        <section className="panel" role="alert">
          {error}
        </section>
      )}
      {!problems && !error && (
        <section className="panel" role="status">
          <Loader2 size={15} className="spin" /> Loading solutions…
        </section>
      )}
      {problems && count === 0 && (
        <section className="panel kb-empty">
          <BookOpen size={30} />
          <h2>No saved solutions yet</h2>
          <p>
            Analyse your orders, then ask AI for a solution to a missing or
            wrong document on an order's report. It's saved here and offered
            for later orders with the same problem.
          </p>
          <a className="btn" href="#/workspace/orders">
            Go to orders
          </a>
        </section>
      )}
      {problems && count > 0 && shown.length === 0 && (
        <section className="panel" role="status">
          No {show === "all" ? "" : show + " "}solutions match.
        </section>
      )}
      {shown.map((problem) => (
        <section
          key={`${problem.market}-${problem.requirementKey}-${problem.problemStatus}`}
          className="panel an-solutions kb-problem"
          aria-label={`${problem.market}: ${problem.title}`}
        >
          <div className="sol-case">
            <h3>
              {problem.market} · {problem.title}
              <small>
                {problem.problemStatus === "missing" ? "Missing" : "Wrong"}
              </small>
            </h3>
            {!problem.inChecklist && (
              <p>This requirement is no longer in the {problem.market} checklist.</p>
            )}
            {problem.solutions.map((solution) => (
              <SolutionCard
                key={solution.id}
                solution={solution}
                isDefault={false}
                inUse={false}
                editable={editable}
                busy={false}
                notify={notify}
                onSolution={replaceSolution}
                onReviewed={reload}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
