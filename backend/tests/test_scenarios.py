import re

import pytest
from conftest import add_member, import_orders, onboard
from test_trade_map import MAP_CSV, seed_company

from app.database.models import Role
from app.database.session import open_session
from app.seed_reference_data import seed_reference_data

URL = "/api/v1/trade-map/scenarios"


@pytest.fixture
def lan(client) -> dict:
    with open_session() as db:
        seed_reference_data(db)
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)
    return headers


def save(client, headers, **body) -> dict:
    response = client.post(URL, headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_save_a_route_with_a_note_changes_nothing_on_the_order(client, lan):
    before = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    saved = save(
        client, lan, orderId="PO-1", kind="route", target="sg", note="  Ask the forwarder.  "
    )
    assert (saved["orderId"], saved["kind"], saved["target"]) == ("PO-1", "route", "SG")
    assert saved["label"] == "Route via Singapore"
    assert saved["note"] == "Ask the forwarder."
    assert saved["comparison"]["kind"] == "route"
    assert saved["comparison"]["via"] == "SG"
    assert saved["createdBy"]["name"]

    # Saving the same what-if again updates it rather than adding another.
    again = save(client, lan, orderId="PO-1", kind="route", target="SG", note="Booked a call.")
    assert again["id"] == saved["id"]
    assert again["note"] == "Booked a call."

    save(client, lan, orderId="PO-1", kind="market", target="US")
    save(client, lan, orderId="PO-2", kind="ship_date", target="2027-02-01", note="")
    listed = client.get(f"{URL}?orderId=PO-1", headers=lan).json()["data"]
    assert [s["label"] for s in listed] == ["Market: United States", "Route via Singapore"]
    every = client.get(URL, headers=lan).json()["data"]
    assert {s["orderId"] for s in every} == {"PO-1", "PO-2"}
    assert next(s for s in every if s["orderId"] == "PO-2")["note"] is None

    after = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    assert after == before
    actions = [e["action"] for e in client.get("/api/v1/audit-events", headers=lan).json()["data"]]
    assert actions.count("scenario.saved") == 4


def test_edit_and_delete(client, lan):
    saved = save(client, lan, orderId="PO-1", kind="route", target="direct", note="First")
    assert saved["label"] == "Direct route"
    edited = client.patch(f"{URL}/{saved['id']}", headers=lan, json={"note": "Second"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["data"]["note"] == "Second"
    assert edited.json()["data"]["comparison"] == saved["comparison"]

    assert client.delete(f"{URL}/{saved['id']}", headers=lan).status_code == 200
    assert client.get(URL, headers=lan).json()["data"] == []
    assert client.delete(f"{URL}/{saved['id']}", headers=lan).status_code == 404


def test_save_checks_the_what_if_like_the_comparison(client, lan):
    def error(**body) -> tuple[int, str]:
        r = client.post(URL, headers=lan, json=body)
        return r.status_code, r.json()["error"]["code"]

    assert error(orderId="PO-1", kind="market", target="EU") == (422, "same_market")
    assert error(orderId="PO-1", kind="route", target="ZZ") == (422, "unknown_route")
    assert error(orderId="PO-1", kind="ship_date", target="next week") == (422, "invalid_input")
    assert error(orderId="PO-1", kind="ship_date", target="2026-10-27") == (422, "same_date")
    assert error(orderId="PO-404", kind="market", target="US") == (404, "not_found")


def test_viewers_read_and_other_companies_see_nothing(client, lan):
    saved = save(client, lan, orderId="PO-1", kind="market", target="US", note="Maybe")
    viewer = add_member(client, "lan@example.com", "minh@example.com", Role.viewer)
    assert [s["id"] for s in client.get(URL, headers=viewer).json()["data"]] == [saved["id"]]
    body = {"orderId": "PO-1", "kind": "market", "target": "GB"}
    assert client.post(URL, headers=viewer, json=body).status_code == 403
    assert client.post(f"{URL}/suggest", headers=viewer, json=body).status_code == 403
    assert client.delete(f"{URL}/{saved['id']}", headers=viewer).status_code == 403

    other = onboard(client, "mai@example.com", "Other Co.")
    assert client.get(URL, headers=other).json()["data"] == []
    assert client.get(f"{URL}?orderId=PO-1", headers=other).status_code == 404
    patch = client.patch(f"{URL}/{saved['id']}", headers=other, json={"note": "x"})
    assert patch.status_code == 404


def test_ai_suggestion_keeps_only_points_resting_on_the_comparison(client, lan, fake_gemini):
    fake_gemini.answers["scenario_note"] = lambda prompt, file: {
        "summary": "Shipping to the United States adds US paperwork; EU-only lines drop off.",
        "next_steps": [
            {"text": "Prepare the Lacey Act declaration.", "items": ["lacey act declaration"]},
            {"text": "Check formaldehyde test scope.", "items": ["Formaldehyde emission test"]},
            {"text": "Budget 12,500 USD for duties.", "items": ["Import duty"]},
            {"text": "Read https://example.com first.", "items": ["Import duty"]},
            {"text": "Call a broker.", "items": ["Something made up"]},
        ],
        "questions": [
            {"text": "Will the buyer accept the change?", "items": ["Buyer and contract terms"]},
        ],
    }
    body = {"orderId": "PO-1", "kind": "market", "target": "US"}
    response = client.post(f"{URL}/suggest", headers=lan, json=body)
    assert response.status_code == 200, response.text
    suggestion = response.json()["data"]
    assert [(p["text"], p["items"]) for p in suggestion["nextSteps"]] == [
        ("Prepare the Lacey Act declaration.", ["Lacey Act declaration"]),
        ("Check formaldehyde test scope.", ["Formaldehyde emission test"]),
    ]
    assert [p["items"] for p in suggestion["questions"]] == [["Buyer and contract terms"]]
    assert suggestion["note"].startswith("Shipping to the United States")
    assert "- Prepare the Lacey Act declaration." in suggestion["note"]
    assert "To ask:\n- Will the buyer accept the change?" in suggestion["note"]

    prompt = fake_gemini.calls[-1]["prompt"]
    assert "PO-1" in prompt and "Lacey Act declaration [New]" in prompt
    assert re.search(r"<data>.*</data>", prompt, re.DOTALL)
    # Nothing is saved by a suggestion.
    assert client.get(URL, headers=lan).json()["data"] == []


def test_ai_suggestion_with_a_bad_summary_is_refused(client, lan, fake_gemini):
    fake_gemini.answers["scenario_note"] = lambda prompt, file: {
        "summary": "Expect 417% higher costs.",
        "next_steps": [],
        "questions": [],
    }
    body = {"orderId": "PO-1", "kind": "route", "target": "SG"}
    response = client.post(f"{URL}/suggest", headers=lan, json=body)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "ai_unavailable"
