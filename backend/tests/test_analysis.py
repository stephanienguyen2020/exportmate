from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import delete

from app.database.models import AnalysisReport, Role
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.schemas.analysis import CostLineOut, ReportContentOut
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services.analysis import audit_report

TODAY = datetime.now(UTC).date()


def ship_in(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


# PO-1 to the EU, 10 days out, from a supplier without plot geolocation: exposed and late.
# PO-2 kitchen cabinets to the US: clear, but the Section 232 duty applies.
# PO-3 to a country with no checklist, PO-4 from a supplier with no record: both need action,
# and the action is the data to add.
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,{ship_in(10)},9403.60\n'
    f'PO-2,Shaker kitchen cabinet set,An Cuong Wood,"Long Beach, US",54300,{ship_in(60)},9403.40\n'
    f"PO-3,Birch plywood,Mekong Timber,Dubai AE,10000,{ship_in(30)},4412.31\n"
    f'PO-4,Teak lounge bed,Song Be Timber,"Lyon, FR",31680,{ship_in(45)},9403.50\n'
)


@pytest.fixture
def lan(client) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    return headers


def run(client, headers, **body) -> dict:
    response = client.post("/api/v1/runs", headers=headers, json=body or None)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def reports_by_order(client, headers, run_data) -> dict[str, dict]:
    return {
        r["orderId"]: client.get(f"/api/v1/reports/{r['id']}", headers=headers).json()["data"]
        for r in run_data["reports"]
    }


def test_an_import_analyses_its_orders(client):
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    uploaded = client.post(
        "/api/v1/imports", headers=headers, files={"file": ("orders.csv", ORDERS, "text/csv")}
    ).json()["data"]
    response = client.post(f"/api/v1/imports/{uploaded['id']}/commit", headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["ordersCreated"] == 4
    assert data["run"]["status"] == "done"
    statuses = {r["orderId"]: r["orderStatus"] for r in data["run"]["reports"]}
    assert statuses == {
        "PO-1": "exposed",
        "PO-2": "clear",
        "PO-3": "exposed",
        "PO-4": "exposed",
    }
    orders = client.get("/api/v1/orders", headers=headers).json()["data"]
    assert {o["id"]: o["status"] for o in orders} == statuses


def test_run_reports_each_order(client, lan):
    data = run(client, lan)
    assert data["status"] == "done"
    assert [s["name"] for s in data["steps"]] == [
        "relevance",
        "exposure",
        "cost",
        "playbook",
        "plan",
        "auditor",
    ]
    assert data["steps"][1]["summary"].startswith("3 exposed (2 missing data), 1 clear.")
    reports = reports_by_order(client, lan, data)

    late = reports["PO-1"]
    assert (late["state"], late["orderStatus"]) == ("pass", "exposed")
    assert late["orderSource"]["rowNumber"] == 2
    geolocation = next(f for f in late["findings"] if f["requirementKey"] == "geolocation")
    assert geolocation["status"] == "missing"
    assert geolocation["source"]["officialId"] == "32023R1115"
    assert geolocation["source"]["quote"]
    lines = {line["kind"]: line for line in late["costLines"]}
    assert lines["missing_document"]["amountMinor"] == 40000
    assert lines["missing_document"]["basis"][0]["type"] == "default"
    # The supplier needs 14 days and the ship date is in 10: 4 days × USD 200.
    assert (lines["delay"]["quantity"], lines["delay"]["amountMinor"]) == (4, 80000)
    assert late["costTotals"] == {"USD": 120000}
    assert late["suggestedAction"]["kind"] == "move_ship_date"
    assert late["audit"] == {"passed": True, "problems": []}

    cabinets = reports["PO-2"]
    assert (cabinets["state"], cabinets["orderStatus"]) == ("pass", "clear")
    duty = cabinets["costLines"][0]
    assert duty["kind"] == "duty"
    assert duty["ratePercent"] == 25
    assert duty["amountMinor"] == 1357500  # 25% × USD 54,300.00
    assert duty["formula"] == "25% × USD 54,300.00"
    assert duty["basis"][0]["source"]["officialId"] == "Proclamation 10976"
    assert cabinets["suggestedAction"]["kind"] == "recheck_landed_cost"

    assert (reports["PO-3"]["state"], reports["PO-3"]["orderStatus"]) == ("pass", "exposed")
    assert reports["PO-3"]["missingData"][0].startswith("No checklist for Dubai AE")
    assert reports["PO-3"]["messageBlockedReason"].startswith("Complete the order's data")
    assert reports["PO-4"]["orderStatus"] == "exposed"
    assert reports["PO-4"]["missingData"] == [
        "Add Song Be Timber to the suppliers, with their documents."
    ]
    assert reports["PO-4"]["suggestedAction"]["kind"] == "complete_data"

    # Order statuses, the overview and the order page follow the latest run.
    overview = client.get("/api/v1/overview", headers=lan).json()["data"]
    assert overview["countsByStatus"] == {
        "awaiting_analysis": 0,
        "clear": 1,
        "exposed": 3,
        "needs_data": 0,
    }
    detail = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    assert [e["requirementKey"] for e in detail["exposures"]] == ["geolocation"]
    assert detail["exposures"][0]["reportId"] == late["id"]
    assert detail["latestReportId"] == late["id"]


def test_company_cost_settings_change_the_numbers(client, lan):
    settings = client.get("/api/v1/company/cost-settings", headers=lan).json()["data"]
    assert {s["key"]: s["source"] for s in settings} == {
        "delay_per_day": "default",
        "missing_document": "default",
        "new_test": "default",
        "supplier_lead_days": "default",
    }
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    body = {"settings": [{"key": "delay_per_day", "value": 35000}]}
    assert (
        client.patch("/api/v1/company/cost-settings", headers=editor, json=body).status_code == 403
    )
    changed = client.patch("/api/v1/company/cost-settings", headers=lan, json=body)
    assert changed.status_code == 200, changed.text

    late = reports_by_order(client, lan, run(client, lan, orderIds=["PO-1"]))["PO-1"]
    delay = next(line for line in late["costLines"] if line["kind"] == "delay")
    assert delay["amountMinor"] == 4 * 35000
    assert delay["formula"] == "4 days × USD 350.00"
    assert delay["basis"][1] == {
        "type": "company_setting",
        "label": "Delay: cost of each day an order waits (storage, late fees)",
        "settingKey": "delay_per_day",
        "source": None,
    }

    bad = [
        {"settings": [{"key": "fines", "value": 1}]},
        {"settings": [{"key": "supplier_lead_days", "value": 21, "unit": "USD"}]},
        {"settings": [{"key": "delay_per_day", "value": 1, "unit": "XYZ"}]},
    ]
    for payload in bad:
        response = client.patch("/api/v1/company/cost-settings", headers=lan, json=payload)
        assert response.status_code == 422, payload
    reset = client.patch(
        "/api/v1/company/cost-settings",
        headers=lan,
        json={"settings": [{"key": "delay_per_day", "value": None}]},
    ).json()["data"]
    assert next(s for s in reset if s["key"] == "delay_per_day")["value"] == 20000


def test_playbook_rules_change_the_report(client, lan):
    rules = [
        {
            "text": "Problems over USD 1,000 go to the owner",
            "category": "Threshold",
            "when": [
                {
                    "field": "estimated_cost",
                    "op": "greater_than",
                    "value": {"amountMinor": 100000, "currency": "USD"},
                }
            ],
            "then": {"action": "owner_review"},
        },
        {
            "text": "Never ship to the EU without plot geolocation",
            "category": "Policy",
            "when": [
                {"field": "market", "op": "equals", "value": "EU"},
                {"field": "missing_documents", "op": "contains", "value": "geolocation"},
            ],
            "then": {"action": "block", "note": "Hold the shipment."},
        },
        {"text": "Flag margins below 8%", "category": "Threshold"},
    ]
    for rule in rules:
        assert client.post("/api/v1/playbook/rules", headers=lan, json=rule).status_code == 201

    data = run(client, lan)
    assert "2 checked rules (playbook revision 3) fired 2 times" in data["steps"][3]["summary"]
    reports = reports_by_order(client, lan, data)
    late = reports["PO-1"]
    assert late["state"] == "needs_human_review"
    assert late["blocked"] is True
    assert {r["action"] for r in late["rulesFired"]} == {"owner_review", "block"}
    assert late["rulesNotChecked"] == 1
    assert reports["PO-2"]["rulesFired"] == []  # the duty isn't a problem's cost


def test_runs_and_reports_belong_to_one_company(client, lan):
    data = run(client, lan, orderIds=["PO-2"])
    assert data["orderCount"] == 1
    other = onboard(client, "mai@example.com", company="Other Co")
    assert client.get(f"/api/v1/runs/{data['id']}", headers=other).status_code == 404
    report_id = data["reports"][0]["id"]
    assert client.get(f"/api/v1/reports/{report_id}", headers=other).status_code == 404
    unknown = client.post("/api/v1/runs", headers=lan, json={"orderIds": ["PO-404"]})
    assert unknown.status_code == 422
    assert client.post("/api/v1/runs", headers=other).status_code == 422  # no orders

    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert client.post("/api/v1/runs", headers=viewer).status_code == 403
    assert client.get(f"/api/v1/runs/{data['id']}", headers=viewer).status_code == 200


def test_auditor_rejects_numbers_that_dont_recompute(client, lan):
    report = reports_by_order(client, lan, run(client, lan, orderIds=["PO-1"]))["PO-1"]
    content = ReportContentOut.model_validate(report)
    assert audit_report(content, set()).passed
    content.cost_lines[0] = CostLineOut.model_validate(
        {**report["costLines"][0], "amountMinor": 999}
    )
    result = audit_report(content, set())
    assert not result.passed
    assert any("doesn't re-compute" in p for p in result.problems)
    assert "The totals don't match the cost lines." in result.problems


def test_a_duty_whose_rate_changes_by_the_ship_date_is_not_priced(client, lan):
    import_orders(
        client,
        lan,
        "id,product,supplier,destination,value,shipDate,hsCode\n"
        'PO-9,Bathroom vanity,An Cuong Wood,"Long Beach, US",20000,2027-02-01,9403.40\n',
    )
    report = reports_by_order(client, lan, run(client, lan, orderIds=["PO-9"]))["PO-9"]
    assert [line["kind"] for line in report["costLines"]] == []
    assert report["unpricedCosts"][0]["requirementKey"] == "tariff"
    assert report["unpricedCosts"][0]["reason"].startswith("The rate changes on 2027-01-01")
    assert report["suggestedAction"]["kind"] == "recheck_landed_cost"
    assert report["audit"]["passed"] is True


def test_the_order_report_repeats_the_latest_analysis(client, lan):
    def sections(order_id: str) -> dict[str, dict]:
        response = client.post(
            "/api/v1/report-drafts", headers=lan, json={"kind": "order", "orderId": order_id}
        )
        assert response.status_code == 201, response.text
        return {s["id"]: s for s in response.json()["data"]["content"]["sections"]}

    # The import analysed its orders; without any report the order report says so.
    with open_session() as db:
        db.execute(delete(AnalysisReport))
        db.commit()
    before = sections("PO-1")
    assert before["analysis"]["note"].startswith("Not analysed yet")
    assert before["costs"]["rows"] == []

    run(client, lan, orderIds=["PO-1"])
    after = sections("PO-1")
    facts = {row["cells"][0]: row["cells"][1] for row in after["analysis"]["rows"]}
    assert facts["Estimated cost"] == "USD 1,200.00"
    assert facts["Next step"].startswith("Binh Phu Wood needs 14 days")
    assert [row["cells"][2] for row in after["costs"]["rows"]] == ["USD 400.00", "USD 800.00"]
    assert "changed since" not in after["analysis"]["note"]
