from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard

from app.database.models import Role
from app.database.queries import hs_codes as hs_queries
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_hs_headings, seed_reference_data

SHIP = (datetime.now(UTC).date() + timedelta(days=60)).isoformat()
# PO-1 has a code; PO-2 has a similar product name and no code; PO-3 is a new kind of product.
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Wooden kitchen furniture set,An Cuong Wood,"Long Beach, US",54300,{SHIP},9403.40\n'
    f'PO-2,Wooden kitchen furniture set (white),An Cuong Wood,"Long Beach, US",20000,{SHIP},\n'
    f'PO-3,Upholstered armchair with wooden frame,An Cuong Wood,"Lyon, FR",9000,{SHIP},\n'
)


@pytest.fixture
def lan(client, fake_gemini) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        seed_hs_headings(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    fake_gemini.calls.clear()
    return headers


def candidates(prompt: str, kind: str) -> list[str]:
    return [
        line.split("|")[0][2:].strip()
        for line in prompt.splitlines()
        if line.startswith(f"- {kind}:")
    ]


def test_seed_embeds_each_heading_once(lan, fake_gemini):
    with open_session() as db:
        total, embedded = hs_queries.count_hs_headings(db)
        assert total == embedded > 2000
        fake_gemini.embedded.clear()
        assert seed_hs_headings(db)["hs_embedded_now"] == 0
    assert fake_gemini.embedded == []


def test_suggestions_come_from_past_orders_and_the_closest_tariff_lines(client, lan, fake_gemini):
    fake_gemini.answers["hs_code_suggestion"] = lambda prompt, file: {
        "codes": [
            {
                "hs_code": "9403.40",
                "reason": "Same product as PO-1: wooden kitchen furniture.",
                "based_on": ["order:PO-1", "heading:9403.40", "order:PO-404"],
            },
            {"hs_code": "9999.99", "reason": "Made up.", "based_on": []},
            {"hs_code": "furniture", "reason": "Not a code.", "based_on": []},
        ]
    }
    response = client.post("/api/v1/orders/PO-2/hs-suggestions", headers=lan)
    assert response.status_code == 201, response.text
    (suggestion,) = response.json()["data"]
    assert suggestion["hsCode"] == "9403.40"
    assert suggestion["description"].endswith("Wooden furniture of a kind used in the kitchen")
    # Refs the AI wasn't shown are dropped.
    assert [(b["type"], b["ref"]) for b in suggestion["basedOn"]] == [
        ("order", "PO-1"),
        ("heading", "9403.40"),
    ]
    prompt = fake_gemini.calls[-1]["prompt"]
    assert candidates(prompt, "order") == ["order:PO-1"]
    assert "heading:9403.40" in candidates(prompt, "heading")
    assert "<product>Wooden kitchen furniture set (white)</product>" in prompt


def test_a_new_product_finds_its_tariff_line_by_meaning(client, lan, fake_gemini):
    fake_gemini.answers["hs_code_suggestion"] = lambda prompt, file: {"codes": []}
    client.post("/api/v1/orders/PO-3/hs-suggestions", headers=lan)
    prompt = fake_gemini.calls[-1]["prompt"]
    assert candidates(prompt, "order") == []  # no similar past order
    assert "heading:9401.61" in candidates(prompt, "heading")  # upholstered, wooden frames

    fake_gemini.embeddings_fail = True  # falls back to shared words
    client.post("/api/v1/orders/PO-3/hs-suggestions", headers=lan)
    assert "heading:9401.61" in candidates(fake_gemini.calls[-1]["prompt"], "heading")


def test_accepting_a_suggestion_sets_the_code_and_reanalyses_the_order(client, lan, fake_gemini):
    fake_gemini.answers["hs_code_suggestion"] = lambda prompt, file: {
        "codes": [
            {"hs_code": "9403.40", "reason": "Like PO-1.", "based_on": ["order:PO-1"]},
            {"hs_code": "9403.60", "reason": "Other wooden furniture.", "based_on": []},
        ]
    }
    assert client.post("/api/v1/orders/PO-1/hs-suggestions", headers=lan).status_code == 409
    codes = client.post("/api/v1/orders/PO-2/hs-suggestions", headers=lan).json()["data"]

    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    accept = f"/api/v1/hs-suggestions/{codes[0]['id']}/accept"
    assert client.post(accept, headers=viewer).status_code == 403
    accepted = client.post(accept, headers=lan)
    assert accepted.status_code == 200, accepted.text
    data = accepted.json()["data"]
    assert data["order"]["hsCode"] == "9403.40"
    assert data["run"]["orderCount"] == 1
    assert data["run"]["reports"][0]["missingData"] == []

    path = "/api/v1/orders/PO-2/hs-suggestions"
    decided = {c["hsCode"]: c["status"] for c in client.get(path, headers=lan).json()["data"]}
    assert decided == {"9403.40": "accepted", "9403.60": "rejected"}
    assert client.post(accept, headers=lan).status_code == 409
    other = onboard(client, "mai@example.com", company="Other Co")
    assert client.get(path, headers=other).status_code == 404


def test_orders_without_a_code_need_action_to_add_it(client, lan):
    run = client.post("/api/v1/runs", headers=lan, json={"orderIds": ["PO-3"]}).json()["data"]
    report = client.get(f"/api/v1/reports/{run['reports'][0]['id']}", headers=lan).json()["data"]
    assert report["orderStatus"] == "exposed"
    assert report["missingData"][0].startswith("Add the HS code, or ask for a suggested one")
