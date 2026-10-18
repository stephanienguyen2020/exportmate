// Material chain: the links the knowledge graph walks from news to orders (logs are used to make
// veneer, veneer to make plywood…), the source behind each one, who checked it, and how often
// your team confirmed or rejected suggestions that went through it. Links people keep rejecting
// are avoided when an equally short path exists (backend services/graph_feedback.py).
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, GitBranch, Loader2, Search } from "lucide-react";
import { api, type ChainLink, type MaterialChain as Chain } from "./api";
import { errorMessage } from "./auth";
import "./material-chain.css";

const WAYS: Record<string, string> = {
  supplier: "Through a supplier's materials",
  hs: "By HS heading",
  linked: "Linked by a person",
};
const RELATION: Record<ChainLink["relation"], string> = {
  used_to_make: "used to make",
  by_product: "leaves",
};

function Heading() {
  return (
    <header className="page-heading">
      <div>
        <div className="eyebrow">HOW NEWS REACHES YOUR ORDERS.</div>
        <h1>Material chain.</h1>
        <p>
          News watch follows these links from what an article names to your
          orders: what a supplier buys, what that is used to make, and your
          order's product. Each link cites its source.
        </p>
      </div>
    </header>
  );
}

function Verdicts({ link }: { link: ChainLink }) {
  const { confirmed, rejected } = link.company;
  const everyone = link.everyone.confirmed + link.everyone.rejected;
  return (
    <>
      {confirmed || rejected ? (
        <span>
          Your team: {confirmed} confirmed · {rejected} rejected
        </span>
      ) : (
        <span className="mc-muted">No verdicts from your team yet</span>
      )}
      {everyone > 0 && (
        <span title="Every company's verdicts, counted nightly. Between equally good paths, the walk prefers links with a higher weight.">
          All companies: {link.everyone.confirmed} confirmed · {link.everyone.rejected} rejected · weight{" "}
          {link.weight.toFixed(2)}
        </span>
      )}
    </>
  );
}

function LinkRow({ link }: { link: ChainLink }) {
  const check = link.aiCheck;
  return (
    <li className={link.doubt ? "doubted" : ""}>
      <div className="mc-link-head">
        <b>{link.fromName}</b>
        <span className="mc-relation">{RELATION[link.relation]}</span>
        <b>{link.toName}</b>
        {link.secondary && (
          <span className="status grey" title="Used only when no equally short path avoids it">
            <i />
            Less common route
          </span>
        )}
        {link.doubt && (
          <span className="status amber" title="Avoided when an equally short path exists">
            <i />
            {link.doubt}
          </span>
        )}
      </div>
      <p className="mc-quote">
        {link.quote ? `“${link.quote}”` : link.basis}{" "}
        <a href={link.sourceUrl} target="_blank" rel="noopener noreferrer">
          {link.sourceTitle}
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      </p>
      <small className="mc-meta">
        {check && (
          <span>
            Checked by {check.by}, {check.on}: {check.verdict}. {check.note}
          </span>
        )}
        <Verdicts link={link} />
      </small>
    </li>
  );
}

export default function MaterialChain({ live }: { live: boolean }) {
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    api
      .materialChain(controller.signal)
      .then((value) => !controller.signal.aborted && setChain(value))
      .catch((e) => !controller.signal.aborted && setError(errorMessage(e)));
    return () => controller.abort();
  }, [live]);
  const words = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const shown = (links: ChainLink[]) =>
    links.filter((link) => {
      const text = [link.fromName, link.toName, link.quote, link.basis, link.sourceTitle]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });

  if (!live)
    return (
      <>
        <Heading />
        <section className="panel kb-empty">
          <GitBranch size={30} />
          <h2>Sign in to your company workspace</h2>
          <p>
            The chain is matched to your company's suppliers and orders, so it
            needs a connected workspace.
          </p>
          <a className="btn" href="#/login">
            Sign in
          </a>
        </section>
      </>
    );
  if (error)
    return (
      <>
        <Heading />
        <p className="news-error" role="alert">
          {error}
        </p>
      </>
    );
  if (!chain)
    return (
      <>
        <Heading />
        <p className="mc-muted">
          <Loader2 size={14} className="spin" /> Loading the material chain…
        </p>
      </>
    );
  return (
    <>
      <Heading />
      <section className="panel mc-accuracy" aria-label="How suggestions did">
        <h2>How suggestions did</h2>
        {chain.byWay.length ? (
          <ul>
            {chain.byWay.map((way) => (
              <li key={way.via}>
                <b>{WAYS[way.via]}</b>
                <span>
                  {way.confirmed} confirmed · {way.rejected} rejected
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mc-muted">
            No verdicts yet. Confirm or reject the orders News watch suggests,
            and this shows how often each way of finding them is right.
          </p>
        )}
        <p className="mc-muted">
          {chain.weightsUpdatedAt
            ? `Every company's verdicts were last counted ${new Date(chain.weightsUpdatedAt).toLocaleString()}; your team's count straight away.`
            : "Every company's verdicts are counted nightly; your team's count straight away."}
        </p>
      </section>
      <div className="toolbar mc-toolbar">
        <label className="search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Search links"
            placeholder="Search products, quotes, sources"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {chain.industries.map((industry) => {
        const links = shown(industry.links);
        return (
          <section className="panel mc-industry" key={industry.key}>
            <h2>{industry.name}</h2>
            <div className="mc-products" aria-label={`${industry.name} products`}>
              {industry.products.map((p) => (
                <span key={p.key} title={p.stage ?? undefined}>
                  {p.name} <small>{p.hsCodes.slice(0, 2).join(", ")}</small>
                </span>
              ))}
            </div>
            {links.length ? (
              <ul className="mc-links" aria-label={`${industry.name} links`}>
                {links.map((link) => (
                  <LinkRow key={link.fromKey + ">" + link.toKey} link={link} />
                ))}
              </ul>
            ) : (
              <p className="mc-muted">No link matches your search.</p>
            )}
          </section>
        );
      })}
      <section className="panel mc-materials">
        <h2>Materials news and documents name</h2>
        <ul>
          {chain.materials.map((m) => (
            <li key={m.key}>
              <b>{m.name}</b>
              <small>
                {[m.scientificNames.join(", "), m.woodType].filter(Boolean).join(" · ")}
              </small>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
