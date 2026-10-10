// Help guides indexed for the assistant. Keep these in step with the app.
export const GUIDES = [
  {
    id: "overview",
    title: "Overview page",
    url: "#/workspace",
    text: "The Overview shows the Vietnam → Singapore → Europe trade corridor at a glance: open orders, orders that need attention, estimated value at risk and days until the next affected shipment. Below are the priority action, the top three news alerts from the daily scan and recent orders. 'Run demo' walks through a sample rule change step by step.",
  },
  {
    id: "orders",
    title: "Orders and order impact",
    url: "#/workspace/orders",
    text: "Orders lists open orders with search and four filters: All orders, Action needed, In the clear and Awaiting analysis. Selecting an order opens its impact detail: cost breakdown, deadline, recommendation, evidence, the five-stage reasoning trace and an editable supplier message. Confirming the message is simulated; nothing is sent. Orders are stored in the browser for this demo.",
  },
  {
    id: "news-watch",
    title: "News watch and daily news scan",
    url: "#/workspace/news",
    text: "News watch reads the approved news sources every day at 07:00 Vietnam time. Gemini on Vertex AI checks each new article against the stock list and raises alerts with severity (high, medium, low), direction (risk, opportunity, watch), the affected SKUs with reasons, stock value exposed and a next step. Tabs: Alerts, Stock and Sources. 'Scan now' runs a scan on demand, at most once every 10 minutes. On Sources you can turn feeds on or off and add any public HTTPS RSS or Atom feed; built-in sources cannot be deleted.",
  },
  {
    id: "rule-watch",
    title: "Rule watch demo",
    url: "#/workspace/rules",
    text: "Rule watch shows monitored source coverage and a before/after sample obligation, then runs a simulated rule change through five stages: Relevance, Exposure, Cost, Plan and Auditor. The Auditor rejects an unsupported recommendation and a corrected output follows. The legal text is an illustrative sample, not a verified current regulation.",
  },
  {
    id: "data-room",
    title: "Importing orders in the Data room",
    url: "#/workspace/data",
    text: "The Data room imports orders from a CSV file. Required columns: id, product, supplier, destination, value, shipDate, hsCode. Value must be a positive number, shipDate must use YYYY-MM-DD and order ids must be unique. Rows are validated and previewed before you confirm the import. A starter template can be downloaded on the page. Imported orders show 'Awaiting analysis'. Excel, photo and PDF extraction are not available yet.",
  },
  {
    id: "playbook",
    title: "Playbook rules",
    url: "#/workspace/playbook",
    text: "The Playbook holds plain-language business rules of four types: Policy, Threshold, Supplier and Watchlist. You can add rules, switch them on or off and delete them. Rules are saved in the browser and are not yet evaluated against orders automatically.",
  },
  {
    id: "assistant",
    title: "Assistant, citations and audit trail",
    url: "#/chat",
    text: "The assistant is an agent. It searches a vector index of news articles, alerts, stock items, sources and these guides, looks up exact stock data and alerts, and cites what it used with numbered references. Every answer has an audit trail: the model's reasoning summary, each tool call with its inputs and results, the citations, model, token use and timing. Questions, answers and audit records are stored in Firestore so they can be reviewed later.",
  },
  {
    id: "demo-data",
    title: "Demo data and limits",
    url: "#/workspace",
    text: "ExportMate is a demo workspace for Binh Duong Wood Co., a fictional Vietnamese wood-products and furniture exporter. Stock data is synthetic; news articles are real and come only from the approved sources. Orders, playbook rules and the profile are stored in the browser. Alerts and answers are AI assessments, not legal advice; check regulations against the official source.",
  },
  {
    id: "views-account",
    title: "Maker/Buyer view and account settings",
    url: "#/workspace/account",
    text: "The Maker/Buyer switch in the top bar shows separately prepared estimates for the manufacturer (USD) and the Singapore buyer (SGD); it is not a currency conversion or a separate login. Account settings hold the profile, company, role, trade corridor and alert preferences. Sign-in is a demo preview without real authentication.",
  },
];
