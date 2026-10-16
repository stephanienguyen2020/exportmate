"""Load a demo company (with its About company profile), its orders, playbook rules and
trade-map data (suppliers with their documents and sourcing, and the company's sites) for one
user.

Usage:  uv run python -m app.seed_demo_data --email lan@example.com
        uv run python -m app.seed_demo_data --company us-furniture --email minh@example.com
With AUTH_MODE=dev, sign in as that user with the token "dev:lan@example.com".
For a real Firebase user, pass --firebase-uid <uid> as well.

Companies: `binh-duong` (default) is the frontend's demo, 12 orders to the EU and Asia whose
statuses copy the frontend (2 exposed, 10 clear). `us-furniture` is Vietnam Google AI Builder
Furniture, 16 furniture orders from Vietnam to US ports (seed_data/us_furniture_company.json).
Statuses are demo values, not the result of an analysis. A user belongs to one company, so
each company needs its own email. Shared reference data (markets, checklists, ...) is loaded
first. Running it again changes nothing.
"""

import argparse
import logging
import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.logging import configure_logging
from app.database.models import Order, OrderStatus
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import orders as order_queries
from app.database.queries import trade_map as map_queries
from app.database.session import open_session
from app.knowledge_graph import load_graph_file
from app.schemas.account import CompanyUpdate, OnboardingIn
from app.schemas.playbook import RuleIn
from app.seed_data import load_seed_file
from app.seed_reference_data import seed_reference_data
from app.services import accounts
from app.services import playbook as playbook_service
from app.services.trade_map import supplier_name_key

log = logging.getLogger(__name__)

DEMO_SEED_FILE = "demo_company.json"
US_FURNITURE_SEED_FILE = "us_furniture_company.json"
DEMO_PROFILE = load_seed_file(DEMO_SEED_FILE)["profile"]
DEMO_COMPANY = OnboardingIn(
    company_name="Binh Duong Wood Co.",
    business_role="Manufacturer",
    origin="Vietnam",
    destination="European Union",
    currency="USD",
    description=DEMO_PROFILE["description"],
)

DEMO_RULES = [
    RuleIn(text="Flag any order where the projected margin drops below 8%.", category="Threshold"),
    RuleIn(
        text="Never ship an order without its required certificate of origin.", category="Policy"
    ),
    RuleIn(
        text="Allow Binh Phu Wood 3 weeks to provide any new documentation.", category="Supplier"
    ),
]

_OTHER_DESTINATIONS = [
    "Singapore, SG",
    "Osaka, JP",
    "Antwerp, BE",
    "Singapore, SG",
    "Busan, KR",
    "Rotterdam, NL",
    "Tokyo, JP",
    "Singapore, SG",
    "Hamburg, DE",
    "Osaka, JP",
]


def build_demo_orders() -> list[dict]:
    orders = [
        {
            "external_id": "PO-2291",
            "product": "Acacia plywood · 18 mm",
            "supplier": "Binh Phu Wood",
            "destination": "Rotterdam, NL",
            "value": 24000,
            "ship_date": date(2026, 10, 27),
            "hs_code": "4412.33",
            "status": OrderStatus.exposed,
        },
        {
            "external_id": "PO-2304",
            "product": "Acacia plywood · 12 mm",
            "supplier": "Binh Phu Wood",
            "destination": "Hamburg, DE",
            "value": 18000,
            "ship_date": date(2026, 10, 30),
            "hs_code": "4412.33",
            "status": OrderStatus.exposed,
        },
    ]
    for i, destination in enumerate(_OTHER_DESTINATIONS):
        odd = i % 2 == 1
        orders.append(
            {
                "external_id": f"PO-{2310 + i}",
                "product": "Birch plywood · 12 mm" if odd else "Rubberwood panels · 20 mm",
                "supplier": "Mekong Timber" if odd else "An Cuong Wood",
                "destination": destination,
                "value": 12000 + i * 1500,
                "ship_date": date(2026, 11, i + 2),
                "hs_code": "4412.32" if odd else "4418.99",
                "status": OrderStatus.clear,
            }
        )
    return orders


@dataclass(frozen=True)
class DemoCompanySeed:
    seed_file: str
    owner_name: str
    onboarding: OnboardingIn
    profile: dict
    orders: list[dict]
    rules: list[RuleIn]


def build_seed_file_orders(data: dict) -> list[dict]:
    return [
        {
            "external_id": o["id"],
            "product": o["product"],
            "supplier": o["supplier"],
            "destination": o["destination"],
            "value": o["value"],
            "ship_date": date.fromisoformat(o["shipDate"]),
            "hs_code": o["hsCode"],
            "status": OrderStatus(o["status"]),
        }
        for o in data["orders"]
    ]


def load_demo_company_seed(company_key: str) -> DemoCompanySeed:
    if company_key == "us-furniture":
        data = load_seed_file(US_FURNITURE_SEED_FILE)
        return DemoCompanySeed(
            seed_file=US_FURNITURE_SEED_FILE,
            owner_name=data["owner"],
            onboarding=OnboardingIn.model_validate(data["company"]),
            profile=data["profile"],
            orders=build_seed_file_orders(data),
            rules=[RuleIn.model_validate(rule) for rule in data["rules"]],
        )
    return DemoCompanySeed(
        seed_file=DEMO_SEED_FILE,
        owner_name="Ms. Lan",
        onboarding=DEMO_COMPANY,
        profile=DEMO_PROFILE,
        orders=build_demo_orders(),
        rules=DEMO_RULES,
    )


def seed_company_map_data(
    db: Session, company_id: uuid.UUID, seed_file: str = DEMO_SEED_FILE
) -> tuple[int, int]:
    """Suppliers (with their documents and sourcing) and sites from a seed file in seed_data/."""
    data = load_seed_file(seed_file)
    industry_of_material = {
        m["key"]: m["industry"] for m in load_graph_file("material_chain.json")["materials"]
    }
    for supplier in data["suppliers"]:
        supplier_id = map_queries.upsert_supplier(
            db,
            {
                "company_id": company_id,
                "name": supplier["name"],
                "name_key": supplier_name_key(supplier["name"]),
                "place": supplier["place"],
                "country_alpha2": supplier["country"],
                "longitude": supplier["at"][0],
                "latitude": supplier["at"][1],
                "supplies": supplier["supplies"],
                "contact_name": supplier.get("contactName"),
                "contact_email": supplier.get("contactEmail"),
            },
        )
        graph_queries.replace_supplier_sourcing(
            db,
            supplier_id,
            [
                {
                    "supplier_id": supplier_id,
                    "material_key": f"material.{s['material']}",
                    "country_alpha2": s["country"],
                    "form_key": f"{industry_of_material[s['material']]}.{s['form']}"
                    if s.get("form")
                    else None,
                    "basis": s["basis"],
                }
                for s in supplier.get("sourcing", [])
            ],
        )
        # One call per document: a multi-row upsert needs the same columns in every row, and
        # issuer, number and expiry are only written when the seed file gives them.
        for doc in supplier["documents"]:
            row = {
                "supplier_id": supplier_id,
                "kind": doc["kind"],
                "detail": doc["detail"],
                "standards": doc.get("standards", []),
            }
            if "issuer" in doc:
                row["issuer"] = doc["issuer"]
            if "documentNumber" in doc:
                row["document_number"] = doc["documentNumber"]
            if "expiresOn" in doc:
                row["expires_on"] = date.fromisoformat(doc["expiresOn"])
            map_queries.upsert_supplier_documents(db, [row])
    map_queries.upsert_company_sites(
        db,
        [
            {
                "company_id": company_id,
                "site_key": site["key"],
                "kind": site["kind"],
                "name": site["name"],
                "short_name": site["shortName"],
                "place": site["place"],
                "country_alpha2": site["country"],
                "longitude": site["at"][0],
                "latitude": site["at"][1],
                "note": site["note"],
                "is_route_origin": site.get("isRouteOrigin", False),
            }
            for site in data["sites"]
        ],
    )
    db.commit()
    counts = (len(data["suppliers"]), len(data["sites"]))
    log.info(
        "seed.company_map_loaded",
        extra={"company_id": str(company_id), "suppliers": counts[0], "sites": counts[1]},
    )
    return counts


def seed_company_profile(
    db: Session, ctx: CompanyContext, profile_data: dict = DEMO_PROFILE
) -> list[str]:
    """Fills About company fields that are still empty; never overwrites what the user wrote."""
    profile = CompanyUpdate.model_validate(profile_data)
    missing = {
        field: value
        for field, value in profile.model_dump(exclude_unset=True).items()
        if not getattr(ctx.company, field)
    }
    if missing:
        accounts.update_company_profile(db, ctx, CompanyUpdate(**missing))
    return sorted(missing)


def seed_demo_data(email: str, firebase_uid: str, company_key: str = "binh-duong") -> None:
    seed = load_demo_company_seed(company_key)
    with open_session() as db:
        seed_reference_data(db)
        user = accounts.get_or_create_user(db, uid=firebase_uid, email=email, name=seed.owner_name)
        found = accounts.find_user_company_membership(db, user.id)
        if found:
            membership, company = found
        else:
            company, _ = accounts.onboard_user(db, user, seed.onboarding)
            membership, company = accounts.find_user_company_membership(db, user.id)
        if company.name != seed.onboarding.company_name:
            raise SystemExit(
                f"{email} already belongs to {company.name}. "
                f"Use another --email for {seed.onboarding.company_name}."
            )
        ctx = CompanyContext(user=user, company=company, role=membership.role)

        demo = seed.orders
        existing = order_queries.find_existing_external_ids(
            db, company.id, [o["external_id"] for o in demo]
        )
        new_orders = [
            Order(
                company_id=company.id,
                external_id=o["external_id"],
                product=o["product"],
                supplier=o["supplier"],
                destination=o["destination"],
                value_minor=round(o["value"] * 100),
                currency=company.currency,
                ship_date=o["ship_date"],
                hs_code=o["hs_code"],
                status=o["status"],
            )
            for o in demo
            if o["external_id"] not in existing
        ]
        order_queries.add_orders(db, new_orders)
        db.commit()

        rules, _ = playbook_service.list_playbook_rules(db, ctx)
        if not rules:
            for rule in seed.rules:
                playbook_service.create_playbook_rule(db, ctx, rule)
        profile_fields = seed_company_profile(db, ctx, seed.profile)
        suppliers, sites = seed_company_map_data(db, company.id, seed.seed_file)
        log.info(
            "seed.demo_loaded",
            extra={
                "company_id": str(company.id),
                "orders_added": len(new_orders),
                "orders_existing": len(existing),
                "rules_added": 0 if rules else len(seed.rules),
            },
        )

        print(f"Company: {company.name} ({company.id})")
        print(f"Orders added: {len(new_orders)} (already there: {len(existing)})")
        print(f"Rules added: {0 if rules else len(seed.rules)}")
        print(f"Profile fields filled: {', '.join(profile_fields) or 'none (already set)'}")
        print(f"Trade map: {suppliers} suppliers, {sites} sites")
        print(f"Sign in locally with: Authorization: Bearer dev:{email}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", default="lan@example.com")
    parser.add_argument(
        "--company",
        choices=["binh-duong", "us-furniture"],
        default="binh-duong",
        help="us-furniture: Vietnam Google AI Builder Furniture, Vietnam to the US",
    )
    parser.add_argument("--firebase-uid", help="defaults to the dev-mode uid 'dev:<email>'")
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    seed_demo_data(args.email, args.firebase_uid or f"dev:{args.email}", args.company)


if __name__ == "__main__":
    main()
