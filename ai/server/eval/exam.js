// The company exam: questions a signed-in exporter asks about their own workspace, answered
// as the demo company (Binh Duong Wood) with its owner's token. Like golden.js, every expected
// fact is worked out from the company's live data when the exam runs (its orders and suppliers
// from GET /orders and /suppliers, its switched-on playbook rules, and a knowledge graph walk), so the exam
// stays right when the data or the date changes. Same expect fields as golden.js.
//
// When we find a wrong answer, add its question here.

const EU = new Set(["EU"]);
const NEGATIVE = ["no ", "not ", "n't", "none", "unable", "couldn't", "cannot"];
const VIETNAMESE = "[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]";
const GAP = new Set(["missing", "mismatch"]);
// Lists longer than this aren't checked id by id: a fair answer may summarise them.
const LISTED = 8;

const ids = (orders) => orders.map((o) => o.id);
const listed = (values) => (values.length && values.length <= LISTED ? values : []);
const money = (minor) => (minor / 100).toFixed(minor % 100 ? 2 : 0);

/**
 * company: { today (YYYY-MM-DD), markets: from GET /trade-map, orders: GET /orders?checklist=all
 * (each order with its placement, checks and gapCount), suppliers: GET /suppliers, rules:
 * switched-on playbook rules, changes: GET /market-requirements/changes?days=365,
 * acacia: GET /knowledge-graph/query?material=acacia&country=VN }.
 */
export function examCases(company) {
  const open = company.orders.filter((o) => o.shipDate >= company.today).sort((a, b) => a.shipDate.localeCompare(b.shipDate));
  const eu = open.filter((o) => EU.has(o.placement.market));
  const euGaps = eu.filter((o) => o.gapCount > 0);
  const gapped = open.filter((o) => o.gapCount > 0);
  const next = open[0];
  const byMarket = {};
  for (const o of open) (byMarket[o.placement.market || "none"] ||= []).push(o);
  const [market, marketOrders] = Object.entries(byMarket)
    .filter(([m, list]) => m !== "none" && new Set(list.map((o) => o.currency)).size === 1)
    .sort((a, b) => b[1].length - a[1].length)[0] || [null, []];
  const marketTotal = marketOrders.reduce((sum, o) => sum + o.valueMinor, 0);
  const noGeolocation = [
    ...new Set(open.filter((o) => o.checks.some((c) => c.requirementKey === "geolocation" && GAP.has(c.status))).map((o) => o.supplier)),
  ];
  const buyer = company.suppliers.find((s) => s.sourcing?.length);
  const acaciaMatches = company.acacia?.matches || [];
  const firstAcacia = acaciaMatches[0];
  const gapTitles = (orders) => [...new Set(orders.flatMap((o) => o.checks.filter((c) => GAP.has(c.status)).map((c) => c.title)))];
  const marketName = (code) => company.markets?.find((m) => m.code === code)?.name || code;
  const onFile = open.find((o) => o.checks.some((c) => c.status === "on_file"));
  const otherMarket = gapped[0] && company.markets?.find((m) => m.code !== gapped[0].placement.market);
  const euTotal = new Set(eu.map((o) => o.currency)).size === 1 ? eu.reduce((sum, o) => sum + o.valueMinor, 0) : null;
  // For the questions by level (easy, medium, hard).
  const total = (orders) => (new Set(orders.map((o) => o.currency)).size === 1 ? orders.reduce((sum, o) => sum + o.valueMinor, 0) : null);
  const daysAway = (iso) => (Date.parse(iso) - Date.parse(company.today)) / 86_400_000;
  const withHs = open.find((o) => o.hsCode);
  const clear = open.filter((o) => o.status === "clear");
  const byValue = [...open].sort((a, b) => b.valueMinor - a.valueMinor);
  const largest = byValue.length > 1 && byValue[0].valueMinor > byValue[1].valueMinor ? byValue[0] : byValue.length === 1 ? byValue[0] : null;
  const bySupplier = {};
  for (const o of open) (bySupplier[o.supplier] ||= []).push(o);
  const supplierCounts = Object.entries(bySupplier).sort((a, b) => b[1].length - a[1].length);
  const busiest = supplierCounts.length && (supplierCounts.length === 1 || supplierCounts[0][1].length > supplierCounts[1][1].length) ? supplierCounts[0] : null;
  const jp = byMarket.JP || [];
  const dueSoonGaps = open.filter((o) => daysAway(o.shipDate) <= 14 && o.gapCount > 0);
  const atRisk = gapped[0] ? open.filter((o) => o.supplier === gapped[0].supplier && o.gapCount > 0) : [];
  const us = byMarket.US || [];

  const cases = [
    {
      id: "company-eu-gaps",
      category: "orders",
      question: "Which of my open orders ship to the EU, and which of them are missing documents?",
      expect: { tools: ["query_orders"], contains: [...listed(ids(eu)), ...listed(ids(euGaps))] },
      rubric: "Lists the EU-bound orders, then names those with a missing or mismatched document and what is missing.",
    },
    gapped[0] && {
      id: "company-order-status",
      category: "orders",
      question: `What's the status of ${gapped[0].id}, and why?`,
      expect: {
        tools: ["query_orders"],
        contains: [gapped[0].id],
        containsAny: gapped[0].checks.filter((c) => GAP.has(c.status)).map((c) => c.title),
      },
      rubric: "Says the order needs action, names the missing or mismatched requirement and cites the rule behind it.",
    },
    next && {
      id: "company-next-shipment",
      category: "orders",
      question: "Which of my orders ships next, and is it ready to go?",
      expect: { tools: ["query_orders"], contains: [next.id] },
      rubric: `Names ${next.id} (ships ${next.shipDate}) and says whether it has open gaps (${next.gapCount}).`,
    },
    {
      id: "company-unknown-order",
      category: "hallucination-trap",
      question: "What's the status of PO-9999?",
      expect: { tools: ["query_orders"], containsAny: NEGATIVE },
      rubric: "Says there is no order PO-9999 in the workspace; invents nothing about it.",
    },
    noGeolocation.length && {
      id: "company-no-geolocation",
      category: "suppliers",
      question: "Which of my suppliers have no plot geolocation on file for my EU orders?",
      expect: { tools: ["query_orders"], contains: listed(noGeolocation) },
    },
    buyer && {
      id: "company-supplier-sourcing",
      category: "suppliers",
      question: `What does ${buyer.name} buy, and from where?`,
      expect: { containsAny: buyer.sourcing.map((s) => s.materialName) },
      rubric: `Names what ${buyer.name} buys as recorded (${buyer.sourcing.map((s) => `${s.materialName} from ${s.country}${s.formName ? ` as ${s.formName}` : ""}`).join("; ")}).`,
    },
    {
      id: "company-playbook-count",
      category: "rules",
      question: "How many playbook rules do I have switched on, and what are they?",
      expect: { tools: ["get_playbook"], contains: [String(company.rules.length)] },
    },
    gapped[0] && company.rules.length > 0 && {
      id: "company-playbook-for-order",
      category: "rules",
      question: `Which of my playbook rules matter for ${gapped[0].id}?`,
      expect: { tools: ["get_playbook", "query_orders"], contains: [gapped[0].id] },
      rubric: "Picks the rules that bear on this order (its supplier, market or missing document) and says why; doesn't list every rule as applying.",
    },
    acaciaMatches.length > 0 && {
      id: "company-graph-acacia",
      category: "connections",
      question: "If Vietnam restricted acacia log exports, which of my orders would be hit?",
      expect: { tools: ["query_graph"], contains: listed(acaciaMatches.map((m) => m.orderId)) },
      rubric: "Names the orders the graph walk reaches, each with the path that links it to acacia from Vietnam; claims no connection the paths don't show.",
    },
    firstAcacia && {
      id: "company-graph-why",
      category: "connections",
      question: `Why is ${firstAcacia.orderId} linked to acacia?`,
      expect: { tools: ["query_graph"], contains: [firstAcacia.orderId, firstAcacia.supplier] },
      rubric: `Explains the path: ${firstAcacia.path.map((s) => s.label).join(" → ")}.`,
    },
    market && {
      id: "company-market-total",
      category: "numbers",
      question: `What's the total value of my open orders to ${company.markets?.find((m) => m.code === market)?.name || market}?`,
      expect: { tools: ["query_orders", "calculate"], contains: [money(marketTotal)] },
      note: "The sum comes from calculate, never mental arithmetic.",
    },
    {
      id: "company-coming-changes",
      category: "rules",
      question: "Are any rules changing soon in the markets I ship to?",
      // The first change by any of its names: the checklist line, its regulation or the official ID.
      expect: { tools: ["upcoming_changes"], containsAny: (company.changes || []).slice(0, 1).flatMap((c) => [c.title, c.source?.regulationTitle, c.source?.officialId].filter(Boolean)) },
      rubric: `Names the checklist lines that take effect or change soon in the markets of open orders, with the date and the orders shipping after it; says so plainly if none. They are: ${(company.changes || []).map((c) => `${c.on} ${c.market} ${c.title} (orders: ${c.orderIds.join(", ") || "none"})`).join("; ") || "none"}.`,
    },
    {
      id: "company-news",
      category: "news",
      question: "Is there any recent news that affects my materials?",
      expect: { tools: ["get_alerts"] },
      rubric: "Cites dated alerts or articles about the company's own goods, or says none were found; invents no news.",
    },
    eu.length > 0 && {
      id: "company-vietnamese",
      category: "language",
      question: "Đơn hàng nào của tôi đi EU?",
      expect: { tools: ["query_orders"], contains: listed(ids(eu)), pattern: VIETNAMESE },
      note: "Reply in the user's language.",
    },
    // Supplier documents.
    gapped[0] && {
      id: "company-supplier-documents",
      category: "documents",
      question: `Which documents is ${gapped[0].supplier} missing for my orders?`,
      expect: { tools: ["query_orders"], containsAny: gapTitles(open.filter((o) => o.supplier === gapped[0].supplier)) },
      rubric: `Names the missing or mismatched documents on ${gapped[0].supplier}'s open orders, order by order.`,
    },
    onFile && {
      id: "company-documents-on-file",
      category: "documents",
      question: `Which documents do I already have on file for ${onFile.id}?`,
      expect: { tools: ["query_orders"], containsAny: onFile.checks.filter((c) => c.status === "on_file").map((c) => c.title) },
      rubric: "Lists the documents on file and, separately, any still missing.",
    },
    // Trade map and what-ifs.
    open.length > 0 && {
      id: "company-markets",
      category: "trade-map",
      question: "Which markets do my open orders go to, and how many to each?",
      expect: { tools: ["query_orders"], contains: listed(Object.keys(byMarket).filter((m) => m !== "none")) },
      rubric: `Counts: ${Object.entries(byMarket).map(([m, list]) => `${marketName(m)} ${list.length}`).join(", ")}.`,
    },
    otherMarket && {
      id: "company-whatif-market",
      category: "trade-map",
      question: `What if ${gapped[0].id} went to ${otherMarket.name} instead?`,
      expect: { tools: ["compare_order"], contains: [gapped[0].id] },
      rubric: `From the order's what-if comparison: the documents on file to reuse, what to redo or prepare for ${otherMarket.name}, what is no longer needed and what can't be told (e.g. duty); invents no ${otherMarket.name} requirements the comparison doesn't list.`,
    },
    gapped[0] && {
      id: "company-whatif-later",
      category: "trade-map",
      question: `What if ${gapped[0].id} shipped a month later?`,
      expect: { tools: ["compare_order"], contains: [gapped[0].id] },
      rubric: "From the order's what-if comparison for the later date: whether any checklist line takes effect or changes by then, and what still has to be prepared; invents no rule changes.",
    },
    // Follow-ups: the second question only makes sense with the first.
    euTotal !== null && eu.length > 0 && {
      id: "company-follow-up-total",
      category: "follow-up",
      messages: [
        { role: "user", text: "Which of my open orders ship to the EU?" },
        { role: "model", text: `These open orders ship to the EU: ${ids(eu).join(", ")}.` },
        { role: "user", text: "What are they worth in total?" },
      ],
      expect: { tools: ["calculate"], contains: [money(euTotal)] },
      note: '"they" are the EU orders; the sum comes from calculate.',
    },
    gapped[0] && {
      id: "company-follow-up-why",
      category: "follow-up",
      messages: [
        { role: "user", text: "Which of my orders are missing documents?" },
        { role: "model", text: `These orders are missing documents: ${ids(gapped).join(", ")}.` },
        { role: "user", text: "Why is the first one missing them?" },
      ],
      expect: { tools: ["query_orders"], contains: [gapped[0].id], containsAny: gapTitles([gapped[0]]) },
      rubric: `Explains ${gapped[0].id}'s missing documents and the rule behind each.`,
    },
    // Easy: one lookup.
    {
      id: "easy-open-count",
      category: "easy",
      question: "How many open orders do I have?",
      expect: { tools: ["query_orders"], contains: [String(open.length)] },
    },
    open[0] && {
      id: "easy-order-supplier",
      category: "easy",
      question: `Who supplies ${open[0].id}?`,
      expect: { tools: ["query_orders"], contains: [open[0].supplier] },
    },
    withHs && {
      id: "easy-order-hs",
      category: "easy",
      question: `What HS code is on ${withHs.id}?`,
      expect: { tools: ["query_orders"], contains: [withHs.hsCode] },
    },
    {
      id: "easy-how-import",
      category: "easy",
      question: "How do I import my orders from a spreadsheet?",
      expect: { tools: ["search_knowledge"], containsAny: ["CSV", "csv"] },
      rubric: "Explains the CSV import from the help guide (the columns it needs, checking rows, committing), citing the guide.",
    },
    // Medium: filter, rank or follow up.
    {
      id: "medium-clear-orders",
      category: "medium",
      question: "Which of my open orders are in the clear?",
      expect: { tools: ["query_orders"], contains: listed(ids(clear)) },
      rubric: `Lists the open orders with status clear (${ids(clear).join(", ") || "none"}), and none of the others.`,
    },
    largest && {
      id: "medium-largest-order",
      category: "medium",
      question: "What's my largest open order by value?",
      expect: { tools: ["query_orders"], contains: [largest.id, money(largest.valueMinor)] },
    },
    busiest && {
      id: "medium-busiest-supplier",
      category: "medium",
      question: "Which supplier has the most open orders, and how many?",
      expect: { tools: ["query_orders"], contains: [busiest[0], String(busiest[1].length)] },
    },
    jp.length > 1 && {
      id: "medium-follow-up-first",
      category: "medium",
      messages: [
        { role: "user", text: "Which of my orders go to Japan?" },
        { role: "model", text: `These orders go to Japan: ${ids(jp).join(", ")}.` },
        { role: "user", text: "Which of them ships first, and when?" },
      ],
      expect: { tools: ["query_orders"], contains: [jp[0].id] },
      rubric: `Names ${jp[0].id}, shipping ${jp[0].shipDate}.`,
    },
    // Hard: several steps, sums and judgement.
    {
      id: "hard-due-soon-gaps",
      category: "hard",
      question: "Which orders ship in the next 14 days and still have missing documents? What should I do first?",
      expect: { tools: ["query_orders"], contains: listed(ids(dueSoonGaps)) },
      rubric: `Names the open orders shipping by ${company.today} + 14 days with a missing or mismatched document (${ids(dueSoonGaps).join(", ") || "none"}), what each is missing, and puts the earliest ship date first; says so plainly if none.`,
    },
    atRisk.length > 0 && total(atRisk) !== null && {
      id: "hard-supplier-risk",
      category: "hard",
      question: `If ${gapped[0].supplier} can't send the missing documents before shipping, which orders and how much value are at risk?`,
      expect: { tools: ["query_orders", "calculate"], contains: [...listed(ids(atRisk)), money(total(atRisk))] },
      note: "The total comes from calculate.",
    },
    eu.length > 0 && us.length > 0 && total(eu) !== null && total(us) !== null && {
      id: "hard-market-compare",
      category: "hard",
      question: "Compare my EU and US orders: how many open orders and what total value in each market?",
      expect: { tools: ["query_orders"], contains: [money(total(eu)), money(total(us))] },
      rubric: `EU: ${eu.length} open orders, ${money(total(eu))}; US: ${us.length}, ${money(total(us))}. Totals from calculate or a tool, never mental arithmetic.`,
    },
    gapped[0] && {
      id: "hard-unknown-rate",
      category: "hallucination-trap",
      question: `What anti-dumping duty rate applies to ${gapped[0].id}?`,
      expect: { tools: ["query_orders"] },
      rubric: `Says the order's records show no anti-dumping duty for ${gapped[0].id} (to ${gapped[0].placement.market}); invents no rate, and may point to the official source to check.`,
    },
    // The demo video's questions, word for word (docs/local/demo/recording.md).
    euGaps.length > 0 && {
      id: "demo-eu-border",
      category: "demo",
      question: "Which of my orders could be held at the EU border, and why?",
      expect: { tools: ["query_orders"], contains: listed(ids(euGaps)), containsAny: euGaps.flatMap((o) => o.checks.filter((c) => GAP.has(c.status)).map((c) => c.title)) },
      rubric: "Names the EU orders with a missing or mismatched document, what is missing and the regulation behind it, citing it.",
    },
    acaciaMatches.length > 0 && {
      id: "demo-acacia-restriction",
      category: "demo",
      question: "What if Vietnam restricts acacia log exports?",
      expect: { tools: ["query_graph"], contains: listed(acaciaMatches.map((m) => m.orderId)) },
      rubric: "Names every order the graph walk reaches, each with its cited path; claims no connection the paths don't show.",
    },
    {
      id: "demo-acacia-news",
      category: "demo",
      question: "Is there any news this month that could affect my acacia plywood?",
      expect: { tools: ["get_alerts"] },
      rubric: "Cites dated alerts or articles from this month about acacia plywood or its rules, or says none were found; invents no news.",
    },
    gapped[0] && company.rules.length > 0 && {
      id: "demo-playbook-rules",
      category: "demo",
      question: `Which of my playbook rules apply to ${gapped[0].id}?`,
      expect: {
        tools: ["get_playbook"],
        contains: company.rules.filter((r) => r.text.includes(gapped[0].supplier)).map(() => gapped[0].supplier).slice(0, 1),
      },
      rubric: `Names the rules that bear on ${gapped[0].id} (its supplier ${gapped[0].supplier}, market ${gapped[0].placement.market}) and why, from: ${company.rules.map((r) => r.text).join(" | ")}`,
    },
    gapped[0] && {
      id: "demo-duty-calc",
      category: "demo",
      question: `${gapped[0].id} is worth $${(gapped[0].valueMinor / 100).toLocaleString("en-US")}. At a 4.7% duty, how much is the duty?`,
      expect: { tools: ["calculate"], contains: [money(Math.round(gapped[0].valueMinor * 0.047))] },
    },
    // No prompt-leak, injection or off-topic questions: scripted runs of attack-like prompts got
    // the project's Gemini access restricted (Nov 2026).
  ];
  return cases
    .filter(Boolean)
    .map((c) => ({ ...c, set: "company", question: c.question || c.messages.at(-1).text, messages: c.messages || [{ role: "user", text: c.question }] }));
}
