"""The assistant's Agent Runtime instance on Agent Platform: its Sessions and Memory Bank, and
(once deployed) the container that runs the ADK agents (runtime.js).

Usage (needs `gcloud auth application-default login`):
  uv run --project platform python platform/runtime.py create --name exportmate-agents-dev
      an instance with Sessions and Memory Bank only, for local development
  uv run --project platform python platform/runtime.py deploy --image <artifact registry uri> [--name exportmate-agents] [--gateway …]
      create or update the instance with the container image (runtime contract) and Agent Identity,
      optionally behind an egress Agent Gateway
  uv run --project platform python platform/runtime.py show [--name …]
  uv run --project platform python platform/runtime.py delete --name exportmate-agents-dev

Prints the resource name; the AI service reads it from AGENT_RUNTIME (agents use its id for
VertexAiSessionService and VertexAiMemoryBankService).

Memory Bank keeps per-user memories (scope {app_name, user_id}; agent.js only writes them for
signed-in company users): preferences, explicit instructions, the user's trade focus and how
they want answers. Never personal details (the managed USER_PERSONAL_INFO topic is left out).
"""

import argparse
import json
import os
import subprocess
import sys

import agentplatform
from agentplatform import types

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "exportmate-app")
LOCATION = os.environ.get("AGENT_LOCATION", "asia-southeast1")
MEMORY_MODEL = os.environ.get("MEMORY_MODEL", "gemini-3.5-flash")
MEMORY_TTL = f"{180 * 86400}s"

# The class methods runtime.js serves (runtime contract): api_mode "" is unary, "stream" streams NDJSON.
CLASS_METHODS = [
    {"name": "query", "api_mode": ""},
    {"name": "stream_query", "api_mode": "stream"},
    {"name": "scan", "api_mode": ""},
    {"name": "list_memories", "api_mode": ""},
    {"name": "delete_memory", "api_mode": ""},
]


def memory_bank():
    custom = lambda label, description: types.MemoryBankCustomizationConfigMemoryTopic(
        custom_memory_topic=types.MemoryBankCustomizationConfigMemoryTopicCustomMemoryTopic(label=label, description=description)
    )
    managed = lambda topic: types.MemoryBankCustomizationConfigMemoryTopic(
        managed_memory_topic=types.MemoryBankCustomizationConfigMemoryTopicManagedMemoryTopic(managed_topic_enum=topic)
    )
    return types.ReasoningEngineContextSpecMemoryBankConfig(
        customization_configs=[
            types.MemoryBankCustomizationConfig(
                memory_topics=[
                    managed(types.ManagedTopicEnum.USER_PREFERENCES),
                    managed(types.ManagedTopicEnum.EXPLICIT_INSTRUCTIONS),
                    custom(
                        "trade_focus",
                        "The markets, products, HS codes, suppliers, origins and trade rules the user works on or keeps asking about. "
                        "Not order values, prices, account details or anything about other people.",
                    ),
                    custom(
                        "answer_preferences",
                        "How the user wants answers: language, level of detail, currency or units, format.",
                    ),
                ]
            )
        ],
        generation_config=types.ReasoningEngineContextSpecMemoryBankConfigGenerationConfig(
            model=f"projects/{PROJECT}/locations/global/publishers/google/models/{MEMORY_MODEL}"
        ),
        ttl_config=types.ReasoningEngineContextSpecMemoryBankConfigTtlConfig(default_ttl=MEMORY_TTL),
    )


def find(client, name):
    for runtime in client.runtimes.list():
        resource = runtime.api_resource
        if resource.display_name == name:
            return runtime
    return None


def gateway_ca(gateway):
    """The root CA the gateway re-encrypts egress with (agentGatewayCard.rootCertificates)."""
    out = subprocess.run(["gcloud", "network-services", "agent-gateways", "describe", gateway, "--format=json"], capture_output=True, text=True, check=True).stdout
    return "\n".join(json.loads(out)["agentGatewayCard"]["rootCertificates"])


def config(name, image=None, resource=None, identity="agent", gateway=None):
    base = dict(
        display_name=name,
        description="ExportMate trade-compliance assistant (ADK, multi-agent)",
        context_spec=types.ReasoningEngineContextSpec(memory_bank_config=memory_bank()),
        labels={"app": "exportmate"},
    )
    if not image:
        return types.AgentRuntimeConfig(**base)
    # GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are set by Agent Runtime (reserved names).
    env = {k: v for k, v in os.environ.items() if k.startswith(("GEMINI_", "RAG_", "BACKEND_URL", "MODEL_ARMOR_", "SCAN_SCHEDULE"))}
    return types.AgentRuntimeConfig(
        **base,
        container_spec=types.ReasoningEngineSpecContainerSpec(image_uri=image, port=8080),
        class_methods=CLASS_METHODS,
        # The agent runs as its own Agent Identity (no service-account keys); IAM and Agent Gateway
        # policies are granted to it by infra/agent-platform/govern.sh.
        **({"identity_type": types.IdentityType.AGENT_IDENTITY} if identity == "agent" else {}),
        # SERVE picks runtime.js (main.js); AGENT_RUNTIME is the instance's own name, which its
        # Sessions and Memory Bank use (a new instance gets it on the update that follows).
        env_vars={"SERVE": "runtime", "PROJECT_ID": PROJECT, "GEMINI_LOCATION": "global", **({"AGENT_GATEWAY_CA": gateway_ca(gateway)} if gateway else {}), **({"AGENT_RUNTIME": resource} if resource else {}), **env},
        # Behind Agent Gateway (Govern): all egress goes through it, allowed per registered endpoint.
        **(
            {
                "agent_gateway_config": types.ReasoningEngineSpecDeploymentSpecAgentGatewayConfig(
                    agent_to_anywhere_config=types.ReasoningEngineSpecDeploymentSpecAgentGatewayConfigAgentToAnywhereConfig(agent_gateway=gateway)
                )
            }
            if gateway
            else {}
        ),
        min_instances=int(os.environ.get("AGENT_MIN_INSTANCES", "1")),
        max_instances=int(os.environ.get("AGENT_MAX_INSTANCES", "3")),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["create", "deploy", "show", "delete"])
    parser.add_argument("--name", default="exportmate-agents")
    parser.add_argument("--image")
    parser.add_argument("--gateway", help="projects/…/locations/…/agentGateways/… (egress Agent Gateway, infra/agent-platform/govern.sh)")
    parser.add_argument("--identity", choices=["agent", "default"], default="agent", help="agent: its own Agent Identity; default: the Agent Platform service agent")
    args = parser.parse_args()
    client = agentplatform.Client(project=PROJECT, location=LOCATION)
    existing = find(client, args.name)

    if args.command == "show":
        print(existing.api_resource.name if existing else f"No runtime named {args.name} in {PROJECT}/{LOCATION}")
    elif args.command == "delete":
        if not existing:
            sys.exit(f"No runtime named {args.name}")
        client.runtimes.delete(name=existing.api_resource.name, force=True)
        print(f"Deleted {existing.api_resource.name}")
    elif args.command == "create":
        runtime = existing or client.runtimes.create(config=config(args.name))
        print(runtime.api_resource.name)
    else:
        if not args.image:
            sys.exit("deploy needs --image")
        if not existing:
            existing = client.runtimes.create(config=config(args.name, args.image, identity=args.identity, gateway=args.gateway))
        runtime = client.runtimes.update(name=existing.api_resource.name, config=config(args.name, args.image, existing.api_resource.name, args.identity, args.gateway))
        print(runtime.api_resource.name)


if __name__ == "__main__":
    main()
