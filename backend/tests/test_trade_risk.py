from datetime import UTC, date, datetime, timedelta

import pytest
from conftest import auth_header, import_orders, onboard

from app.core import trade_risk_job
from app.database.models import Order, OrderTradePair, TradeCase, TradeRiskScore
from app.database.session import open_session
from app.seed_reference_data import seed_reference_data
from app.services import trade_risk as trade_risk_service

CSV = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,2026-10-27,4412.33\n'
    'PO-2,Kitchen cabinet set,Binh Phu Wood,"Long Beach, US",54300,2026-11-17,9403.40\n'
)
URL = "/api/v1/trade-risk"


@pytest.fixture
def backfills(monkeypatch) -> dict[str, list[list[str]]]:
    """What the job was started with: orders' new pairs (`--new`), or named pairs (`--pair`)."""
    started: dict[str, list[list[str]]] = {"new": [], "named": []}

    def record(kind):
        def start(pairs: list[str]) -> bool:
            if pairs:
                started[kind].append(pairs)
            return True

        return start

    monkeypatch.setattr(trade_risk_service, "start_new_order_pairs", record("new"))
    monkeypatch.setattr(trade_risk_service, "start_pairs", record("named"))
    return started


@pytest.fixture
def lan(client, backfills) -> dict:
    with open_session() as db:
        seed_reference_data(db)
    headers = onboard(client, "lan@example.com")  # origin: Vietnam
    import_orders(client, headers, CSV)
    return headers


def saved_pairs() -> dict[str, tuple]:
    with open_session() as db:
        rows = db.query(Order.external_id, OrderTradePair).join(
            OrderTradePair, OrderTradePair.order_id == Order.id
        )
        return {order_id: (p.market, p.exporter, p.hs6) for order_id, p in rows}


def add_score(market="EU", exporter="VN", hs6="441233", level="high", minutes_ago=0, **fields):
    with open_session() as db:
        db.add(
            TradeRiskScore(
                market=market,
                exporter=exporter,
                hs6=hs6,
                model_hs6=fields.pop("model_hs6", hs6),
                level=level,
                score=fields.pop("score", 0.02 if level != "no_data" else None),
                percentile=fields.pop("percentile", 0.995 if level != "no_data" else None),
                reasons=fields.pop(
                    "reasons",
                    [
                        {
                            "feature": "import_value_vs_last_year",
                            "text": "Imports grew 4.0× in a year",
                            "contribution": 0.8,
                        }
                    ],
                ),
                model_version="2026-11-24",
                data_from="2025-09",
                data_to="2026-08",
                data_source="comtrade",
                scored_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
                **fields,
            )
        )
        db.commit()


def add_case(case_id, market, exporter, hs6, opened, final=None, product="Plywood"):
    with open_session() as db:
        db.add(
            TradeCase(
                case_id=case_id,
                market=market,
                exporter=exporter,
                hs6=hs6,
                kind="AD",
                opened_on=opened,
                final_measure_on=final,
                product=product,
                source="ttbd",
            )
        )
        db.commit()


def get_order_risk(client, headers, order_id="PO-1") -> dict:
    response = client.get(f"{URL}/orders/{order_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_order_risk_reads_the_latest_score_for_the_eu_market(client, lan, backfills):
    add_score(level="medium", minutes_ago=60 * 24 * 30)
    add_score(level="high")
    risk = get_order_risk(client, lan)
    assert (risk["orderId"], risk["market"], risk["exporter"], risk["hs6"]) == (
        "PO-1",
        "EU",
        "VN",
        "441233",
    )
    assert risk["status"] == "scored" and risk["level"] == "high"
    assert risk["reasons"] == [
        {"feature": "import_value_vs_last_year", "text": "Imports grew 4.0× in a year"}
    ]
    assert (risk["dataFrom"], risk["dataTo"], risk["dataSource"]) == (
        "2025-09",
        "2026-08",
        "comtrade",
    )
    assert "Source: UN Comtrade" in risk["sources"]


def test_similar_cases_put_this_market_and_exporter_first(client, lan, backfills):
    add_score()
    add_case("OTHER-MARKET", "US", "VN", "441233", date(2025, 3, 1))
    add_case("SAME-MARKET-OTHER-EXPORTER", "EU", "CN", "441233", date(2024, 5, 1), date(2025, 1, 1))
    add_case("SAME-FLOW-OLD", "EU", "VN", "441233", date(2012, 6, 1))
    add_case("RELATED-PRODUCT", "EU", "ID", "441299", date(2026, 1, 1))
    add_case("UNRELATED", "EU", "VN", "940161", date(2026, 1, 1))
    cases = get_order_risk(client, lan)["similarCases"]
    assert [c["caseId"] for c in cases] == [
        "SAME-FLOW-OLD",
        "SAME-MARKET-OTHER-EXPORTER",
        "OTHER-MARKET",
    ]
    assert [c["outcome"] for c in cases] == ["no duty", "duty imposed", "pending"]


def test_an_import_saves_each_orders_pair_and_starts_the_job_for_new_ones(client, lan, backfills):
    assert saved_pairs() == {"PO-1": ("EU", "VN", "441233"), "PO-2": ("US", "VN", "940340")}
    assert backfills["new"] == [["EU:VN:441233", "US:VN:940340"]]


def test_a_pair_without_a_score_is_pending(client, lan, backfills):
    risk = get_order_risk(client, lan, "PO-2")
    assert (risk["status"], risk["market"], risk["hs6"]) == ("pending", "US", "940340")
    assert risk["backfillStarted"] is True


def test_editing_an_order_moves_its_pair_and_deleting_it_removes_it(client, lan, backfills):
    add_score(market="US", hs6="940340")
    edited = client.patch(
        "/api/v1/orders/PO-2", headers=lan, json={"destination": "Busan, KR", "hsCode": "9403.60"}
    )
    assert edited.status_code == 200, edited.text
    assert saved_pairs()["PO-2"] == ("KR", "VN", "940360")
    assert backfills["new"][-1] == ["KR:VN:940360"]
    assert client.delete("/api/v1/orders/PO-2", headers=lan).status_code == 200
    assert "PO-2" not in saved_pairs()


def test_an_order_whose_pair_is_unknown_has_no_row(client, backfills):
    with open_session() as db:
        seed_reference_data(db)
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, CSV.replace('"Long Beach, US"', "Somewhere"))
    assert set(saved_pairs()) == {"PO-1"}


def test_no_data_says_why(client, lan, backfills):
    add_score(level="no_data", note="Imports under $1M a year: too small for the model to score.")
    risk = get_order_risk(client, lan)
    assert risk["status"] == "no_data" and risk["level"] is None
    assert risk["note"].startswith("Imports under $1M")


def test_market_risk_for_a_what_if(client, lan, backfills):
    add_score(market="US", hs6="441233", level="low")
    response = client.get(URL, headers=lan, params={"destination": "US", "hsCode": "4412.33"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["level"] == "low"
    other = client.get(
        URL, headers=lan, params={"destination": "Lyon, FR", "hsCode": "441233", "exporter": "id"}
    )
    assert (other.json()["data"]["market"], other.json()["data"]["exporter"]) == ("EU", "ID")
    assert backfills["named"] == [["FR:ID:441233"]]
    bad = client.get(URL, headers=lan, params={"destination": "Somewhere", "hsCode": "441233"})
    assert bad.status_code == 422


def test_a_short_hs_code_has_no_data(client, lan, backfills):
    risk = client.get(URL, headers=lan, params={"destination": "US", "hsCode": "4412.3"}).json()
    assert risk["data"]["status"] == "no_data" and "6 digits" in risk["data"]["note"]
    assert backfills["named"] == []


def test_the_company_country_comes_from_its_sites_first(client, lan, backfills):
    with open_session() as db:
        db.execute(
            TradeRiskScore.__table__.insert().values(
                market="EU",
                exporter="TH",
                hs6="441233",
                level="low",
                reasons=[],
                model_version="2026-11-24",
            )
        )
        db.commit()
    created = client.post(
        "/api/v1/sites",
        headers=lan,
        json={
            "name": "Bangkok plant",
            "shortName": "Bangkok",
            "kind": "factory",
            "place": "Bangkok",
            "country": "TH",
            "location": {"latitude": 13.75, "longitude": 100.5},
            "isRouteOrigin": True,
        },
    )
    assert created.status_code in (200, 201), created.text
    assert get_order_risk(client, lan)["exporter"] == "TH"
    # Reading an order's risk brings its saved pair up to date.
    assert saved_pairs()["PO-1"] == ("EU", "TH", "441233")


def test_other_companies_orders_are_not_found(client, lan, backfills):
    other = onboard(client, "minh@example.com", "Other Co")
    assert client.get(f"{URL}/orders/PO-1", headers=other).status_code == 404
    assert (
        client.get(f"{URL}/orders/PO-1", headers=auth_header("nobody@example.com")).status_code
        == 403
    )


def test_the_job_starts_once_per_pair_in_ten_minutes(monkeypatch):
    started: list[list[str]] = []
    monkeypatch.setattr(trade_risk_job, "_started", {})
    monkeypatch.setattr(trade_risk_job, "_start", started.append)
    monkeypatch.setattr(
        trade_risk_job.threading,
        "Thread",
        lambda target, args, daemon: type("T", (), {"start": lambda self: target(*args)})(),
    )
    settings = trade_risk_job.get_settings()
    monkeypatch.setattr(settings, "trade_risk_job_command", "")
    monkeypatch.setattr(settings, "trade_risk_job", "")
    assert trade_risk_job.start_pairs(["US:VN:441233"]) is False
    monkeypatch.setattr(settings, "trade_risk_job", "projects/p/locations/l/jobs/j")
    assert trade_risk_job.start_pairs(["US:VN:441233"]) is True
    assert trade_risk_job.start_pairs(["US:VN:441233", "IN:VN:441192"]) is True
    assert trade_risk_job.start_new_order_pairs(["EU:VN:441233", "IN:VN:441192"]) is True
    assert started == [
        ["--pair", "US:VN:441233"],
        ["--pair", "IN:VN:441192"],
        ["--new"],
    ]
