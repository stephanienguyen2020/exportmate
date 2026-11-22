import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWERING, buildAssistant } from "../agents/assistant.js";

// The tier each agent's model calls are made on, as the hooks see it (agent.js turns the tier into
// a model with TIERS[tier].model).
function tiersSeen(route) {
  const seen = {};
  const hooks = { before: ({ context, tier }) => void (seen[context.agentName] = tier), after: () => undefined };
  const { root } = buildAssistant({
    session: { company: null, orders: [], playbook: [] },
    declarations: [{ name: "search_knowledge", description: "search", parameters: { type: "OBJECT", properties: {} } }],
    runTool: async () => ({ output: {} }),
    plugins: [],
    hooks,
    onReport: () => {},
    routeTo: () => route,
  });
  const agents = Object.fromEntries(root.subAgents.map((a) => [a.name, a]));
  for (const name of [ANSWERING.simple, ANSWERING.complex]) agents[name].beforeModelCallback({ context: { agentName: name }, request: {} });
  return seen;
}

test("the analyst calls the model of the turn's tier: mid-size by default, the biggest only for heavy turns", () => {
  assert.equal(tiersSeen("standard")[ANSWERING.complex], "standard");
  assert.equal(tiersSeen("complex")[ANSWERING.complex], "complex");
  // A simple turn reaches the analyst only when the auditor sends the draft back: never on the small model.
  assert.equal(tiersSeen("simple")[ANSWERING.complex], "standard");
  assert.equal(tiersSeen("complex")[ANSWERING.simple], "simple");
});
