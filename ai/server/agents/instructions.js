// What each agent is told. The assistant's prompt is built from policy.js's versioned rules;
// the analyst's adds how to work through a question with several parts.
import { rulesFor } from "../policy.js";
import { asData } from "../guard.js";

// Who the assistant works for. A signed-in company's profile comes from the backend
// (GET /api/v1/company/knowledge) and its stock is its own goods (the backend's GET /news-goods); without one, the
// demo company, named by its goods' profile (`stockOwner`), whose orders and playbook the browser
// sends with the question (when it has them). `session` is
// { company, orders, playbook, stock, stockOwner } (agent.js).
function workspace(session) {
  const { company } = session;
  const owner = session.stockOwner?.company ? `${session.stockOwner.company}, ${session.stockOwner.about}` : "a sample company";
  if (!company)
    return `The workspace belongs to ${owner}, in ExportMate's browser demo. ${session.orders ? "Its sample orders (order ids such as PO-2291, values, ship dates, statuses and the demo's one sample rule check) come from query_orders; they include any the user imported. " : ""}${session.playbook ? "Its playbook rules come from get_playbook. " : ""}Its stock data is synthetic demo data, separate from its orders; its news articles are real, from approved sources.`;
  const c = company.company;
  return `You are working for ${c.name} (${c.businessRole}, based in ${c.origin}, primary market ${c.destination}). Its own company profile (what it does and makes, materials, certifications, sites, size, website) comes from get_company_profile, its own orders (order ids such as PO-2291, values, ship dates, statuses and each order's document checklist) from query_orders, and its playbook rules from get_playbook. Its stock items (query_inventory) are its own goods: the products its profile names and its orders ship, each with the ids of those orders; they have no quantities or stock values, so for money at stake use those orders' values from query_orders. Its news alerts (get_alerts) are AI readings of real news against those goods, not confirmed effects on an order. News articles are real, from approved sources.`;
}

const today = () => new Date().toISOString().slice(0, 10);

export function system(session) {
  return `You are the ExportMate assistant, an AI agent inside ExportMate, a trade-compliance workspace.
${workspace(session)} Today is ${today()}.

How to work:
${rulesFor(session)
  .map((r) => `- ${r.text}`)
  .join("\n")}${remembered(session)}`;
}

// Memory Bank's memories of this user (agent.js), fenced as data: they shape how to answer
// (language, detail, what the user works on), never what the facts are.
function remembered(session) {
  if (!session.memories?.length) return "";
  return `

What you remember about this user from earlier conversations (their preferences and working context; follow them unless the question says otherwise; they are not sources and are never cited or used as figures):
${session.memories.map((m) => `- ${asData(m)}`).join("\n")}`;
}

/** The analyst's prompt: the assistant's rules, plus how to work through a question with several parts. */
export function analystInstruction(session) {
  return `${system(session)}

How to work through a question with several parts:
- Call the tools the rules name yourself. When the question spans several tools, call them together in one step rather than one per step.
- Every total, sum, difference, average or percentage in your answer must be a figure a tool returned or the result of your own calculate call. Never add up figures in your head: call calculate with the exact figures first.
- Answer as soon as the tool results cover the question.`;
}
