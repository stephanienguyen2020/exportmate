"""The demo seed: its orders are analysed like an import's, so supplier messages can be drafted."""

from conftest import auth_header

from app.seed_demo_data import seed_demo_data


def test_the_demo_seed_analyses_its_orders(client):
    seed_demo_data("minh@example.com", "dev:minh@example.com", "us-furniture")
    headers = auth_header("minh@example.com")
    orders = client.get("/api/v1/orders?limit=100", headers=headers).json()["data"]
    assert len(orders) == 16
    # Statuses come from the analysis: never left waiting, never the retired needs_data.
    assert {o["status"] for o in orders} <= {"clear", "exposed"}

    reports = {}
    for order in orders:
        detail = client.get(f"/api/v1/orders/{order['id']}", headers=headers).json()["data"]
        report_id = detail["latestReportId"]
        reports[order["id"]] = client.get(f"/api/v1/reports/{report_id}", headers=headers).json()[
            "data"
        ]
    # Hiep Phuoc Rattan has no supplier record in the seed file.
    assert reports["PO-3109"]["missingData"] == [
        "Add Hiep Phuoc Rattan to the suppliers, with their documents."
    ]
    assert reports["PO-3109"]["messageBlockedReason"].startswith("Add Hiep Phuoc Rattan")
    # The seed's suppliers lack documents the US checklist asks for: those can be emailed.
    assert any(r["messageBlockedReason"] is None for r in reports.values())

    # Seeding again adds nothing and analyses nothing again.
    seed_demo_data("minh@example.com", "dev:minh@example.com", "us-furniture")
    again = client.get("/api/v1/orders/PO-3109", headers=headers).json()["data"]
    assert again["latestReportId"] == reports["PO-3109"]["id"]
