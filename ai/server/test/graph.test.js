import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, graphQuery, makeRefs, workspaceReaders } from "../agents/tools.js";
import { toolGateway } from "../gateway.js";
import { review, uncitedPaths } from "../review.js";
import { critique, criticPrompt, graphPaths, parseVerdict } from "../critic.js";
import { RULES, rulesFor } from "../policy.js";
import { routeQuestion } from "../router.js";

// GET /api/v1/knowledge-graph/query's answer for acacia logs from Vietnam (backend tests).
const walked = {
  understood: { materials: ["Acacia"], products: ["Logs (wood in the rough)"], countries: ["Vietnam"], markets: [], unknown: [] },
  ordersChecked: 4,
  matches: [
    {
      orderId: "PO-1",
      product: "Acacia plywood 18 mm",
      supplier: "Binh Phu Wood",
      destination: "Rotterdam, NL",
      market: "EU",
      shipDate: "2026-10-28",
      status: "exposed",
      via: "supplier",
      reason: "Binh Phu Wood buys acacia from Vietnam; Logs (HS 4403) → Veneer sheets (HS 4408) → Plywood (HS 4412), this order's product.",
      path: [
        { kind: "mention", label: "acacia logs, VN", link: null, sourceTitle: null, sourceUrl: null, quote: null },
        { kind: "supplier", label: "Binh Phu Wood", link: "buys acacia from Vietnam (species document)", sourceTitle: null, sourceUrl: null, quote: null },
        { kind: "product", label: "Logs (HS 4403)", link: "bought as", sourceTitle: null, sourceUrl: null, quote: null, key: "wood.roundwood" },
        { kind: "product", label: "Veneer sheets (HS 4408)", link: "used to make", sourceTitle: "FAO definitions", sourceUrl: "https://fao.org/defs.pdf", quote: "used for the production of veneer", key: "wood.veneer" },
        { kind: "product", label: "Plywood (HS 4412)", link: "used to make", sourceTitle: "FAO definitions", sourceUrl: "https://fao.org/defs.pdf", quote: "veneer sheets glued together", key: "wood.plywood" },
        { kind: "order", label: "PO-1 Acacia plywood 18 mm", link: "supplied by Binh Phu Wood", sourceTitle: null, sourceUrl: null, quote: null },
      ],
    },
  ],
};

test("query_graph's arguments become the backend's query string", () => {
  assert.equal(graphQuery({ materials: ["acacia logs"], countries: ["VN", "LA"] }), "material=acacia+logs&country=VN&country=LA");
  assert.equal(graphQuery({ hsCodes: ["4403"], markets: ["EU"], includeShipped: true }), "hsCode=4403&market=EU&includeShipped=true");
});

test("the graph is read from the company backend with the caller's token, never in the demo", async () => {
  const asked = [];
  const readers = workspaceReaders(async (path) => (asked.push(path), { status: 200, body: { data: walked } }), null);
  assert.deepEqual(await readers.graph({ materials: ["acacia"] }), walked);
  assert.deepEqual(asked, ["/api/v1/knowledge-graph/query?material=acacia"]);
  assert.equal(workspaceReaders(null, { orders: [] }).graph, null);
});

test("query_graph cites each order's path and each official text once", async () => {
  const refs = makeRefs();
  const { output, audit } = await REGISTRY.query_graph.run({ materials: ["acacia logs"], countries: ["VN"] }, { refs, graph: async () => walked });
  const [match] = output.matches;
  assert.equal(output.ordersChecked, 4);
  assert.deepEqual(output.understood.unknown, []);
  assert.equal(match.orderId, "PO-1");
  assert.equal(match.via, "through its supplier's sourcing and the material chain");
  const sources = match.path.filter((s) => s.source);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].source, sources[1].source); // the same FAO text, one ref
  const cited = refs.all();
  assert.deepEqual(
    cited.map((c) => c.type),
    ["query", "path", "chain_source"],
  );
  assert.equal(cited.find((c) => c.type === "path").url, "#/workspace/orders/PO-1");
  assert.equal(audit.count, 1);
});

test("query_graph needs a material, country or HS code, and a company workspace", async () => {
  const refs = makeRefs();
  await assert.rejects(REGISTRY.query_graph.run({ markets: ["EU"] }, { refs, graph: async () => walked }), /at least one material/);
  const demo = toolGateway(REGISTRY, { refs, graph: null }, { maxCalls: 5 });
  assert.ok(!demo.declarations().some((d) => d.name === "query_graph"));
  const refused = await demo.call("query_graph", { materials: ["acacia"] });
  assert.equal(refused.errorKind, "denied");
});

test("the auditor wants a path cited for each order named from the graph", () => {
  const retrieved = [
    { ref: 1, type: "query", title: "walk" },
    { ref: 2, type: "path", id: "PO-1", title: "PO-1 · …" },
    { ref: 3, type: "path", id: "PO-12", title: "PO-12 · …" },
  ];
  assert.deepEqual(uncitedPaths("PO-1 uses Vietnamese acacia [2]. PO-12 does too.", retrieved, [2]), ["PO-12"]);
  assert.deepEqual(uncitedPaths("PO-12 uses it [3].", retrieved, [3]), []); // PO-1 isn't inside PO-12
  const { problems, checks } = review({ answer: "PO-1 is exposed [1].", retrieved, evidence: "", usedTools: true });
  assert.match(problems.join(" "), /Cite the knowledge graph path .*PO-1/);
  assert.equal(checks.find((c) => c.name === "Connections cite their graph paths").ok, false);
  assert.equal(review({ answer: "Nothing.", retrieved: [], evidence: "", usedTools: false }).checks.at(-1).detail, "No graph paths retrieved");
});

test("the critic reads the answer against the paths, fenced as data", async () => {
  const paths = graphPaths([
    { matches: [{ ref: 2, orderId: "PO-1", product: "Acacia plywood", destination: "Rotterdam, NL", market: "EU", path: [{ kind: "supplier", label: "Binh Phu <b>Wood</b>", link: "buys acacia from Vietnam" }] }] },
  ]);
  const prompt = criticPrompt("PO-1 uses acacia from Laos [2].", paths);
  assert.match(prompt, /<path ref="2" order="PO-1">\nOrder: product: Acacia plywood; destination: Rotterdam, NL; market: EU\n/);
  assert.match(prompt, /buys acacia from Vietnam: Binh Phu ‹b›Wood‹\/b›/);
  assert.match(prompt, /<answer>\nPO-1 uses acacia from Laos \[2\]\.\n<\/answer>/);

  let asked = 0;
  const generate = async () => (asked++, JSON.stringify({ orders: [{ orderId: "PO-1", supported: false, problem: "Says Laos; the path says Vietnam." }] }));
  assert.deepEqual(await critique({ answer: "PO-1 uses acacia from Laos [2].", paths, generate }), {
    supported: false,
    problems: ["PO-1: Says Laos; the path says Vietnam."],
    model: (await import("../models.js")).TIERS.complex.model,
  });
  // No paths, nothing to judge; a judge that fails leaves the answer to the auditor.
  assert.equal((await critique({ answer: "x", paths: [], generate })).skipped, true);
  assert.equal(asked, 1);
  const failed = await critique({ answer: "x", paths, generate: async () => Promise.reject(new Error("quota")) });
  assert.deepEqual([failed.supported, failed.error], [true, "quota"]);
});

test("the critic's verdict, order by order: malformed, or faulted without a reason, means supported", () => {
  const verdict = (orders) => parseVerdict(JSON.stringify({ orders }));
  assert.deepEqual(parseVerdict("not json"), { supported: true, problems: [] });
  assert.deepEqual(verdict([{ orderId: "PO-1", supported: true }, { orderId: "PO-2", supported: true }]), { supported: true, problems: [] });
  assert.deepEqual(verdict([{ orderId: "PO-1", supported: false }]), { supported: true, problems: [] });
  assert.deepEqual(verdict([{ orderId: "PO-1", supported: true, problem: "ignored" }, { orderId: "PO-2", supported: false, problem: "Adds a supplier." }]), {
    supported: false,
    problems: ["PO-2: Adds a supplier."],
  });
  assert.equal(verdict(Array.from({ length: 9 }, (_, n) => ({ orderId: `PO-${n}`, supported: false, problem: "x" }))).problems.length, 5);
});

test("graph questions get the graph rule and the analyst", () => {
  assert.ok(rulesFor({ graph: async () => walked }).some((r) => r.id === "graph-paths"));
  assert.ok(!rulesFor({}).some((r) => r.id === "graph-paths"));
  assert.ok(RULES.find((r) => r.id === "graph-paths").prevents);
  for (const q of ["Which orders depend on acacia from Laos?", "What if Vietnam restricts acacia log exports?", "Which of my orders use plywood?"])
    assert.equal(routeQuestion([{ role: "user", text: q }]).tier, "complex", q);
  assert.equal(routeQuestion([{ role: "user", text: "How do I add a news source?" }]).tier, "simple");
});
