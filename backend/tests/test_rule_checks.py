import pytest
from conftest import onboard

from app.database.session import open_session
from app.seed_reference_data import seed_reference_data
from app.services.rule_checks import RuleError, clean_conditions, describe_condition, rule_fires

MARKETS = {"EU", "US"}
KINDS = {"geolocation", "legality"}
FACTS = {
    "market": "EU",
    "supplier": "Binh Phu Wood",
    "hs_code": "9403.60",
    "order_value": {"USD": 4810000},
    "days_until_ship": 10,
    "missing_documents": ["geolocation"],
    "estimated_cost": {"USD": 490000},
}


def conditions(*items) -> list[dict]:
    return clean_conditions(
        [{"field": f, "op": o, "value": v} for f, o, v in items], MARKETS, KINDS
    )


@pytest.mark.parametrize(
    ("items", "fires"),
    [
        ([("estimated_cost", "greater_than", {"amountMinor": 200000, "currency": "USD"})], True),
        ([("estimated_cost", "greater_than", {"amountMinor": 200000, "currency": "EUR"})], False),
        (
            [
                ("supplier", "equals", "binh phu wood"),
                ("missing_documents", "is_not_empty", None),
                ("days_until_ship", "less_than", 21),
            ],
            True,
        ),
        ([("supplier", "equals", "An Cuong Wood"), ("days_until_ship", "less_than", 21)], False),
        ([("missing_documents", "contains", "geolocation")], True),
        ([("missing_documents", "not_contains", "geolocation")], False),
        ([("market", "equals", "eu"), ("hs_code", "starts_with", "9403")], True),
        ([("hs_code", "starts_with", "4412")], False),
    ],
)
def test_rule_fires(items, fires):
    assert rule_fires(conditions(*items), FACTS) is fires


def test_missing_facts_never_fire():
    rule = conditions(("days_until_ship", "less_than", 21))
    assert rule_fires(rule, {**FACTS, "days_until_ship": None}) is False


@pytest.mark.parametrize(
    ("item", "path"),
    [
        (("margin", "less_than", 8), "when.0.field"),
        (("days_until_ship", "contains", 3), "when.0.op"),
        (("days_until_ship", "less_than", "soon"), "when.0.value"),
        (("market", "equals", "Mars"), "when.0.value"),
        (("missing_documents", "contains", "passport"), "when.0.value"),
        (("estimated_cost", "greater_than", {"amountMinor": 1, "currency": "XYZ"}), "when.0.value"),
        (("hs_code", "starts_with", "furniture"), "when.0.value"),
    ],
)
def test_invalid_conditions_name_the_field(item, path):
    with pytest.raises(RuleError) as error:
        conditions(item)
    assert error.value.field == path


def test_describe_condition():
    money = conditions(
        ("estimated_cost", "greater_than", {"amountMinor": 200000, "currency": "usd"})
    )
    assert (
        describe_condition(money[0])
        == "Estimated cost of the problems (without duties) more than USD 2,000.00"
    )


def test_checked_rule_api(client):
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
    fields = client.get("/api/v1/playbook/fields", headers=headers).json()["data"]
    market = next(f for f in fields["fields"] if f["key"] == "market")
    assert {"value": "EU", "label": market["options"][0]["label"]} in market["options"]
    assert set(fields["actions"]) == {"flag", "owner_review", "block"}

    rule = {
        "text": "Problems over USD 2,000 go to the owner",
        "category": "Threshold",
        "when": [
            {
                "field": "estimated_cost",
                "op": "greater_than",
                "value": {"amountMinor": 200000, "currency": "USD"},
            }
        ],
        "then": {"action": "owner_review"},
    }
    created = client.post("/api/v1/playbook/rules", headers=headers, json=rule)
    assert created.status_code == 201, created.text
    assert created.json()["data"]["checked"] is True
    rule_id = created.json()["data"]["id"]

    bad = client.post(
        "/api/v1/playbook/rules",
        headers=headers,
        json={**rule, "when": [{"field": "margin", "op": "less_than", "value": 8}]},
    )
    assert bad.status_code == 422
    assert bad.json()["error"]["fieldErrors"] == {
        "when.0.field": "Unknown field. Use one of: market, supplier, hs_code, order_value, "
        "days_until_ship, missing_documents, estimated_cost"
    }
    half = client.post("/api/v1/playbook/rules", headers=headers, json={**rule, "then": None})
    assert half.status_code == 422

    # Making it stored only again, and the toggle keeping the conditions.
    toggled = client.patch(
        f"/api/v1/playbook/rules/{rule_id}", headers=headers, json={"enabled": False}
    ).json()["data"]
    assert toggled["checked"] is True and toggled["enabled"] is False
    stored = client.patch(
        f"/api/v1/playbook/rules/{rule_id}", headers=headers, json={"when": None, "then": None}
    ).json()["data"]
    assert stored["checked"] is False and stored["when"] is None
