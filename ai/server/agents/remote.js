// How the eval reaches the deployed agents (eval/run.js --engine): Agent Platform's
// reasoningEngines query API on the Agent Runtime instance AGENT_RUNTIME, with the caller's
// Google credentials. The website's chats reach them through the company backend
// (backend/app/core/agents.py).
import { GoogleAuth } from "google-auth-library";
import { runtime } from "./platform.js";

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

/** One class method on the Agent Runtime instance AGENT_RUNTIME; returns its output. */
export async function callRuntime(method, input) {
  if (!runtime) throw new Error("AGENT_RUNTIME is not set");
  const res = await fetch(`https://${runtime.location}-aiplatform.googleapis.com/v1/${runtime.name}:query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await auth.getAccessToken()}` },
    body: JSON.stringify({ class_method: method, input }),
  });
  if (!res.ok) throw new Error(`Agent Runtime answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).output;
}
