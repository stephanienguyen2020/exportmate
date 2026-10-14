// The assistant as an ADK multi-agent system, built per turn (prompts name the company, tools
// close over the turn's gateway):
//
//   exportmate_assistant   RoutedAgent: router.js picks the answering agent, no model call
//   ├─ quick_answer        simple tier; every read tool, for single lookups and how-tos
//   └─ analyst             complex tier; delegates to the specialists, does the arithmetic,
//      │                   writes the cited answer
//      ├─ stock_specialist      query_inventory, calculate
//      ├─ news_specialist       get_alerts, get_scan_status, search_knowledge
//      ├─ company_specialist    get_company_profile, query_orders (company workspaces only)
//      └─ knowledge_specialist  search_knowledge (help guides, the news archive)
//
// Specialists run on the simple tier as tools of the analyst (SpecialistTool). Every tool call
// by any agent goes through the gateway (`runTool`), so the refs, the evidence the auditor
// checks and the audit trail cover the whole team. `hooks` record each model call.
import { AgentTool, InMemorySessionService, LlmAgent, RoutedAgent, Runner } from "@google/adk";
import { gemini } from "./model.js";
import { GatewayTool } from "./tools.js";
import { analystInstruction, specialistInstruction, system } from "./instructions.js";

export const ROOT = "exportmate_assistant";
export const ANSWERING = { simple: "quick_answer", complex: "analyst" };

export const SPECIALISTS = [
  {
    name: "stock_specialist",
    tools: ["query_inventory", "calculate"],
    role: "you look up the workspace's stock items (SKUs, categories, markets, certifications, geolocation, suppliers, quantities and stock values).",
    description: "Stock lookups: items by SKU, category, market, HS code, species, origin, supplier, certification or geolocation status, with counts and stock values.",
  },
  {
    name: "news_specialist",
    tools: ["get_alerts", "get_scan_status", "search_knowledge"],
    role: "you find news alerts from the daily scans, the stock they expose, the scan's status and real news articles.",
    description: "News: alerts by topic, severity or SKU with the stock value exposed, the latest scan and source status, and news articles.",
  },
  {
    name: "company_specialist",
    tools: ["get_company_profile", "query_orders", "get_playbook"],
    role: "you look up the signed-in company's own profile, orders with their document checklists, and playbook rules.",
    description: "The company's own records: its profile, its orders (ids such as PO-2291, values, ship dates, statuses, document checklists) and playbook rules.",
  },
  {
    name: "knowledge_specialist",
    tools: ["search_knowledge"],
    role: "you search ExportMate's help guides and the news archive.",
    description: "How to use ExportMate (help guides) and background from the news archive.",
  },
];

// An AgentTool that runs its specialist in a session of its own (Agent Platform sessions take
// server-assigned ids, so the parent's id can't be reused) with the turn's plugins.
class SpecialistTool extends AgentTool {
  constructor(agent, { plugins, onReport }) {
    super({ agent });
    this.specialist = agent;
    this.plugins = plugins;
    this.onReport = onReport;
  }

  async runAsync({ args, toolContext }) {
    const started = Date.now();
    const agent = this.specialist;
    const sessionService = new InMemorySessionService();
    const runner = new Runner({ appName: agent.name, agent, sessionService, plugins: this.plugins });
    const userId = toolContext.invocationContext.userId;
    const session = await sessionService.createSession({ appName: agent.name, userId });
    const request = String(args?.request ?? "");
    let report = "";
    for await (const event of runner.runAsync({ userId, sessionId: session.id, newMessage: { role: "user", parts: [{ text: request }] }, abortSignal: toolContext.abortSignal })) {
      if (event.errorCode) {
        this.onReport({ agent: agent.name, request, error: event.errorMessage || event.errorCode, latencyMs: Date.now() - started });
        return { error: `${agent.name} could not answer: ${event.errorMessage || event.errorCode}` };
      }
      const text = (event.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      if (text && event.author === agent.name && !event.partial) report = text;
    }
    this.onReport({ agent: agent.name, request, report, latencyMs: Date.now() - started });
    return report || "Nothing found.";
  }
}

/**
 * The agent tree for one turn. `declarations` are the tools this turn may use (gateway scopes),
 * `runTool(name, args, agent)` runs one through the gateway, `plugins` go to every runner,
 * `hooks.before/after` wrap every model call, `onReport` records each specialist's report and
 * `routeTo()` returns "simple" or "complex" for the current message.
 */
export function buildAssistant({ company, declarations, runTool, plugins, hooks, onReport, routeTo }) {
  const available = new Map(declarations.map((d) => [d.name, d]));
  const toolsFor = (names) => names.filter((n) => available.has(n)).map((n) => new GatewayTool(available.get(n), runTool));
  const common = (tier) => ({
    model: gemini,
    // No transfers: the routed agent and the analyst decide who works, which also keeps ADK's
    // transfer preamble out of the versioned prompts.
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    generateContentConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    beforeModelCallback: ({ context, request }) => hooks.before({ context, request, tier }),
    afterModelCallback: ({ context, response }) => hooks.after({ context, response, tier }),
  });

  const team = SPECIALISTS.map((s) => ({ ...s, tools: s.tools.filter((n) => available.has(n)) })).filter((s) => s.tools.length);
  const specialists = team.map(
    (s) =>
      new LlmAgent({
        ...common("simple"),
        name: s.name,
        description: s.description,
        // Functions, not strings, so ADK doesn't read {braces} in the text as state placeholders.
        instruction: () => specialistInstruction(company, s),
        tools: toolsFor(s.tools),
      }),
  );
  const quick = new LlmAgent({
    ...common("simple"),
    name: ANSWERING.simple,
    description: "Answers single lookups and how-to questions directly with the read tools, with citations.",
    instruction: () => system(company),
    tools: toolsFor([...available.keys()]),
  });
  const analyst = new LlmAgent({
    ...common("complex"),
    name: ANSWERING.complex,
    description: "Answers questions that need several facts, arithmetic or judgement by delegating to specialists, with citations.",
    instruction: () => analystInstruction(company, team),
    tools: [...specialists.map((a) => new SpecialistTool(a, { plugins, onReport })), ...toolsFor(["calculate"])],
  });
  const root = new RoutedAgent({
    name: ROOT,
    description: "ExportMate's trade-compliance assistant.",
    agents: { [quick.name]: quick, [analyst.name]: analyst },
    router: () => ANSWERING[routeTo()],
  });

  // What each agent was given, for the audit and the Agent Platform eval (types.evals.AgentConfig).
  const config = (agent, type, instruction, tools, subAgents) => ({
    agent_id: agent.name,
    agent_type: type,
    description: agent.description,
    ...(instruction ? { instruction } : {}),
    ...(tools ? { tools: [{ function_declarations: tools }] } : {}),
    ...(subAgents ? { sub_agents: subAgents } : {}),
  });
  const declared = (names) => names.filter((n) => available.has(n)).map((n) => available.get(n));
  const agents = {
    [ROOT]: config(root, "RoutedAgent", null, null, [quick.name, analyst.name]),
    [quick.name]: config(quick, "LlmAgent", system(company), declared([...available.keys()])),
    [analyst.name]: config(
      analyst,
      "LlmAgent",
      analystInstruction(company, team),
      [...specialists.map((a) => ({ name: a.name, description: a.description })), ...declared(["calculate"])],
      specialists.map((a) => a.name),
    ),
    ...Object.fromEntries(specialists.map((a, n) => [a.name, config(a, "LlmAgent", specialistInstruction(company, team[n]), declared(team[n].tools))])),
  };
  return { root, agents };
}
