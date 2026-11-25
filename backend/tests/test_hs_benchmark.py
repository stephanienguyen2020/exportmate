import pytest

from app import hs_benchmark
from app.core.errors import AppError
from app.database.session import open_session
from app.seed_reference_data import seed_hs_headings

DATASET = {
    "source": "HMRC Advance Tariff Rulings",
    "sourceUrl": "https://example.test/search",
    "licence": "Open Government Licence v3.0",
    "licenceUrl": "https://example.test/ogl",
    "downloadedOn": "2026-11-25",
    "rulingsListed": 6000,
    "rulingsInTariff": 5900,
    "cases": [
        {
            "ref": "1",
            "description": "Wooden furniture of a kind used in the kitchen",
            "hsCode": "9403.40",
        },
        {"ref": "2", "description": "Roasted coffee beans, not decaffeinated", "hsCode": "0901.21"},
        {"ref": "3", "description": "Plywood of tropical wood, sheets 18 mm", "hsCode": "4412.31"},
    ],
}


@pytest.fixture
def tariff(fake_gemini, monkeypatch):
    with open_session() as db:
        seed_hs_headings(db)
    monkeypatch.setattr(hs_benchmark, "load_seed_file", lambda name: DATASET)
    fake_gemini.calls.clear()


def answer_by_product(codes: dict[str, list[str]]):
    """A fake Gemini that answers each product with the given codes."""

    def answer(prompt, file):
        product = prompt.split("<product>")[1].split("</product>")[0]
        if product not in codes:
            raise AppError(503, "ai_unavailable", "The AI step failed.")
        return {
            "codes": [{"hs_code": c, "reason": "Fits.", "based_on": []} for c in codes[product]]
        }

    return answer


def test_wilson_interval():
    assert hs_benchmark.wilson(0, 0)["rate"] is None
    zero = hs_benchmark.wilson(0, 10)
    assert (zero["rate"], zero["low"], zero["high"]) == (0.0, 0.0, 0.2775)
    most = hs_benchmark.wilson(361, 400)
    assert most["rate"] == 0.9025 and most["low"] < 0.9025 < most["high"]
    assert round(most["high"] - most["low"], 3) == 0.058


def test_run_scores_the_suggestion_path_and_is_served(client, tariff, fake_gemini):
    fake_gemini.answers["hs_code_suggestion"] = answer_by_product(
        {
            DATASET["cases"][0]["description"]: ["9403.40", "9403.60"],  # right first
            DATASET["cases"][1]["description"]: ["0901.22", "0901.21"],  # right second
            # case 3: the AI call fails, and counts as wrong
        }
    )
    run = hs_benchmark.run_benchmark(workers=1)
    assert run.case_count == 3
    assert run.metrics["top1"]["right"] == 1
    assert run.metrics["top3"]["right"] == 2
    assert run.metrics["heading"]["right"] == 2  # 0901.22 is in heading 0901
    assert run.metrics["errors"] == 1
    # Every case went through the real prompt, as a company with no past orders.
    assert len(fake_gemini.calls) == 3
    assert all("(none similar)" in c["prompt"] for c in fake_gemini.calls)
    by_ref = {r["ref"]: r for r in run.results}
    assert by_ref["1"]["retrieved"] is True  # the tariff search showed 9403.40
    assert by_ref["3"]["error"] == "ai_unavailable"

    response = client.get("/api/v1/benchmarks/hs-codes")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["caseCount"] == 3
    assert data["dataset"]["licence"] == "Open Government Licence v3.0"
    assert data["metrics"]["top1"]["rate"] == round(1 / 3, 4)
    assert "results" not in data


def test_smoke_runs_are_not_served(client, tariff, fake_gemini):
    fake_gemini.answers["hs_code_suggestion"] = answer_by_product({})
    assert client.get("/api/v1/benchmarks/hs-codes").status_code == 404
    hs_benchmark.run_benchmark(limit=1, workers=1)
    assert client.get("/api/v1/benchmarks/hs-codes").status_code == 404
