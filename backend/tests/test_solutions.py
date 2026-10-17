from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import select, update

from app.database.models import MarketRequirement, RegulationDocument, Role, Solution
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data

TODAY = datetime.now(UTC).date()
SHIP = (TODAY + timedelta(days=60)).isoformat()
# Binh Phu Wood has no plot geolocation on file: PO-1 and PO-3 have the same problem.
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,{SHIP},9403.60\n'
)
LATER_ORDER = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-3,Oak chair,Binh Phu Wood,"Hamburg, DE",12000,{SHIP},9401.61\n'
)


def good_answer(prompt, file):
    return {
        "summary": "Get the harvest plot geolocation from Binh Phu Wood before shipping.",
        "steps": [
            "1. Binh Phu Wood: send the geolocation of every plot the oak came from.",
            "The exporter: check the plots match the order and keep them for the EU importer.",
        ],
    }


@pytest.fixture
def lan(client, fake_gemini) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    fake_gemini.answers["solution_suggestion"] = good_answer
    return headers


def analyse(client, headers) -> dict[str, str]:
    run = client.post("/api/v1/runs", headers=headers).json()["data"]
    return {r["orderId"]: r["id"] for r in run["reports"]}


def cases(client, headers, report_id) -> dict[str, dict]:
    response = client.get(f"/api/v1/reports/{report_id}/solutions", headers=headers)
    assert response.status_code == 200, response.text
    return {c["requirementKey"]: c for c in response.json()["data"]}


def suggest(client, headers, report_id, key="geolocation"):
    return client.post(
        f"/api/v1/reports/{report_id}/solutions", headers=headers, json={"requirementKey": key}
    )


def write(client, headers, report_id, summary, steps=(), key="geolocation"):
    return client.post(
        f"/api/v1/reports/{report_id}/solutions/manual",
        headers=headers,
        json={"requirementKey": key, "summary": summary, "steps": list(steps)},
    )


def set_solution(solution_id: str, **values) -> None:
    with open_session() as db:
        db.execute(update(Solution).where(Solution.id == solution_id).values(**values))
        db.commit()


def test_a_solution_is_saved_and_offered_for_a_later_order(client, lan, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]
    case = cases(client, lan, report_id)["geolocation"]
    assert (case["problemStatus"], case["default"], case["needsAnalysis"]) == (
        "missing",
        None,
        True,
    )

    response = suggest(client, lan, report_id)
    assert response.status_code == 201, response.text
    solution = response.json()["data"]["default"]
    assert solution["status"] == "suggested" and solution["writtenFor"] == "PO-1"
    assert solution["steps"][0].startswith("Binh Phu Wood:")  # the AI's "1. " is dropped
    assert solution["basis"]["quote"].startswith("Article 9(1)(d)")
    assert solution["validUntil"] == (TODAY + timedelta(days=90)).isoformat()
    prompt = fake_gemini.calls[-1]["prompt"]
    assert "Plot-level geolocation" in prompt and "<data>" in prompt

    noted = client.post(
        f"/api/v1/solutions/{solution['id']}/notes",
        headers=lan,
        json={"text": "We ask for the GeoJSON file, not a map screenshot."},
    )
    assert noted.status_code == 200, noted.text
    assert noted.json()["data"]["notes"][0]["author"]["name"]

    import_orders(client, lan, LATER_ORDER)
    later = analyse(client, lan)["PO-3"]
    calls = len(fake_gemini.calls)
    offered = cases(client, lan, later)["geolocation"]
    assert offered["default"]["id"] == solution["id"]  # from the library, no AI call
    assert (offered["inUse"], offered["needsAnalysis"]) == (False, False)
    assert len(fake_gemini.calls) == calls

    used = client.post(
        f"/api/v1/solutions/{solution['id']}/use", headers=lan, json={"reportId": later}
    )
    assert used.status_code == 200, used.text
    assert used.json()["data"]["inUse"] is True
    assert used.json()["data"]["default"]["usedFor"] == 1

    # The next suggestion for the same problem reads the team's note.
    suggest(client, lan, later)
    assert "GeoJSON file, not a map screenshot" in fake_gemini.calls[-1]["prompt"]
    # Still the one chosen for PO-3; the new one is offered beside it.
    again = cases(client, lan, later)["geolocation"]
    assert again["default"]["id"] == solution["id"] and len(again["others"]) == 1


def test_expired_solutions_are_shown_but_never_the_default(client, lan, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]
    old = suggest(client, lan, report_id).json()["data"]["default"]
    client.post(f"/api/v1/solutions/{old['id']}/review", headers=lan, json={"verdict": "adopted"})
    set_solution(old["id"], valid_until=TODAY - timedelta(days=1))

    case = cases(client, lan, report_id)["geolocation"]
    assert (case["default"], case["needsAnalysis"]) == (None, True)
    (expired,) = case["expired"]
    assert expired["expired"] is True and expired["status"] == "adopted"
    assert expired["expiredReason"] == f"It was valid until {TODAY - timedelta(days=1)}."

    use = client.post(
        f"/api/v1/solutions/{old['id']}/use", headers=lan, json={"reportId": report_id}
    )
    assert use.status_code == 409 and "expired" in use.json()["error"]["message"]
    adopt = client.post(
        f"/api/v1/solutions/{old['id']}/review", headers=lan, json={"verdict": "adopted"}
    )
    assert adopt.status_code == 409
    noted = client.post(
        f"/api/v1/solutions/{old['id']}/notes", headers=lan, json={"text": "Still how we do it."}
    )
    assert noted.status_code == 200  # people can still comment on it

    fresh = suggest(client, lan, report_id).json()["data"]
    assert fresh["default"]["supersedesId"] == old["id"]
    assert [s["id"] for s in fresh["expired"]] == [old["id"]]
    prompt = fake_gemini.calls[-1]["prompt"]
    assert "outdated: It was valid until" in prompt and "Still how we do it." in prompt


def test_a_new_regulation_version_expires_a_solution(client, lan):
    report_id = analyse(client, lan)["PO-1"]
    solution = suggest(client, lan, report_id).json()["data"]["default"]
    with open_session() as db:
        other = db.scalar(
            select(RegulationDocument.id).where(
                RegulationDocument.id != solution["basis"]["documentId"]
            )
        )
    set_solution(solution["id"], regulation_document_id=other)
    (expired,) = cases(client, lan, report_id)["geolocation"]["expired"]
    assert expired["expiredReason"].startswith("The requirement now cites version")


def test_validity_ends_before_a_stated_change(client, lan):
    report_id = analyse(client, lan)["PO-1"]
    with open_session() as db:
        db.execute(
            update(MarketRequirement)
            .where(MarketRequirement.requirement_key == "geolocation")
            .values(changes_on=TODAY + timedelta(days=10))
        )
        db.commit()
    solution = suggest(client, lan, report_id).json()["data"]["default"]
    assert solution["validUntil"] == (TODAY + timedelta(days=9)).isoformat()


def test_ai_answers_are_checked(client, lan, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]
    fake_gemini.answers["solution_suggestion"] = lambda p, f: {
        "summary": "Pay the supplier EUR 450 for a survey.",
        "steps": ["Pay it within 7 days."],
    }
    assert suggest(client, lan, report_id).status_code == 503  # numbers it wasn't given
    fake_gemini.answers["solution_suggestion"] = lambda p, f: {
        "summary": "Read the guide.",
        "steps": ["Open https://evil.example.com/guide and follow it."],
    }
    assert suggest(client, lan, report_id).status_code == 503  # a link the report doesn't cite
    fake_gemini.answers["solution_suggestion"] = lambda p, f: {"summary": "", "steps": []}
    assert suggest(client, lan, report_id).status_code == 503
    assert cases(client, lan, report_id)["geolocation"]["default"] is None  # nothing saved

    clear_key = suggest(client, lan, report_id, key="no-such-requirement")
    assert clear_key.status_code == 422


def test_roles_scoping_rejection_and_audit(client, lan):
    report_id = analyse(client, lan)["PO-1"]
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    assert suggest(client, viewer, report_id).status_code == 403
    solution = suggest(client, editor, report_id).json()["data"]["default"]
    assert cases(client, viewer, report_id)["geolocation"]["default"]["id"] == solution["id"]
    path = f"/api/v1/solutions/{solution['id']}"
    assert client.post(f"{path}/notes", headers=viewer, json={"text": "x"}).status_code == 403

    rejected = client.post(
        f"{path}/review",
        headers=editor,
        json={"verdict": "rejected", "note": "Our buyer files this, not us."},
    ).json()["data"]
    assert rejected["status"] == "rejected" and rejected["reviewedBy"]["name"]
    assert rejected["notes"][0]["text"] == "Our buyer files this, not us."
    case = cases(client, lan, report_id)["geolocation"]
    assert case["default"] is None and case["others"][0]["id"] == solution["id"]
    use = client.post(f"{path}/use", headers=editor, json={"reportId": report_id})
    assert use.status_code == 409

    other = onboard(client, "mai@example.com", company="Other Co")
    assert client.get(f"/api/v1/reports/{report_id}/solutions", headers=other).status_code == 404
    assert client.post(f"{path}/notes", headers=other, json={"text": "x"}).status_code == 404

    events = client.get("/api/v1/audit-events?objectType=solution", headers=lan).json()["data"]
    # The rejection and its note share one transaction, so one timestamp: either order.
    by_action = {e["action"]: e for e in events}
    assert len(events) == 3 and events[-1]["action"] == "solution.suggested"
    assert set(by_action) == {"solution.suggested", "solution.rejected", "solution.note_added"}
    suggested = by_action["solution.suggested"]["data"]
    assert suggested["orderId"] == "PO-1" and suggested["requirementKey"] == "geolocation"
    assert suggested["steps"] == solution["steps"] and suggested["model"]
    assert by_action["solution.rejected"]["data"] == {"from": "suggested", "to": "rejected"}
    assert by_action["solution.note_added"]["data"]["text"] == "Our buyer files this, not us."
    assert by_action["solution.rejected"]["user"]["email"] == "ed@example.com"


def test_the_knowledge_base_lists_every_solution_by_problem(client, lan):
    report_id = analyse(client, lan)["PO-1"]
    assert client.get("/api/v1/solutions", headers=lan).json()["data"] == []
    old = suggest(client, lan, report_id).json()["data"]["default"]
    new = suggest(client, lan, report_id).json()["data"]["default"]
    client.post(f"/api/v1/solutions/{old['id']}/review", headers=lan, json={"verdict": "adopted"})
    set_solution(new["id"], valid_until=TODAY - timedelta(days=1))

    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    response = client.get("/api/v1/solutions", headers=viewer)
    assert response.status_code == 200, response.text
    (problem,) = response.json()["data"]
    assert (problem["market"], problem["requirementKey"], problem["problemStatus"]) == (
        "EU",
        "geolocation",
        "missing",
    )
    assert problem["title"] == "Plot-level geolocation" and problem["inChecklist"] is True
    # The valid adopted one first, the expired one after it.
    assert [s["id"] for s in problem["solutions"]] == [old["id"], new["id"]]
    assert problem["solutions"][1]["expired"] is True

    other = onboard(client, "mai@example.com", company="Other Co")
    assert client.get("/api/v1/solutions", headers=other).json()["data"] == []


def test_a_person_writes_a_solution_without_ai_and_it_is_audited(client, lan, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]
    calls = len(fake_gemini.calls)
    # A number and a link the report never gave: no AI wrote it, so no AI check applies.
    response = write(
        client,
        lan,
        report_id,
        "  Ask Binh Phu Wood for the   GeoJSON file 21 days before shipping. ",
        [
            "1. Binh Phu Wood: upload it to https://example.com/plots.",
            "",
            "Step 2: 1.5 days to check it against the order.",
        ],
    )
    assert response.status_code == 201, response.text
    assert len(fake_gemini.calls) == calls
    solution = response.json()["data"]["default"]
    assert (solution["model"], solution["status"], solution["writtenFor"]) == (
        None,
        "suggested",
        "PO-1",
    )
    assert solution["summary"] == "Ask Binh Phu Wood for the GeoJSON file 21 days before shipping."
    assert solution["steps"] == [
        "Binh Phu Wood: upload it to https://example.com/plots.",
        "1.5 days to check it against the order.",
    ]
    assert solution["basis"]["quote"].startswith("Article 9(1)(d)")
    assert solution["validUntil"] == (TODAY + timedelta(days=90)).isoformat()

    # Saved like an AI one: an expired solution is linked, and later orders are offered it.
    set_solution(solution["id"], valid_until=TODAY - timedelta(days=1))
    again = write(client, lan, report_id, "Ask for the GeoJSON file.").json()["data"]
    assert again["default"]["supersedesId"] == solution["id"]
    assert again["default"]["steps"] == []
    import_orders(client, lan, LATER_ORDER)
    later = analyse(client, lan)["PO-3"]
    assert cases(client, lan, later)["geolocation"]["default"]["id"] == again["default"]["id"]

    for summary, steps, field in [
        ("  ", [], "summary"),
        ("x" * 501, [], "summary"),
        ("Fine.", [f"Step {i}" for i in range(9)], "steps"),
        ("Fine.", ["x" * 501], "steps"),
    ]:
        refused = write(client, lan, report_id, summary, steps)
        assert refused.status_code == 422, refused.text
        assert field in refused.json()["error"]["fieldErrors"]
    assert write(client, lan, report_id, "Fine.", key="nope").status_code == 422
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert write(client, viewer, report_id, "Fine.").status_code == 403
    other = onboard(client, "mai@example.com", company="Other Co")
    assert write(client, other, report_id, "Fine.").status_code == 404

    events = client.get("/api/v1/audit-events?objectType=solution", headers=lan).json()["data"]
    written = [e for e in events if e["action"] == "solution.written"]
    assert len(written) == 2 and len(events) == 2  # refused ones leave no trace
    first = written[-1]
    assert first["objectId"] == solution["id"]
    assert first["user"]["email"] == "lan@example.com"
    assert first["data"]["orderId"] == "PO-1" and first["data"]["requirementKey"] == "geolocation"
    assert first["data"]["summary"] == solution["summary"]
    assert first["data"]["steps"] == solution["steps"] and "model" not in first["data"]
    assert written[0]["data"]["supersedes"] == solution["id"]
