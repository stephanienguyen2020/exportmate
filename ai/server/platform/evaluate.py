"""Creates an evaluation run on Agent Platform (Gen AI evaluation) for one golden-set run, so its
results appear in the Google Cloud console under Agent Platform > Evaluation, in the evaluation
experiment "ExportMate assistant" where runs can be compared.

Input: the JSON that `npm run eval:vertex` writes to eval/results/<session>.vertex.json. Each case
is agent data (types.evals.AgentData): the instruction and tool declarations the model was given,
earlier turns, every function call and response, the auditor's send-back and the final answer.
Usage:  uv run --project platform python platform/evaluate.py eval/results/<session>.vertex.json

Managed, Gemini-judged metrics with adaptive rubrics: final response quality, tool use quality,
hallucination (claims not supported by the tool results) and safety. The runner's own checks
(eval/score.js: expected tools and arguments, figures, declines) stay in Firestore `eval_runs`.

Results are written to Cloud Storage (EVAL_GCS_DEST, default the project's Agent Platform staging
bucket in EVAL_LOCATION). The evaluation service isn't offered in asia-southeast1, so it runs in
EVAL_LOCATION (default us-central1); only the eval data goes there.
"""

import json
import os
import sys
import time
from pathlib import Path

import agentplatform
import pandas as pd
from agentplatform import types
from google.cloud import storage

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "skilful-scarab-511320-q9")
LOCATION = os.environ.get("EVAL_LOCATION", "us-central1")
EXPERIMENT = os.environ.get("EVAL_EXPERIMENT", "ExportMate assistant")
METRICS = [
    types.RubricMetric.FINAL_RESPONSE_QUALITY,
    types.RubricMetric.TOOL_USE_QUALITY,
    types.RubricMetric.HALLUCINATION,
    types.RubricMetric.SAFETY,
]
CONSOLE = f"https://console.cloud.google.com/agent-platform/evaluation?project={PROJECT}"


def results_bucket():
    """EVAL_GCS_DEST, or the Agent Platform staging bucket (cloud-ai-platform-*) in LOCATION."""
    if os.environ.get("EVAL_GCS_DEST"):
        return os.environ["EVAL_GCS_DEST"].rstrip("/")
    for bucket in storage.Client(project=PROJECT).list_buckets(prefix="cloud-ai-platform-"):
        if bucket.location.lower() == LOCATION.lower():
            return f"gs://{bucket.name}"
    sys.exit(f"No Agent Platform staging bucket in {LOCATION}; set EVAL_GCS_DEST=gs://<bucket>/<prefix>")


def experiment(client):
    """The evaluation experiment every golden-set run belongs to, created on first use."""
    for existing in client.evals.list_evaluation_experiments().evaluation_experiments or []:
        if existing.display_name == EXPERIMENT:
            return existing.name
    return client.evals.create_evaluation_experiment(display_name=EXPERIMENT, labels={"app": "exportmate"}).name


def wait(client, name):
    while True:
        run = client.evals.get_evaluation_run(name=name)
        state = str(run.state)
        if any(s in state for s in ("SUCCEEDED", "FAILED", "CANCELLED")):
            return client.evals.get_evaluation_run(name=name, include_evaluation_items=True)
        print(f"  {state.split('.')[-1].lower()}…", flush=True)
        time.sleep(20)


def main(path):
    data = json.loads(Path(path).read_text())
    run_info = data["run"]
    cases = pd.DataFrame(data["cases"])
    client = agentplatform.Client(project=PROJECT, location=LOCATION)
    session = run_info["sessionId"]

    run = client.evals.create_evaluation_run(
        dataset=types.EvaluationDataset(eval_dataset_df=cases[["prompt", "agent_data"]]),
        dest=f"{results_bucket()}/exportmate-evals/{session}",
        metrics=METRICS,
        display_name=f"{session} · {run_info['tier']} · policy {run_info['policyVersion']}",
        evaluation_experiment=experiment(client),
        labels={"app": "exportmate", "session": session, "tier": run_info["tier"], "policy": run_info["policyVersion"]},
    )
    print(f"Evaluation run {run.name} ({len(cases)} cases); waiting for the judges…", flush=True)
    run = wait(client, run.name)
    if run.error:
        sys.exit(f"Evaluation run failed: {run.error}")

    print(f"\nGolden checks: {int(cases['golden_pass'].sum())}/{len(cases)} passed (Firestore eval_runs/{run_info['firestoreRun']})")
    summary = getattr(run.evaluation_run_results, "summary_metrics", None) if run.evaluation_run_results else None
    if summary:
        print("Agent Platform metrics (average, 0-1):")
        for key, value in sorted((summary.metrics or {}).items()):
            if key.endswith("/AVERAGE"):
                print(f"  {key.split('/')[-2]:28} {value:.2f}")
    print(f"\nOpen it in the console: Agent Platform > Evaluation > {EXPERIMENT}\n{CONSOLE}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
