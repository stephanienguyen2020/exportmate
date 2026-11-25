// The assistant as an ADK multi-agent system, built per turn (prompts name the company, tools
// close over the turn's gateway):
//
//   exportmate_assistant   RoutedAgent: router.js picks the answering agent, no model call
//   ├─ quick_answer        "simple" questions: single lookups and how-tos
//   └─ analyst             "complex" questions: several facts, arithmetic, judgement, connections
//
// Both have every read tool the turn allows and call them themselves; both use the one assistant
// model (models.js). Until 23 Nov 2026 the analyst delegated to five specialist agents instead;
// that layer took 62% of the exam's time (each specialist made its own model calls, one after
// another), so it was removed. Every tool call goes through the gateway (`runTool`), so the refs,
// the evidence the auditor checks and the audit trail cover every call. `hooks` record each model
// call.
import { LlmAgent, RoutedAgent } from "@google/adk";
import { gemini } from "./model.js";
import { GatewayTool } from "./tools.js";
import { analystInstruction, system } from "./instructions.js";

export const ROOT = "exportmate_assistant";
export const ANSWERING = { simple: "quick_answer", complex: "analyst" };

/**
 * The agent tree for one turn. `session` is { company, orders, playbook } (agent.js), `declarations` are the tools this turn may use (gateway scopes),
 * `runTool(name, args, agent)` runs one through the gateway, `hooks.before/after` wrap every
 * model call and `routeTo()` returns "simple" or "complex" for the current message.
 */
export function buildAssistant({ session, declarations, runTool, hooks, routeTo }) {
  const available = new Map(declarations.map((d) => [d.name, d]));
  const toolsFor = (names) => names.filter((n) => available.has(n)).map((n) => new GatewayTool(available.get(n), runTool));
  const common = () => ({
    model: gemini,
    // No transfers: the routed agent and the analyst decide who works, which also keeps ADK's
    // transfer preamble out of the versioned prompts.
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    generateContentConfig: { maxOutputTokens: 4096 },
    beforeModelCallback: ({ context, request }) => hooks.before({ context, request }),
    afterModelCallback: ({ context, response }) => hooks.after({ context, response }),
  });

  const quick = new LlmAgent({
    ...common(),
    name: ANSWERING.simple,
    description: "Answers single lookups and how-to questions directly with the read tools, with citations.",
    instruction: () => system(session),
    tools: toolsFor([...available.keys()]),
  });
  const analyst = new LlmAgent({
    ...common(),
    name: ANSWERING.complex,
    description: "Answers questions that need several facts, arithmetic or judgement with the read tools, with citations.",
    instruction: () => analystInstruction(session),
    tools: toolsFor([...available.keys()]),
  });
  const root = new RoutedAgent({
    name: ROOT,
    description: "ExportMate's trade-compliance assistant.",
    agents: { [quick.name]: quick, [analyst.name]: analyst },
    router: () => ANSWERING[routeTo()],
  });

  // What each agent was given, for the audit and the Agent Platform eval (types.evals.AgentConfig).
  const config = (agent, type, instruction, tools) => ({
    agent_id: agent.name,
    agent_type: type,
    description: agent.description,
    ...(instruction ? { instruction } : {}),
    ...(tools ? { tools: [{ function_declarations: tools }] } : {}),
  });
  const declared = (names) => names.filter((n) => available.has(n)).map((n) => available.get(n));
  const agents = {
    [ROOT]: { ...config(root, "RoutedAgent", null, null), sub_agents: [quick.name, analyst.name] },
    [quick.name]: config(quick, "LlmAgent", system(session), declared([...available.keys()])),
    [analyst.name]: config(analyst, "LlmAgent", analystInstruction(session), declared([...available.keys()])),
  };
  return { root, agents };
}
