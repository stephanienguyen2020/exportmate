"""The knowledge graph: seed data loaded, the downstream walk, and orders reached from what a
news article names, through suppliers' sourcing and the material chain."""

from datetime import date, timedelta

import pytest
from conftest import import_orders, onboard
from sqlalchemy import func, select, update

from app.database.models import GraphEdge, GraphNode, GraphNodeKind, Order, SupplierSourcing
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.knowledge_graph import load_chain
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services import news_matches as news_service
from app.services.graph_feedback import LinkFeedback, LinkVerdicts


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
    # Wood written by hand, and every industry the pipeline released (data/industries/).
    chain = load_chain()
    assert kinds == {
        GraphNodeKind.commodity: 7,
        GraphNodeKind.product: sum(len(i["products"]) for i in chain["industries"]),
        GraphNodeKind.material: len(chain["materials"]),
    }
    assert {i["key"] for i in chain["industries"]} >= {"wood", "cocoa", "coffee", "oil-palm"}
    assert {"4403", "4412", "940360"} <= set(wood.hs_prefixes)
    assert wood.source_key == "eudr-annex-i"
    assert {"wood", "timber", "hardwood"} <= set(wood.aliases)
    assert edges == sum(len(i["links"]) for i in chain["industries"])
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
    assert "fao.org/" in steps[3]["sourceUrl"]
    assert "used for the production of veneer" in steps[3]["quote"]


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
            "Wooden furniture (HS 9403.30, 9403.40)",
        )
    ]
    assert (sawn_to_furniture["confirmed"], sawn_to_furniture["rejected"]) == (0, 1)
    assert accuracy["byLink"][0]["rejected"] == 1  # most rejected first


def test_links_people_keep_rejecting_are_avoided_and_marked(client, lan, news_watch):
    acacia = {"materials": ["acacia logs"], "originCountries": ["VN"]}

    def reject_cabinets(alert_id: str) -> None:
        news_watch["alerts"] = [{**alert(acacia), "id": alert_id}]
        found = matches(client, lan)
        assert "Sawn wood (lumber) (HS 4407)" in found["PO-4"]["reason"]
        url = f"/api/v1/news-matches/{alert_id}/orders/PO-4"
        assert client.put(url, headers=lan, json={"verdict": "not_relevant"}).status_code == 200

    # Twice rejected: logs → sawn wood → furniture is doubted at this company.
    reject_cabinets("article-1")
    reject_cabinets("article-2")
    news_watch["alerts"] = [{**alert(acacia), "id": "article-3"}]
    found = matches(client, lan)
    # The walk now takes another path as short (logs → particle board → furniture), with no
    # doubted link on it.
    assert "Sawn wood" not in found["PO-4"]["reason"]
    assert "→ Wooden furniture" in found["PO-4"]["reason"]
    assert not any(step["doubt"] for step in found["PO-4"]["path"])
    assert "rejected" not in found["PO-1"]["reason"]

    accuracy = client.get("/api/v1/news-matches/accuracy", headers=lan).json()["data"]
    sawn = next(row for row in accuracy["byLink"] if row["toKey"] == "wood.wooden-furniture")
    assert (sawn["fromKey"], sawn["rejected"], sawn["doubt"]) == (
        "wood.sawnwood",
        2,
        "Often rejected at your company",
    )


def test_a_link_is_doubted_by_its_company_first_then_by_everyone():
    assert LinkFeedback(LinkVerdicts(0, 1), LinkVerdicts(0, 1)).doubt is None
    assert (
        LinkFeedback(LinkVerdicts(0, 2), LinkVerdicts(0, 2)).doubt
        == "Often rejected at your company"
    )
    # Confirmed as often as rejected: not doubted.
    assert LinkFeedback(LinkVerdicts(2, 2), LinkVerdicts(2, 2)).doubt is None
    # Other companies' rejections count once there are enough of them.
    assert LinkFeedback(LinkVerdicts(), LinkVerdicts(1, 4)).doubt is None
    assert (
        LinkFeedback(LinkVerdicts(), LinkVerdicts(1, 5)).doubt == "Often rejected across companies"
    )


def test_the_material_chain_page_shows_links_sources_checks_and_verdicts(client, lan, news_watch):
    # One rejection of the cabinets order counts on each link of its path.
    news_watch["alerts"] = [alert({"materials": ["acacia logs"], "originCountries": ["VN"]})]
    matches(client, lan)
    url = "/api/v1/news-matches/article-1/orders/PO-4"
    assert client.put(url, headers=lan, json={"verdict": "not_relevant"}).status_code == 200

    response = client.get("/api/v1/knowledge-graph/chain", headers=lan)
    assert response.status_code == 200, response.text
    chain = response.json()["data"]
    wood = next(i for i in chain["industries"] if i["key"] == "wood")
    assert (wood["key"], wood["name"]) == ("wood", "Wood")
    # Products read from forest to finished goods.
    assert wood["products"][0]["key"] == "wood.roundwood"
    assert {"key": "wood.plywood", "hsCodes": ["4412"]} in [
        {"key": p["key"], "hsCodes": p["hsCodes"]} for p in wood["products"]
    ]
    assert len(wood["links"]) == len(
        next(i for i in load_chain()["industries"] if i["key"] == "wood")["links"]
    )
    assert wood["links"][0]["fromKey"] == "wood.roundwood"
    veneer = next(
        link
        for link in wood["links"]
        if (link["fromKey"], link["toKey"]) == ("wood.roundwood", "wood.veneer")
    )
    assert "fao.org/" in veneer["sourceUrl"]
    assert "production of veneer" in veneer["quote"]
    assert veneer["aiCheck"]["verdict"] == "agree"
    assert veneer["secondary"] is False
    sawn = next(
        link
        for link in wood["links"]
        if (link["fromKey"], link["toKey"]) == ("wood.sawnwood", "wood.wooden-furniture")
    )
    assert sawn["company"] == {"confirmed": 0, "rejected": 1}
    assert sawn["doubt"] is None  # one rejection isn't enough
    secondary_in_data = {
        (f"wood.{link['from']}", f"wood.{link['to']}")
        for industry in load_chain()["industries"]
        if industry["key"] == "wood"
        for link in industry["links"]
        if link.get("secondary")
    }
    assert {(link["fromKey"], link["toKey"]) for link in wood["links"] if link["secondary"]} == (
        secondary_in_data
    )
    assert {m["key"] for m in chain["materials"]} >= {"acacia", "okoume"}
    assert chain["byWay"] == [{"via": "supplier", "confirmed": 0, "rejected": 1}]


def test_released_industries_join_the_graph(client, lan, news_watch):
    # A cocoa supplier in Ghana and a chocolate order: the cocoa chain was built by the pipeline.
    supplier = {
        "name": "Kumasi Cocoa",
        "country": "GH",
        "sourcing": [{"material": "cocoa", "country": "GH", "form": "cocoa-beans"}],
    }
    created = client.post("/api/v1/suppliers", headers=lan, json=supplier)
    assert created.status_code == 201, created.text
    import_orders(
        client,
        lan,
        "id,product,supplier,destination,value,shipDate,hsCode\n"
        f'PO-9,Dark chocolate bars,Kumasi Cocoa,"Hamburg, DE",8000,{ships_in(30)},1806.32\n',
    )
    news_watch["alerts"] = [alert({"materials": ["cocoa beans"], "originCountries": ["GH"]})]
    found = matches(client, lan)
    assert set(found) == {"PO-9"}
    reason = found["PO-9"]["reason"]
    assert reason.startswith("Kumasi Cocoa buys cocoa from Ghana; Cocoa")
    assert "(HS 1806" in reason
    chain = client.get("/api/v1/knowledge-graph/chain", headers=lan).json()["data"]
    assert {i["key"] for i in chain["industries"]} >= {"wood", "cocoa", "coffee", "oil-palm"}


def graph_query(client, headers, **params) -> dict:
    response = client.get("/api/v1/knowledge-graph/query", headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_a_question_reaches_orders_with_the_walks_cited_paths(client, lan):
    found = graph_query(client, lan, material=["acacia logs"], country=["vn"])
    by_order = {m["orderId"]: m for m in found["matches"]}
    # The same paths News watch gives for an article naming acacia logs from Vietnam.
    assert set(by_order) == {"PO-1", "PO-4"}
    plywood = by_order["PO-1"]
    assert plywood["via"] == "supplier"
    assert plywood["supplier"] == "Binh Phu Wood"
    assert plywood["status"]
    assert [s["kind"] for s in plywood["path"]][-2:] == ["product", "order"]
    assert "used for the production of veneer" in plywood["path"][3]["quote"]
    assert found["understood"] == {
        "materials": ["Acacia"],
        "products": ["Logs (wood in the rough)"],
        "countries": ["Vietnam"],
        "markets": [],
        "unknown": [],
    }
    assert found["ordersChecked"] == 4


def test_a_question_says_what_the_graph_doesnt_know(client, lan):
    found = graph_query(client, lan, material=["unobtainium"], country=["XX"], market=["MARS"])
    assert found["matches"] == []
    assert found["understood"]["unknown"] == ["unobtainium", "XX", "MARS"]


def test_hs_codes_markets_and_shipped_orders(client, lan):
    # A heading reaches orders by HS code, narrowed to the market named (NL counts as the EU).
    found = graph_query(client, lan, hsCode=["4412.33"], market=["NL"])
    assert {m["orderId"]: m["via"] for m in found["matches"]} == {"PO-1": "hs", "PO-3": "hs"}
    assert found["understood"]["markets"] == ["EU"]
    # Shipped orders are left out unless asked for.
    with open_session() as db:
        db.execute(
            update(Order)
            .where(Order.external_id == "PO-1")
            .values(ship_date=date.today() - timedelta(days=1))
        )
        db.commit()
    assert {m["orderId"] for m in graph_query(client, lan, hsCode=["4412.33"])["matches"]} == {
        "PO-3"
    }
    shipped = graph_query(client, lan, hsCode=["4412.33"], includeShipped="true")
    assert {m["orderId"] for m in shipped["matches"]} == {"PO-1", "PO-3"}
    assert shipped["ordersChecked"] == 4


def test_the_graph_query_needs_a_signed_in_company(client, lan):
    assert (
        client.get("/api/v1/knowledge-graph/query", params={"material": "acacia"}).status_code
        == 401
    )
