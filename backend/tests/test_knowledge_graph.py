"""The knowledge graph: seed data loaded, the downstream walk, and orders reached from what a
news article names, through suppliers' sourcing and the material chain."""

from datetime import date, timedelta

import pytest
from conftest import import_orders, onboard
from sqlalchemy import func, select

from app.database.models import GraphEdge, GraphNode, GraphNodeKind, SupplierSourcing
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services import news_matches as news_service


def ships_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


# Suppliers from the demo seed: Binh Phu Wood buys acacia logs from Vietnam, Savannakhet Timber
# eucalyptus logs from Laos, Mekong Timber veneers (okoume from Gabon, …).
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,{ships_in(10)},4412.33\n'
    f'PO-2,Eucalyptus garden chair,Savannakhet Timber,"Hamburg, DE",9000,{ships_in(20)},9401.69\n'
    f'PO-3,Okoume plywood,Mekong Timber,"Antwerp, BE",15000,{ships_in(15)},4412.33\n'
    f'PO-4,Kitchen cabinet set,Binh Phu Wood,"Long Beach, US",54300,{ships_in(25)},9403.40\n'
)


@pytest.fixture
def news_watch(monkeypatch: pytest.MonkeyPatch) -> dict:
    world: dict = {"alerts": []}
    monkeypatch.setattr(news_service, "fetch_news_alerts", lambda authorization: world["alerts"])
    monkeypatch.setattr(news_service, "fetch_news_stock", lambda authorization: [])
    return world


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


def alert(mentions: dict) -> dict:
    return {"id": "article-1", "headline": "Test", "affected": [], "mentions": mentions}


def matches(client, headers) -> dict[str, dict]:
    response = client.get("/api/v1/news-matches", headers=headers)
    assert response.status_code == 200, response.text
    return {m["orderId"]: m for m in response.json()["data"]["matches"]}


def test_seed_loads_the_material_chain_and_sourcing(lan):
    with open_session() as db:
        kinds = dict(
            db.execute(select(GraphNode.kind, func.count()).group_by(GraphNode.kind)).all()
        )
        wood = db.get(GraphNode, "commodity.wood")
        edges = db.scalar(select(func.count()).select_from(GraphEdge))
        sourcing = db.scalars(select(SupplierSourcing)).all()
    assert kinds == {
        GraphNodeKind.commodity: 7,
        GraphNodeKind.product: 14,
        GraphNodeKind.material: 11,
    }
    assert {"4403", "4412", "940360"} <= set(wood.hs_prefixes)
    assert wood.source_key == "eudr-annex-i"
    assert {"wood", "timber", "hardwood"} <= set(wood.aliases)
    assert edges == 25
    by_material = {(s.material_key, s.country_alpha2, s.form_key) for s in sourcing}
    assert ("material.acacia", "VN", "wood.roundwood") in by_material
    assert ("material.okoume", "GA", "wood.veneer") in by_material


def test_walking_downstream_follows_the_chain_shortest_first(lan):
    with open_session() as db:
        rows = graph_queries.walk_downstream(db, {"wood.roundwood", "wood.paper"}, 4)
    depth = {}
    for row in rows:
        depth.setdefault((row.start_key, row.node_key), (row.depth, len(row.edge_ids)))
    assert depth[("wood.roundwood", "wood.roundwood")] == (0, 0)
    assert depth[("wood.roundwood", "wood.plywood")] == (2, 2)  # logs → veneer → plywood
    assert depth[("wood.roundwood", "wood.wooden-furniture")] == (2, 2)  # logs → sawn → furniture
    assert depth[("wood.roundwood", "wood.paper")] == (2, 2)  # logs → pulp → paper
    # Paper is the end of its chain.
    assert [key for key in depth if key[0] == "wood.paper"] == [("wood.paper", "wood.paper")]


def test_an_article_reaches_orders_through_the_suppliers_sourcing(client, lan, news_watch):
    news_watch["alerts"] = [
        alert({"materials": ["acacia logs"], "originCountries": ["VN"], "hsCodes": ["4403.49"]})
    ]
    found = matches(client, lan)
    # Binh Phu Wood buys acacia logs from Vietnam: its plywood and cabinets are made from them.
    assert set(found) == {"PO-1", "PO-4"}
    # Furniture is reached through sawn wood: veneer → furniture is a secondary route, mostly a
    # surface, used only when no equally short path avoids it.
    assert "Sawn wood (lumber) (HS 4407) → Wooden furniture" in found["PO-4"]["reason"]
    plywood = found["PO-1"]
    assert plywood["reason"] == (
        "Binh Phu Wood buys acacia from Vietnam; Logs (wood in the rough) (HS 4403) → "
        "Veneer sheets (HS 4408) → Plywood and veneered panels (HS 4412), this order's product."
    )
    steps = plywood["path"]
    assert [s["kind"] for s in steps] == [
        "mention",
        "supplier",
        "product",
        "product",
        "product",
        "order",
    ]
    assert steps[1]["link"] == "buys acacia from Vietnam (species document)"
    assert steps[3]["link"] == "used to make"
    assert steps[3]["sourceUrl"].startswith("https://fao.org/")
    assert "veneer logs" in steps[3]["quote"]


def test_a_country_alone_reaches_every_supplier_buying_there(client, lan, news_watch):
    news_watch["alerts"] = [alert({"originCountries": ["LA"]})]
    found = matches(client, lan)
    assert set(found) == {"PO-2"}
    assert found["PO-2"]["reason"].startswith("Savannakhet Timber buys eucalyptus from Laos; Logs")
    assert "Seats with wooden frames" in found["PO-2"]["reason"]


def test_markets_and_named_products_narrow_the_orders(client, lan, news_watch):
    # Only orders to the EU.
    news_watch["alerts"] = [alert({"materials": ["acacia"], "markets": ["EU"]})]
    assert set(matches(client, lan)) == {"PO-1"}
    # A country names its market ("NL" is in the EU); unknown codes don't filter anything out.
    news_watch["alerts"] = [alert({"materials": ["acacia"], "markets": ["NL", "ZZ"]})]
    assert set(matches(client, lan)) == {"PO-1"}
    news_watch["alerts"] = [alert({"materials": ["acacia"], "markets": ["ZZ"]})]
    assert set(matches(client, lan)) == {"PO-1", "PO-4"}
    # Okoume veneer: Mekong Timber's plywood, not other suppliers' goods.
    news_watch["alerts"] = [alert({"materials": ["okoumé"], "hsCodes": ["4408"]})]
    assert set(matches(client, lan)) == {"PO-3"}
    # Paper isn't made into plywood or furniture.
    news_watch["alerts"] = [alert({"materials": ["acacia"], "hsCodes": ["4802"]})]
    assert matches(client, lan) == {}


def test_an_unknown_material_reaches_nothing(client, lan, news_watch):
    news_watch["alerts"] = [alert({"materials": ["cocoa beans"], "originCountries": ["CI"]})]
    assert matches(client, lan) == {}


def test_broad_words_stand_for_their_materials(client, lan, news_watch):
    # "hardwood": the non-coniferous and tropical species; every supplier here buys some.
    news_watch["alerts"] = [alert({"materials": ["hardwood"], "markets": ["US"]})]
    assert set(matches(client, lan)) == {"PO-4"}
    # The more specific word wins: "tropical timber" is okoume (Mekong Timber), not every wood.
    news_watch["alerts"] = [alert({"materials": ["tropical timber"]})]
    assert set(matches(client, lan)) == {"PO-3"}
    # A named species wins over a broad word: oak only (Mekong Timber's oak veneer).
    news_watch["alerts"] = [alert({"materials": ["oak", "hardwood"]})]
    assert set(matches(client, lan)) == {"PO-3"}
    # No supplier here buys softwood.
    news_watch["alerts"] = [alert({"materials": ["softwood lumber"]})]
    assert matches(client, lan) == {}


def test_product_words_count_like_hs_codes(client, lan, news_watch):
    # "plywood" from Vietnam: plywood and cabinets of suppliers buying Vietnamese wood (Binh Phu
    # Wood's acacia, Mekong Timber's eucalyptus cores), not Savannakhet Timber's Lao chairs.
    news_watch["alerts"] = [alert({"materials": ["plywood"], "originCountries": ["VN"]})]
    found = matches(client, lan)
    assert set(found) == {"PO-1", "PO-3", "PO-4"}
    assert "Plywood and veneered panels (HS 4412)" in found["PO-4"]["reason"]
    # Paper isn't made into any of these orders' products.
    news_watch["alerts"] = [alert({"materials": ["paper"], "originCountries": ["VN"]})]
    assert matches(client, lan) == {}


def test_verdicts_measure_each_way_and_link(client, lan, news_watch):
    # A company's own alert ("<articleId>~<companyId>") is reviewed like any other.
    impact = "article-9~company-1"
    news_watch["alerts"] = [
        {
            "id": impact,
            "headline": "Vietnam limits acacia log exports",
            "affected": [],
            "mentions": {"materials": ["acacia logs"], "originCountries": ["VN"]},
        }
    ]
    assert set(matches(client, lan)) == {"PO-1", "PO-4"}
    url = f"/api/v1/news-matches/{impact}/orders"
    assert client.put(f"{url}/PO-1", headers=lan, json={"verdict": "relevant"}).status_code == 200
    rejected = client.put(f"{url}/PO-4", headers=lan, json={"verdict": "not_relevant"})
    assert rejected.status_code == 200, rejected.text
    # A person links an order the graph didn't suggest.
    linked = client.put(f"{url}/PO-3", headers=lan, json={"verdict": "relevant"})
    assert linked.status_code == 200, linked.text

    accuracy = client.get("/api/v1/news-matches/accuracy", headers=lan).json()["data"]
    assert accuracy["byWay"] == [
        {"via": "supplier", "confirmed": 1, "rejected": 1},
        {"via": "linked", "confirmed": 1, "rejected": 0},
    ]
    links = {(row["fromLabel"], row["toLabel"]): row for row in accuracy["byLink"]}
    # PO-1 went logs → veneer → plywood; PO-4 logs → sawn wood → furniture.
    logs_to_veneer = links[("Logs (wood in the rough) (HS 4403)", "Veneer sheets (HS 4408)")]
    assert (logs_to_veneer["confirmed"], logs_to_veneer["rejected"]) == (1, 0)
    sawn_to_furniture = links[
        (
            "Sawn wood (lumber) (HS 4407)",
            "Wooden furniture (office, kitchen, bedroom, other) and parts (HS 9403.30, 9403.40)",
        )
    ]
    assert (sawn_to_furniture["confirmed"], sawn_to_furniture["rejected"]) == (0, 1)
    assert accuracy["byLink"][0]["rejected"] == 1  # most rejected first
