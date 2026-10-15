// Help guides indexed for the assistant. Keep these in step with the app (docs/AI_GUIDE.md
// describes the AI features in more detail); after changing them, run `npm run index`.
import { STOCK_PROFILE, generateInventory } from "./inventory.js";

export const GUIDES = [
  {
    id: "overview",
    title: "Overview page",
    url: "#/workspace",
    text: "The Overview shows your trade corridor (the route set at signup, e.g. Vietnam → Singapore → European Union; change it in Account › About company), then four figures: open orders, orders that need your attention, the value at risk (in a signed-in workspace, the full value of affected orders, by currency) and the next affected shipment. Below are the priority action, the top three News watch alerts and recent orders. In a signed-in workspace, 'Company report' prepares a report and 'Explore your corridor' opens the trade map. 'Run demo' walks through a sample rule change step by step.",
  },
  {
    id: "orders",
    title: "Orders and order detail",
    url: "#/workspace/orders",
    text: "Orders lists your open orders with search and filters: All orders, Action needed and In the clear, plus Awaiting analysis in a signed-in workspace. An order missing data (HS code, market checklist or supplier record) is Action needed, and its next step says what to add. 'Import orders' opens the Data room, and importing analyses the new orders straight away. In a signed-in workspace, an order's page shows its supplier, ship date, value and HS code, the CSV row it was imported from, a link to the trade map to see what would change in another market, and 'Prepare report' for a compliance report. Its document checklist for its market is on the trade map. In the browser demo, an order affected by the sample rule change shows its impact: a cost estimate, the evidence, a simulated five-stage review and a supplier message you can edit and confirm; nothing is actually sent.",
  },
  {
    id: "trade-map",
    title: "Trade map, suppliers and sites",
    url: "#/workspace/map",
    text: "The Trade map shows where your orders go: a 3D globe with routes from your origin to each market, a 2D world view and regional maps. Select an order, a market or a supplier to see the document checklist for that market, each line on file, missing, wrong standard, to prepare or to check, with the official text it comes from. For an order you can compare another market, a different ship date or another route. Owners and editors add, edit and delete suppliers (with their documents) and company sites in the side panel; while a form is open, click the map to place it. Routes start from the site marked as the route origin. Connections are illustrative, not vessel tracking. The map needs a signed-in company workspace; the browser demo shows a sign-in prompt.",
  },
  {
    id: "news-watch",
    title: "News watch and daily news scan",
    url: "#/workspace/news",
    text: "News watch reads the approved news sources every day at 07:00 Vietnam time. Gemini on Vertex AI checks each new article's headline and summary against the stock list and raises alerts with severity (high, medium, low), direction (risk, opportunity, watch), the affected SKUs with reasons, stock value exposed and a next step. Alerts are matched against ExportMate's sample stock, not your company's own stock or orders. Tabs: Alerts (filter by severity or opportunities), Stock and Sources. In a signed-in company workspace, owners and editors can press 'Scan now' (at most once every 10 minutes; a scan takes about a minute), switch sources on or off, and add their own source: any public RSS or Atom feed over HTTPS, tested before it is saved, up to 10 per company. Switching off a built-in source affects only your company, and a source you add is only read for your company. Built-in sources can be switched off but not deleted; your own sources can be removed. Viewers and the browser demo see sources read-only.",
  },
  {
    id: "rule-watch",
    title: "Rule watch",
    url: "#/workspace/rules",
    text: "In a signed-in workspace, Rule watch lists the requirements behind your orders' market checklists, one entry per requirement and market, with the orders it applies to and the official text behind it. ExportMate doesn't yet read new rule texts by itself; the official texts are in the Regulations library. In the browser demo, Rule watch shows sample sources and a before/after sample obligation, then runs a simulated rule change through five stages: Relevance, Exposure, Cost, Plan and Auditor. The Auditor rejects an unsupported recommendation and a corrected output follows. The demo's legal text is an illustrative sample, not a verified current regulation.",
  },
  {
    id: "regulations",
    title: "Regulations library",
    url: "#/workspace/regulations",
    text: "Regulations is the library of official texts and your company's own references. Search by title or official ID, see each text's version history and details, and download the exact source file. Shared official texts are read-only. Owners and editors can upload a new reference (PDF, HTML or TXT, up to 4 MB) or a new version of one of the company's own regulations. Checklist lines on the trade map, in reports and in the assistant's answers link to the exact document version they cite. Uploading stores the file; ExportMate does not yet extract requirements from it. The library needs a signed-in company workspace.",
  },
  {
    id: "reports",
    title: "Reports: order and company reports",
    url: "#/workspace/reports",
    text: "Reports prepares a compliance report as a draft you can edit before you download it as a PDF or email it. An order report (from an order's page, 'Prepare report') holds the order, its market document checklist with the official texts and the CSV row it came from. A company report covers checklist changes ahead, high and medium News watch alerts (matched against the sample stock), sample flood observations near your suppliers and sites, new regulation versions, orders with gaps and your suppliers. Only you see your drafts. You can change any text or row, and the PDF shades every line you changed. Owners and editors can email a report to up to five recipients, which locks the draft. Reports need a signed-in company workspace.",
  },
  {
    id: "data-room",
    title: "Importing orders in the Data room",
    url: "#/workspace/data",
    text: "The Data room imports orders from a CSV file of up to 4 MB and 10,000 rows. Required columns: id, product, supplier, destination, value, shipDate, hsCode. An optional currency column takes a 3-letter code such as USD; without it, the company's currency is used. Value must be a positive number, shipDate must use YYYY-MM-DD and order ids must be unique. Rows are checked and previewed before you confirm the import. A template and sample orders can be downloaded on the page. In a signed-in workspace, the file is saved to your company, only owners and editors can import, imported orders show 'Awaiting analysis' and their market checklists appear on the trade map. In the browser demo, the file stays in your browser, and each imported order is checked against the demo's sample rule change like the seeded ones. Excel files (save them as CSV), photos and reading documents are not supported yet.",
  },
  {
    id: "playbook",
    title: "Playbook rules",
    url: "#/workspace/playbook",
    text: "The Playbook holds your own business rules in plain words, of four types: Policy, Threshold, Supplier and Watchlist, for example 'Tell me if an order's margin falls below 8%.' You can add rules, switch them on or off and delete them. The ExportMate assistant reads the rules that are switched on and applies them when it advises on an order, a supplier, a shipment or a news alert, citing each rule it uses; order statuses don't use them yet. In a signed-in workspace, rules are saved to your company playbook and only owners and editors can change them; in the browser demo they are saved in your browser.",
  },
  {
    id: "assistant",
    title: "Assistant, citations and audit trail",
    url: "#/chat",
    text: "The ExportMate assistant is a team of AI agents on Google's Gemini Enterprise Agent Platform: a quick-answer agent for lookups and an analyst that asks stock, news, company and knowledge specialists for questions that need several facts. Open it with the chat button at the bottom right, or full screen at #/chat, which also shows the audit trail. It answers questions about the sample stock, News watch alerts and news, scan and source status, how to use ExportMate, and your orders and playbook rules; in a signed-in workspace also your company profile from Account › About company. In the browser demo, it reads the demo's orders and playbook from your browser with each question. It cites every fact with a numbered reference that links to its source. Before an answer is shown, an auditor checks that the citations match what its tools returned, that figures come from tool results or your messages, that cited news is dated and that links are real sources; an answer that still fails is marked Needs review. Each answer has an audit trail: every step and tool call with the agent that made it, its inputs and results, the specialists' reports, the checks, the model, token use and timing, downloadable as JSON. In a signed-in company workspace the assistant remembers your preferences and what you work on (not personal details) for 180 days, only for you; see and remove them under Account › What the assistant remembers. The assistant only reads data: it can't change records, send messages or start a scan. Questions, answers and audit records are stored so they can be reviewed later.",
  },
  {
    id: "demo-data",
    title: "Sample data, the browser demo and limits",
    url: "#/workspace",
    text: `ExportMate's stock list is synthetic: ${generateInventory().length} items of ${STOCK_PROFILE.company}, ${STOCK_PROFILE.about}, used by News watch and the assistant in every workspace. News articles are real and come only from the approved sources. 'Explore the demo' opens a sample workspace with no account: its orders, playbook rules and profile are stored in your browser, and its order checks cover one sample rule change. A signed-in company workspace keeps its orders, playbook, company profile, suppliers, sites, regulations and reports in ExportMate's database. Alerts and answers are AI assessments, not legal advice; check regulations against the official source.`,
  },
  {
    id: "views-account",
    title: "Account, sign-in and roles",
    url: "#/workspace/account",
    text: "Account holds your profile, notification preferences (order alerts, weekly summary) and About company: company name and role, a description, what you make or sell, main materials and origin, certifications, website, year founded, team size, order currency and the trade route (where you ship from, any transit stops and your primary destination). The ExportMate assistant reads About company to answer questions about your company. What the assistant remembers lists what the assistant remembers about you from your chats (your preferences, instructions and the markets and products you work on), each with a Forget button; colleagues have their own, and the demo has none. In a signed-in workspace, only the company owner can change company details. Sign-in uses Firebase: email and password with email verification and password reset, or Continue with Google. Owners and editors can import orders and change playbook rules, news sources, suppliers and sites; viewers can read. In the browser demo, the Maker/Buyer switch in the top bar shows separately prepared estimates for the manufacturer (USD) and a Singapore buyer (SGD); it is not a currency conversion or a separate login.",
  },
];
