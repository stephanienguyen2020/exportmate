import pytest
from conftest import add_member, auth_header, onboard

from app.core.context import CompanyContext
from app.database.models import Role
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import DEMO_PROFILE, seed_company_map_data, seed_company_profile
from app.seed_reference_data import seed_reference_data

PROFILE = {
    "description": "We make acacia plywood and garden furniture for EU buyers.",
    "products": "Plywood, garden chairs",
    "materials": "Plantation acacia (Vietnam)",
    "certifications": "FSC Mix, VNTLAS",
    "website": "binhduongwood.example",
    "foundedYear": 2009,
    "teamSize": "51-200",
}


def company_of(email: str):
    with open_session() as db:
        user = user_queries.get_user_by_firebase_uid(db, f"dev:{email}")
        membership, company = user_queries.get_user_company_membership(db, user.id)
        return user, membership, company


def test_profile_fields_round_trip(client):
    headers = onboard(client, "lan@example.com")
    before = client.get("/api/v1/me", headers=headers).json()["data"]["company"]
    assert before["description"] == "Plywood and wooden furniture maker in Binh Duong, Vietnam."

    response = client.patch("/api/v1/company", headers=headers, json=PROFILE)
    assert response.status_code == 200, response.text
    company = client.get("/api/v1/me", headers=headers).json()["data"]["company"]
    assert {k: company[k] for k in PROFILE} == {
        **PROFILE,
        "website": "https://binhduongwood.example",
    }
    assert company["updatedAt"] > before["updatedAt"]


def test_optional_fields_clear_and_required_ones_stay(client):
    headers = onboard(client, "lan@example.com")
    client.patch("/api/v1/company", headers=headers, json=PROFILE)

    cleared = client.patch(
        "/api/v1/company",
        headers=headers,
        json={"website": "", "foundedYear": None, "teamSize": None, "products": ""},
    )
    assert cleared.status_code == 200, cleared.text
    data = cleared.json()["data"]
    assert (data["website"], data["foundedYear"], data["teamSize"], data["products"]) == (
        None,
        None,
        None,
        "",
    )
    assert data["materials"] == PROFILE["materials"]  # untouched

    for body in ({"description": None}, {"description": "   "}, {"name": None}):
        response = client.patch("/api/v1/company", headers=headers, json=body)
        assert response.status_code == 422, body


@pytest.mark.parametrize(
    ("field", "value"),
    [("website", "not a web address"), ("foundedYear", 3000), ("teamSize", "huge")],
)
def test_profile_fields_are_validated(client, field, value):
    headers = onboard(client, "lan@example.com")
    response = client.patch("/api/v1/company", headers=headers, json={field: value})
    assert response.status_code == 422
    assert field in response.json()["error"]["fieldErrors"]


def test_onboarding_needs_a_description(client):
    response = client.post(
        "/api/v1/onboarding",
        headers=auth_header("lan@example.com"),
        json={
            "companyName": "Binh Duong Wood Co.",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "European Union",
            "description": "  ",
        },
    )
    assert response.status_code == 422
    assert "description" in response.json()["error"]["fieldErrors"]


def test_knowledge_has_profile_and_sites_for_the_callers_company_only(client):
    with open_session() as db:
        seed_reference_data(db)
    lan = onboard(client, "lan@example.com")
    client.patch("/api/v1/company", headers=lan, json=PROFILE)
    _, _, company = company_of("lan@example.com")
    with open_session() as db:
        seed_company_map_data(db, company.id)
    viewer = add_member(client, "lan@example.com", "vy@example.com", Role.viewer)
    other = onboard(client, "mai@example.com", company="Other Co")

    response = client.get("/api/v1/company/knowledge", headers=viewer)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["company"]["name"] == "Binh Duong Wood Co."
    assert data["company"]["certifications"] == "FSC Mix, VNTLAS"
    assert {"name": "Your factory", "kind": "factory", "place": "Thu Dau Mot, Binh Duong"} in data[
        "sites"
    ]

    theirs = client.get("/api/v1/company/knowledge", headers=other).json()["data"]
    assert theirs["company"]["name"] == "Other Co"
    assert theirs["sites"] == []

    no_company = client.get(
        "/api/v1/company/knowledge", headers=auth_header("new@example.com")
    ).json()
    assert no_company["error"]["code"] == "onboarding_required"


def test_demo_seed_fills_only_empty_profile_fields(client):
    headers = onboard(client, "lan@example.com")
    client.patch("/api/v1/company", headers=headers, json={"products": "Our own words"})
    user, membership, company = company_of("lan@example.com")
    with open_session() as db:
        ctx = CompanyContext(user=user, company=db.merge(company), role=membership.role)
        filled = seed_company_profile(db, ctx)
    assert "products" not in filled and "description" not in filled
    data = client.get("/api/v1/me", headers=headers).json()["data"]["company"]
    assert data["products"] == "Our own words"
    assert data["certifications"] == DEMO_PROFILE["certifications"]
    assert data["teamSize"] == DEMO_PROFILE["teamSize"]
    assert data["transit"] == DEMO_PROFILE["transit"]  # empty counts as unset
