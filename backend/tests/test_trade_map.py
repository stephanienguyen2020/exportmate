import pytest
from conftest import import_orders, onboard
from sqlalchemy import func, select

from app.database.models import MarketRequirement, SatelliteObservation, Supplier
from app.database.queries import trade_map as map_queries
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services.trade_map import km_from_extent, nearby_places, parse_destination

MAP_CSV = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,2026-10-27,4412.33\n'
    'PO-2,Shaker kitchen cabinet set,binh phu  wood,"Long Beach, US",54300,2026-11-17,9403.40\n'
    'PO-3,Rubberwood panels,An Cuong Wood,"Antwerp, BE",15000,2026-11-04,4418.99\n'
    'PO-4,Teak lounge bed,Dong Nai Veneer,"Lyon, FR",31680,2026-12-10,9401.69\n'
    "PO-5,Birch plywood,Mekong Timber,Dubai AE,10000,2026-12-11,4412.31\n"
)


@pytest.fixture
def reference() -> None:
    with open_session() as db:
        seed_reference_data(db)


def seed_company(email: str) -> None:
    """The demo company's suppliers, documents and sites, for this user's company."""
    with open_session() as db:
        user = user_queries.get_user_by_firebase_uid(db, f"dev:{email}")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)


def get_map(client, headers) -> dict:
    response = client.get("/api/v1/trade-map", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def orders_by_id(data: dict) -> dict:
    return {o["order"]["id"]: o for o in data["orders"]}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Rotterdam, NL", ("Rotterdam", "NL")),
        ("Rotterdam NL", ("Rotterdam", "NL")),
        ("London, UK", ("London", "GB")),
        ("nl", ("", "NL")),
        ("Ho Chi Minh City", ("Ho Chi Minh City", None)),
        ("  Le Havre ,", ("Le Havre", None)),
    ],
)
def test_parse_destination(text, expected):
    assert parse_destination(text) == expected


def test_orders_are_placed_and_checked(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)
    orders = orders_by_id(get_map(client, headers))

    po1 = orders["PO-1"]
    assert po1["placement"] == {
        "city": "Rotterdam",
        "country": "NL",
        "market": "EU",
        "location": {"latitude": 51.92, "longitude": 4.4},
        "approximate": False,
    }
    assert {c["requirementKey"]: c["status"] for c in po1["checks"]} == {
        "legality": "on_file",
        "geolocation": "missing",
        "dds": "prepare",
        "formaldehyde": "on_file",
        "origin": "prepare",
        "ispm15": "prepare",
    }
    assert po1["gapCount"] == 1

    # Supplier text matches the record however it's cased or spaced. The US asks for
    # TSCA Title VI, and Binh Phu Wood only has an EN 717-1 test on file.
    po2 = {c["requirementKey"]: c for c in orders["PO-2"]["checks"]}
    assert po2["formaldehyde"]["status"] == "mismatch"
    assert "TSCA Title VI" in po2["formaldehyde"]["note"]
    assert po2["tariff"]["status"] == "check"
    assert "inputs" not in po2  # only applies to HS 4412

    # A city that isn't a known port goes to the country centre, marked approximate.
    assert orders["PO-4"]["placement"]["market"] == "EU"
    assert orders["PO-4"]["placement"]["approximate"] is True
    # No supplier record: supplier evidence is unknown, never reported missing.
    supplier_checks = [c for c in orders["PO-4"]["checks"] if c["level"] == "supplier"]
    assert {c["status"] for c in supplier_checks} == {"unknown"}
    assert orders["PO-4"]["gapCount"] == 0

    # A country outside the map's markets isn't placed or checked.
    assert orders["PO-5"]["placement"]["location"] is None
    assert orders["PO-5"]["checks"] == []


def test_suppliers_sites_and_observations(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)
    data = get_map(client, headers)

    suppliers = {s["name"]: s for s in data["suppliers"]}
    assert suppliers["Binh Phu Wood"]["orderIds"] == ["PO-1", "PO-2"]
    assert suppliers["Binh Phu Wood"]["location"] == {"latitude": 11.54, "longitude": 106.9}
    assert {d["kind"] for d in suppliers["Binh Phu Wood"]["documents"]} == {
        "legality",
        "species",
        "formaldehyde",
        "chain",
    }
    # On orders but not in the supplier list.
    assert suppliers["Dong Nai Veneer"]["id"] is None
    assert suppliers["Dong Nai Veneer"]["documents"] is None
    # In the supplier list without open orders.
    assert suppliers["Savannakhet Timber"]["orderIds"] == []

    assert [s["key"] for s in data["sites"] if s["isRouteOrigin"]] == ["factory"]
    assert data["homeCountryIds"] == ["418", "704"]  # Laos, Vietnam
    assert data["checkRadiusKm"] == 25

    nearby = {o["title"]: o["nearby"] for o in data["observations"]}
    assert nearby["Flooding on the Kon river floodplain"] == [
        {
            "type": "supplier",
            "ref": "Quy Nhon Forest Products",
            "name": "Quy Nhon Forest Products",
            "distanceKm": 1,
        },
        {"type": "site", "ref": "quy-nhon", "name": "Quy Nhon warehouse", "distanceKm": 14},
    ]
    extent = data["observations"][0]["extent"]
    assert extent["type"] == "Polygon"
    assert extent["coordinates"][0][0] == extent["coordinates"][0][-1]


def test_company_map_data_is_not_shared(client, reference):
    lan = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, lan, MAP_CSV)
    mai = onboard(client, "mai@example.com", company="Other Co")

    data = get_map(client, mai)
    assert data["orders"] == []
    assert data["suppliers"] == []
    assert data["sites"] == []
    assert all(o["nearby"] == [] for o in data["observations"])
    assert len(data["markets"]) == 8  # reference data is shared
    compare = "/api/v1/trade-map/compare?orderId=PO-1&market=US"
    assert client.get(compare, headers=mai).status_code == 404


def test_compare_markets(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)

    response = client.get("/api/v1/trade-map/compare?orderId=PO-1&market=us", headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert (result["fromMarket"], result["toMarket"]) == ("EU", "US")
    assert [i["title"] for i in result["reuse"]] == [
        "Timber legality evidence",
        "Species & harvest-country declaration",
    ]
    assert [(i["title"], i["tag"]) for i in result["reevaluate"]] == [
        ("Lacey Act declaration", "New"),
        ("Formaldehyde emission test", "Changes"),
        ("Core-veneer origin certification", "New"),
        ("Anti-dumping and countervailing duties on plywood", "New"),
        ("ISPM 15 wood packaging", "Prepare"),
    ]
    assert [i["title"] for i in result["unknown"]] == ["Buyer and contract terms", "Import duty"]
    assert result["dropped"] == [
        "Plot-level geolocation",
        "Due diligence data for the EU importer",
        "Proof of origin",
    ]

    def error_code(query: str) -> tuple[int, str]:
        r = client.get(f"/api/v1/trade-map/compare?{query}", headers=headers)
        return r.status_code, r.json()["error"]["code"]

    assert error_code("orderId=PO-1&market=EU") == (422, "same_market")
    assert error_code("orderId=PO-1&market=XX") == (422, "unknown_market")
    assert error_code("orderId=PO-404&market=US") == (404, "not_found")
    assert error_code("orderId=PO-1") == (422, "invalid_input")
    assert error_code("orderId=PO-1&market=US&shipDate=2027-01-01") == (422, "invalid_input")


def test_compare_ship_date_uses_checklist_dates(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)

    early = client.get(
        "/api/v1/trade-map/compare?orderId=PO-1&shipDate=2026-07-01", headers=headers
    )
    assert early.status_code == 200, early.text
    result = early.json()["data"]
    assert result["kind"] == "ship_date"
    assert (result["fromShipDate"], result["toShipDate"]) == ("2026-10-27", "2026-07-01")
    moved = {item["title"]: item["tag"] for item in result["reevaluate"]}
    assert moved["Formaldehyde emission test"] is None
    assert "Timber legality evidence" not in moved
    assert any(item["title"] == "Timber legality evidence" for item in result["reuse"])
    assert any(
        "Transit time" in item["note"] or item["title"] == "Arrival date"
        for item in result["unknown"]
    )

    later = client.get(
        "/api/v1/trade-map/compare?orderId=PO-2&shipDate=2027-02-01", headers=headers
    )
    assert later.status_code == 200, later.text
    changed = {item["title"]: item["tag"] for item in later.json()["data"]["reevaluate"]}
    assert changed["Section 232 tariff category"] == "Changes"
    same = client.get("/api/v1/trade-map/compare?orderId=PO-1&shipDate=2026-10-27", headers=headers)
    assert same.status_code == 422
    assert same.json()["error"]["code"] == "same_date"


def test_compare_route_names_what_to_recheck_and_not_a_freight_quote(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)

    via = client.get("/api/v1/trade-map/compare?orderId=PO-1&via=sg", headers=headers)
    assert via.status_code == 200, via.text
    result = via.json()["data"]
    assert result["kind"] == "route"
    assert (result["via"], result["viaName"]) == ("SG", "Singapore")
    assert result["distanceKm"] > 0
    assert [item["title"] for item in result["reevaluate"]] == ["Proof of origin"]
    assert any("not a voyage" in line for line in result["assumptions"])
    assert {item["title"] for item in result["unknown"]} >= {
        "Freight cost",
        "Sailing time",
        "Port congestion and insurance",
    }

    direct = client.get("/api/v1/trade-map/compare?orderId=PO-1&via=direct", headers=headers)
    assert direct.status_code == 200, direct.text
    assert direct.json()["data"]["reevaluate"] == []
    assert any(item["title"] == "Proof of origin" for item in direct.json()["data"]["reuse"])
    unknown = client.get("/api/v1/trade-map/compare?orderId=PO-1&via=XX", headers=headers)
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "unknown_route"


def test_checklists_follow_the_product_not_only_wood(client, reference):
    headers = onboard(client, "lan@example.com")
    import_orders(
        client,
        headers,
        "id,product,supplier,destination,value,shipDate,hsCode\n"
        'PO-F,Milk powder,Dairy Co,"Rotterdam, NL",8000,2026-11-02,0401.10\n'
        'PO-T,Cotton shirts,Textile Co,"Hamburg, DE",9000,2026-11-03,6109.10\n'
        'PO-E,Wireless handsets,Radio Co,"Rotterdam, NL",12000,2026-11-04,8517.12\n',
    )
    orders = orders_by_id(get_map(client, headers))
    food = {c["requirementKey"] for c in orders["PO-F"]["checks"]}
    textile = {c["requirementKey"] for c in orders["PO-T"]["checks"]}
    electronics = {c["requirementKey"] for c in orders["PO-E"]["checks"]}
    assert "food-trace" in food
    assert "legality" not in food and "geolocation" not in food
    assert "fibre-label" in textile and "food-trace" not in textile
    assert "rohs" in electronics and "fibre-label" not in electronics
    assert "ispm15" in food and "origin" in food


def test_market_requirements_cite_their_official_text(client, reference):
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, MAP_CSV)
    po1 = {c["requirementKey"]: c for c in orders_by_id(get_map(client, headers))["PO-1"]["checks"]}

    source = po1["geolocation"]["source"]
    assert source["regulationTitle"] == "EU Deforestation Regulation (EU) 2023/1115"
    assert source["officialId"] == "32023R1115"
    assert source["versionNumber"] == 1
    assert source["quote"].startswith("Article 9(1)(d): the geolocation of all plots of land")
    assert source["sourceUrl"].startswith("https://eur-lex.europa.eu/")
    # Every market requirement has a source, and a company can download the text it cites.
    assert all(c["source"]["quote"] for c in po1.values())
    file = client.get(f"/api/v1/regulation-documents/{source['documentId']}/file", headers=headers)
    assert file.status_code == 200
    assert file.headers["content-type"].startswith("text/html")


def test_reference_seed_is_idempotent(reference):
    with open_session() as db:
        again = seed_reference_data(db)
        total = db.scalar(select(func.count()).select_from(MarketRequirement))
    assert total == again["requirements"]


def test_checklist_lines_removed_from_the_seed_are_deleted(reference):
    with open_session() as db:
        origin = next(r for r in map_queries.list_market_requirements(db) if r.market_code == "SG")
        row = {c.name: getattr(origin, c.name) for c in MarketRequirement.__table__.columns}
        map_queries.replace_market_requirements(db, "SG", [row])
        db.commit()
        keys = [r.requirement_key for r in map_queries.list_market_requirements(db)]
        assert keys.count("ispm15") == 7  # removed from SG only
        sg = [
            r.requirement_key
            for r in map_queries.list_market_requirements(db)
            if r.market_code == "SG"
        ]
        assert sg == [origin.requirement_key]


def test_flood_distance_uses_polygon_and_excludes_holes():
    observation = SatelliteObservation(
        center_longitude=0,
        center_latitude=0,
        radius_km=100,
        extent={
            "type": "Polygon",
            "coordinates": [
                [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1], [-0.1, -0.1]],
                [[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01], [-0.01, -0.01]],
            ],
        },
    )
    # Inside the 100-km circle, but 11 km outside the actual mapped polygon.
    assert km_from_extent(observation, 0, 0.2) == pytest.approx(11.1195, abs=0.01)
    assert km_from_extent(observation, 0.05, 0.05) == 0
    assert km_from_extent(observation, 0, 0) == pytest.approx(1.11195, abs=0.01)
    # A point 25.3 km away must not enter the 25-km list due to integer rounding.
    far = Supplier(name="Beyond threshold", latitude=0, longitude=0.3275)
    near = Supplier(name="Just outside", latitude=0, longitude=0.1001)
    places = nearby_places(observation, [far, near], [], 25)
    assert [(p.name, p.distance_km) for p in places] == [("Just outside", 1)]


def test_flood_polygon_crosses_antimeridian():
    observation = SatelliteObservation(
        center_longitude=180,
        center_latitude=0,
        radius_km=100,
        extent={
            "type": "Polygon",
            "coordinates": [
                [
                    [179.9, -0.1],
                    [-179.9, -0.1],
                    [-179.9, 0.1],
                    [179.9, 0.1],
                    [179.9, -0.1],
                ]
            ],
        },
    )
    assert km_from_extent(observation, 0, -179.95) == 0
    assert km_from_extent(observation, 0, 179.8) == pytest.approx(11.1195, abs=0.01)
