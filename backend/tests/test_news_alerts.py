"""News watch's alerts and goods: who sees which alert, and the goods the scan reads."""

import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import TEST_TODAY, import_orders, onboard
from google.api_core.exceptions import ServiceUnavailable

from app.database.session import open_session
from app.schemas.account import CompanyOut
from app.seed_reference_data import seed_reference_data
from app.services import news_alerts as news_alert_service
from app.services.news_goods import (
    MAX_GOODS,
    about_company,
    company_goods,
    goods_fingerprint,
    goods_id,
    profile_products,
)

DEMO = "sample"
SAMPLE_ALERT = {
    "headline": "Sample",
    "createdAt": "2026-11-20T00:00:00Z",
    "affected": [],
    "companyId": DEMO,
}


def company(**fields) -> CompanyOut:
    profile = {
        "id": uuid.uuid4(),
        "name": "Saigon Knit Co.",
        "business_role": "Manufacturer",
        "origin": "Vietnam",
        "transit": ["Singapore"],
        "destination": "European Union",
        "currency": "USD",
        "description": "Knitwear for European retailers.",
        "products": "Cotton T-shirts, merino sweaters;\nCotton T-shirts",
        "materials": "Organic cotton (India)",
        "certifications": "GOTS",
        "website": None,
        "founded_year": None,
        "team_size": None,
        "updated_at": datetime.now(UTC),
    }
    return CompanyOut(**{**profile, **fields})


def order(external_id, product, hs_code, market, supplier, ship_date):
    placed = SimpleNamespace(
        external_id=external_id,
        product=product,
        hs_code=hs_code,
        supplier=supplier,
        ship_date=date.fromisoformat(ship_date),
    )
    return placed, market


def test_item_ids_are_the_ones_the_ai_service_made():
    # Stored alerts name goods by these ids (ai/server/goods.js made them before).
    assert goods_id("Wool scarf", "6117.10") == "G-15881E"
    assert goods_id("Cotton T-shirt", "6109.10") == "G-3D9799"
    assert goods_id("Cotton T-shirt", "6109.10") == goods_id("  cotton   t-shirt ", "610910")
    assert goods_id("Cotton T-shirt", "6109.10") != goods_id("Cotton T-shirt", "6109.90")


def test_orders_with_the_same_product_and_hs_code_make_one_item():
    assert profile_products("Cotton T-shirts, merino sweaters;\nCotton T-shirts") == [
        "Cotton T-shirts",
        "merino sweaters",
    ]
    goods = company_goods(
        company(),
        [
            order("PO-1", "Cotton T-shirt", "6109.10", "EU", "Mill A", "2026-11-01"),
            order("PO-2", "Cotton T-shirt", "6109.10", "US", "Mill B", "2026-12-01"),
            order("PO-3", "Wool scarf", "6117.10", "UK", "Mill A", "2026-10-20"),
            order("PO-4", "  ", "6117.10", "UK", "Mill A", "2026-10-20"),
            order("PO-9", "merino sweaters", None, "EU", "Mill C", "2026-11-01"),
        ],
    )
    assert goods["profile"] == {
        "company": "Saigon Knit Co.",
        "about": "a manufacturer based in Vietnam shipping Vietnam → Singapore → European Union; "
        "Knitwear for European retailers; main materials: Organic cotton (India); "
        "certifications: GOTS",
    }
    assert [
        (i["name"], i["hsCode"], i["markets"], i["supplier"], i["orders"], i["source"])
        for i in goods["items"]
    ] == [
        ("Cotton T-shirts", "", [], "", [], "profile"),
        ("merino sweaters", "", ["EU"], "Mill C", ["PO-9"], "profile"),
        ("Cotton T-shirt", "6109.10", ["US", "EU"], "Mill B, Mill A", ["PO-2", "PO-1"], "orders"),
        ("Wool scarf", "6117.10", ["UK"], "Mill A", ["PO-3"], "orders"),
    ]
    assert list(goods["items"][0]) == [
        "sku",
        "name",
        "hsCode",
        "markets",
        "orders",
        "source",
        "supplier",
    ]


def test_goods_are_capped_and_a_sparse_profile_still_describes_the_company():
    many = [order(f"PO-{n}", f"Product {n}", "8471.30", "EU", "S", "2026-11-01") for n in range(70)]
    goods = company_goods(company(products=""), many)
    assert len(goods["items"]) == MAX_GOODS
    assert goods_fingerprint(goods) == goods_fingerprint(company_goods(company(products=""), many))
    sparse = company(business_role="", origin="", transit=[], destination="", description="")
    assert about_company(sparse.model_copy(update={"materials": "", "certifications": ""})) == (
        "a company"
    )


def test_signed_out_sees_the_demo_companys_goods_as_stored(client, news_store):
    assert client.get("/api/v1/news-goods").json()["data"]["items"] == []  # not seeded yet
    items = [{"sku": "PLY-18", "name": "Acacia plywood 18 mm", "qtyOnHand": 120}]
    profile = {"company": "Binh Duong Wood Co.", "about": "a furniture maker", "goodsTerms": []}
    news_store.goods[DEMO] = {"profile": profile, "items": items, "updatedAt": "2026-01-01"}
    goods = client.get("/api/v1/news-goods").json()["data"]
    assert goods["kind"] == "sample"
    assert goods["items"] == items
    assert goods["owner"] == {"company": "Binh Duong Wood Co.", "about": "a furniture maker"}
    # It has no account to rebuild it from, however old it is.
    assert news_store.goods[DEMO]["updatedAt"] == "2026-01-01"


def test_a_company_reads_news_against_its_own_goods(client, news_store):
    with open_session() as db:
        seed_reference_data(db)
    lan = onboard(client, "lan@example.com")
    ship = (TEST_TODAY + timedelta(days=10)).isoformat()
    import_orders(
        client,
        lan,
        "id,product,supplier,destination,value,shipDate,hsCode\n"
        f'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,{ship},4412.33\n',
    )
    goods = client.get("/api/v1/news-goods", headers=lan).json()["data"]
    assert goods["kind"] == "company"
    assert goods["owner"]["company"] == "Binh Duong Wood Co."
    assert goods["watchedSince"] is None
    [item] = goods["items"]
    assert (item["sku"], item["markets"], item["orders"]) == (
        goods_id("Acacia plywood 18 mm", "4412.33"),
        ["EU"],
        ["PO-1"],
    )
    # Kept for the scan, and not rebuilt while fresh.
    [(company_id, stored)] = news_store.goods.items()
    assert stored["fingerprint"] and stored["updatedAt"] == goods["updatedAt"]
    news_store.goods[company_id] = {**stored, "items": [], "backfilledAt": "2026-11-20T00:00:00Z"}
    again = client.get("/api/v1/news-goods", headers=lan).json()["data"]
    assert again["items"] == [] and again["watchedSince"] == "2026-11-20T00:00:00Z"
    # Once stale, rebuilt from the orders; the scan's backfilledAt stays.
    news_store.goods[company_id]["updatedAt"] = "2026-01-01T00:00:00.000Z"
    rebuilt = client.get("/api/v1/news-goods", headers=lan).json()["data"]
    assert len(rebuilt["items"]) == 1 and rebuilt["watchedSince"] == "2026-11-20T00:00:00Z"


def test_each_caller_sees_alerts_about_its_own_goods(client, news_store):
    a = onboard(client, "lan@a.example")
    b = onboard(client, "minh@b.example", company="Other Co.")
    a_id = client.get("/api/v1/me", headers=a).json()["data"]["company"]["id"]
    news_store.sources = {
        "ttj": {"name": "TTJ", "builtIn": True, "enabled": True},
        "own": {"name": "B's feed", "enabled": True, "companyId": "company-b"},
    }
    news_store.alerts = {
        "sample": {**SAMPLE_ALERT, "sourceIds": ["ttj"]},
        "unowned": {**SAMPLE_ALERT, "headline": "Nobody's", "companyId": None},
        f"x~{a_id}": {
            **SAMPLE_ALERT,
            "headline": "A's",
            "companyId": a_id,
            "sourceIds": ["ttj"],
        },
        "old": {**SAMPLE_ALERT, "headline": "Too old", "ageDays": 400, "sourceIds": ["ttj"]},
        "gone": {
            **SAMPLE_ALERT,
            "headline": "Deleted B source",
            "sourceIds": ["deleted"],
            "sourceCompanyIds": ["company-b"],
        },
        "article": {"headline": "Not about goods", "sourceIds": ["own"]},
    }
    news_store.scans = [
        {
            "id": "s1",
            "startedAt": "2026-11-26T00:00:00Z",
            "companyImpacts": {a_id: 1, DEMO: 3},
            "sources": [{"id": "ttj", "name": "TTJ"}, {"id": "own", "companyId": "company-b"}],
        }
    ]

    def alerts(headers=None) -> tuple[list[str], dict]:
        data = client.get("/api/v1/news-alerts", headers=headers or {}).json()["data"]
        return [i["headline"] for i in data["impacts"]], data["scan"]

    shown, scan = alerts()
    assert shown == ["Sample"]
    assert scan["impactsFound"] == 3 and "companyImpacts" not in scan
    assert [s["id"] for s in scan["sources"]] == ["ttj"]

    shown, scan = alerts(a)
    assert shown == ["A's"]
    assert scan["impactsFound"] == 1
    assert alerts(b)[0] == []

    # A shared source switched off hides its alerts for that company only.
    client.patch("/api/v1/news-sources/ttj", headers=a, json={"enabled": False})
    assert alerts(a)[0] == []
    # With the age rule off, old alerts show (here: the sample stock's, so still not A's).
    client.patch("/api/v1/news-sources/ttj", headers=a, json={"enabled": True})
    client.patch("/api/v1/news-settings", headers=a, json={"skipOld": False})
    assert alerts(a)[0] == ["A's"]


def test_alerts_unreachable_are_none(monkeypatch, news_store):
    def down(company_id):
        raise ServiceUnavailable("firestore")

    monkeypatch.setattr(news_store, "list_company_alerts", down)
    assert news_alert_service.fetch_news_alerts(None) is None


@pytest.mark.parametrize(("age", "shown"), [(None, True), (365, True), (366, False)])
def test_the_age_rule_hides_alerts_older_than_it(age, shown):
    access = news_alert_service.NewsAccess(DEMO)
    alert = {"affected": [], "companyId": DEMO, **({"ageDays": age} if age is not None else {})}
    assert news_alert_service.alert_visible(alert, {}, access, 365) is shown
