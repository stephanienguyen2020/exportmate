"""News watch alerts matched to orders: suggestions, people's verdicts, and links they add."""

import uuid
from datetime import date, timedelta

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import select

from app.database.models import AuditEvent, Order, Role
from app.database.session import open_session
from app.seed_reference_data import seed_reference_data
from app.services import news_matches as news_service
from app.services.knowledge_graph import GraphWalker, hs_heading


def ships_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


# PO-1 is suggested for the plywood alert. PO-2 has another HS heading, PO-3 the right
# heading but a market the stock item isn't sold to, and PO-4 has already shipped.
NEWS_CSV = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,{ships_in(10)},4412.33\n'
    f'PO-2,Kitchen cabinet set,Binh Phu Wood,"Long Beach, US",54300,{ships_in(20)},9403.40\n'
    f'PO-3,Acacia plywood 12 mm,Binh Phu Wood,"Long Beach, US",18000,{ships_in(15)},4412.33\n'
    f'PO-4,Acacia plywood 15 mm,Binh Phu Wood,"Hamburg, DE",12000,{ships_in(-5)},4412.33\n'
)
ALERT = {
    "id": "article-1",
    "headline": "EU publishes EUDR guidance for plywood",
    "url": "https://example.org/eudr",
    "severity": "high",
    "affected": [{"sku": "PLY-18", "name": "Acacia plywood 18 mm"}],
}
STOCK = [
    {"sku": "PLY-18", "name": "Acacia plywood 18 mm", "hsCode": "4412.33", "markets": ["EU"]},
    {"sku": "LOG-1", "name": "Acacia logs", "hsCode": "4403.49", "markets": ["Raw material"]},
]


@pytest.fixture(autouse=True)
def news_watch(monkeypatch: pytest.MonkeyPatch) -> dict:
    world: dict = {"alerts": [ALERT], "stock": STOCK, "auth": []}

    def fake_alerts(authorization):
        world["auth"].append(authorization)
        return world["alerts"]

    monkeypatch.setattr(news_service, "fetch_news_alerts", fake_alerts)
    monkeypatch.setattr(news_service, "fetch_news_stock", lambda authorization: world["stock"])
    return world


@pytest.fixture
def lan(client) -> dict:
    with open_session() as db:
        seed_reference_data(db)
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, NEWS_CSV)
    return headers


def matches(client, headers) -> dict[str, dict]:
    response = client.get("/api/v1/news-matches", headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["newsAvailable"] is True
    return {f"{m['impactId']}/{m['orderId']}": m for m in data["matches"]}


def review(client, headers, order_id: str, verdict: str, note: str | None = None):
    return client.put(
        f"/api/v1/news-matches/article-1/orders/{order_id}",
        headers=headers,
        json={"verdict": verdict, "note": note},
    )


def test_open_orders_with_the_items_heading_and_market_are_suggested(client, lan, news_watch):
    found = matches(client, lan)
    assert list(found) == ["article-1/PO-1"]
    match = found["article-1/PO-1"]
    assert match["suggested"] is True
    assert match["market"] == "EU"
    assert match["review"] is None
    assert "HS 4412 and ships to EU" in match["reason"]
    assert (
        match["reason"] == "HS 4412 and ships to EU, like Acacia plywood 18 mm named in this alert."
    )
    # News watch is read with the caller's own token.
    assert news_watch["auth"] == ["Bearer dev:lan@example.com"]


def test_editors_confirm_reject_and_undo_a_suggestion(client, lan):
    confirmed = review(client, lan, "PO-1", "relevant", "  Our EU plywood lots.  ")
    assert confirmed.status_code == 200, confirmed.text
    data = confirmed.json()["data"]
    assert data["review"]["verdict"] == "relevant"
    assert data["review"]["note"] == "Our EU plywood lots."
    assert data["review"]["reviewedBy"]["name"]
    assert matches(client, lan)["article-1/PO-1"]["review"]["verdict"] == "relevant"

    rejected = review(client, lan, "PO-1", "not_relevant")
    assert rejected.json()["data"]["review"]["verdict"] == "not_relevant"
    assert rejected.json()["data"]["review"]["note"] is None

    undone = client.delete("/api/v1/news-matches/article-1/orders/PO-1", headers=lan)
    assert undone.status_code == 200, undone.text
    assert matches(client, lan)["article-1/PO-1"]["review"] is None
    with open_session() as db:
        actions = db.scalars(
            select(AuditEvent.action).where(AuditEvent.action.like("news.%"))
        ).all()
    assert actions == ["news.reviewed", "news.reviewed", "news.review_cleared"]


def test_a_person_can_link_an_order_that_was_not_suggested(client, lan):
    linked = review(client, lan, "PO-2", "relevant", "Cabinets use this plywood.")
    assert linked.status_code == 200, linked.text
    assert linked.json()["data"]["suggested"] is False
    assert linked.json()["data"]["reason"] == news_service.LINKED_REASON
    found = matches(client, lan)
    assert set(found) == {"article-1/PO-1", "article-1/PO-2"}
    assert found["article-1/PO-2"]["review"]["verdict"] == "relevant"

    client.delete("/api/v1/news-matches/article-1/orders/PO-2", headers=lan)
    assert set(matches(client, lan)) == {"article-1/PO-1"}


def test_a_verdict_stays_after_the_order_ships(client, lan):
    review(client, lan, "PO-1", "relevant")
    with open_session() as db:
        order = db.scalar(select(Order).where(Order.external_id == "PO-1"))
        order.ship_date = date.today() - timedelta(days=1)
        db.commit()
    match = matches(client, lan)["article-1/PO-1"]
    assert match["suggested"] is True
    assert match["review"]["verdict"] == "relevant"


def test_viewers_read_but_cannot_review(client, lan):
    viewer = add_member(client, "lan@example.com", "viet@example.com", Role.viewer)
    assert set(matches(client, viewer)) == {"article-1/PO-1"}
    assert review(client, viewer, "PO-1", "relevant").status_code == 403
    assert (
        client.delete("/api/v1/news-matches/article-1/orders/PO-1", headers=viewer).status_code
        == 403
    )


def test_unknown_orders_alerts_and_other_companies_are_not_found(client, lan, news_watch):
    other = onboard(client, "minh@example.com", "Other Co.")
    assert review(client, other, "PO-1", "relevant").status_code == 404
    assert review(client, lan, "PO-99", "relevant").status_code == 404
    response = client.put(
        "/api/v1/news-matches/article-2/orders/PO-1", headers=lan, json={"verdict": "relevant"}
    )
    assert response.status_code == 404
    assert (
        client.delete("/api/v1/news-matches/article-1/orders/PO-1", headers=lan).status_code == 404
    )
    assert review(client, lan, "PO-1", "maybe").status_code == 422


def test_news_watch_down(client, lan, news_watch):
    news_watch["alerts"] = None
    response = client.get("/api/v1/news-matches", headers=lan)
    assert response.json()["data"] == {"newsAvailable": False, "matches": []}
    assert review(client, lan, "PO-1", "relevant").status_code == 503


def test_items_without_an_export_market_match_on_the_heading_alone(lan):
    alert = {"affected": [{"sku": "LOG-1"}, {"sku": "UNKNOWN"}]}
    logs = Order(id=1, external_id="PO-9", hs_code="4403.49", destination="Busan, KR")
    other = Order(id=2, external_id="PO-8", hs_code="4412.33", destination="Busan, KR")
    stock = {s["sku"]: s for s in STOCK}
    with open_session() as db:
        walker = GraphWalker(db, uuid.uuid4())
        found = news_service.suggest_orders(walker, alert, stock, [(logs, "KR"), (other, "KR")])
    assert [s.order.external_id for s in found] == ["PO-9"]
    assert found[0].reason == "HS 4403, like Acacia logs named in this alert."
    assert hs_heading("44.1") == ""
