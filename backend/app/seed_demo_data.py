"""Load the frontend's demo company (with its About company profile), 12 orders, 3 playbook
rules and its trade-map data (suppliers with their documents, and the company's sites) for
one user.

Usage:  uv run python -m app.seed_demo_data --email lan@example.com
With AUTH_MODE=dev, sign in as that user with the token "dev:lan@example.com".
For a real Firebase user, pass --firebase-uid <uid> as well.

Order statuses copy the frontend demo (2 exposed, 10 clear). They are demo values,
not the result of an analysis. Shared reference data (markets, checklists, ...) is loaded
first. Running it again changes nothing.
"""

import argparse
import logging
import uuid
from datetime import date

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.logging import configure_logging
from app.database.models import Order, OrderStatus
from app.database.queries import orders as order_queries
from app.database.queries import trade_map as map_queries
from app.database.session import open_session
from app.schemas.account import CompanyUpdate, OnboardingIn
from app.schemas.playbook import RuleIn
from app.seed_data import load_seed_file
from app.seed_reference_data import seed_reference_data
from app.services import accounts
from app.services import playbook as playbook_service
from app.services.trade_map import supplier_name_key

log = logging.getLogger(__name__)

DEMO_PROFILE = load_seed_file("demo_company.json")["profile"]
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


def seed_company_map_data(db: Session, company_id: uuid.UUID) -> tuple[int, int]:
    """Suppliers (with their documents) and sites from seed_data/demo_company.json."""
    data = load_seed_file("demo_company.json")
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
            },
        )
        map_queries.upsert_supplier_documents(
            db,
            [
                {
                    "supplier_id": supplier_id,
                    "kind": doc["kind"],
                    "detail": doc["detail"],
                    "standards": doc.get("standards", []),
                }
                for doc in supplier["documents"]
            ],
        )
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


def seed_company_profile(db: Session, ctx: CompanyContext) -> list[str]:
    """Fills About company fields that are still empty; never overwrites what the user wrote."""
    profile = CompanyUpdate.model_validate(DEMO_PROFILE)
    missing = {
        field: value
        for field, value in profile.model_dump(exclude_unset=True).items()
        if not getattr(ctx.company, field)
    }
    if missing:
        accounts.update_company_profile(db, ctx, CompanyUpdate(**missing))
    return sorted(missing)


def seed_demo_data(email: str, firebase_uid: str) -> None:
    with open_session() as db:
        seed_reference_data(db)
        user = accounts.get_or_create_user(db, uid=firebase_uid, email=email, name="Ms. Lan")
        found = accounts.find_user_company_membership(db, user.id)
        if found:
            membership, company = found
        else:
            company, _ = accounts.onboard_user(db, user, DEMO_COMPANY)
            membership, company = accounts.find_user_company_membership(db, user.id)
        ctx = CompanyContext(user=user, company=company, role=membership.role)

        demo = build_demo_orders()
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
                value_minor=o["value"] * 100,
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
            for rule in DEMO_RULES:
                playbook_service.create_playbook_rule(db, ctx, rule)
        profile_fields = seed_company_profile(db, ctx)
        suppliers, sites = seed_company_map_data(db, company.id)
        log.info(
            "seed.demo_loaded",
            extra={
                "company_id": str(company.id),
                "orders_added": len(new_orders),
                "orders_existing": len(existing),
                "rules_added": 0 if rules else len(DEMO_RULES),
            },
        )

        print(f"Company: {company.name} ({company.id})")
        print(f"Orders added: {len(new_orders)} (already there: {len(existing)})")
        print(f"Rules added: {0 if rules else len(DEMO_RULES)}")
        print(f"Profile fields filled: {', '.join(profile_fields) or 'none (already set)'}")
        print(f"Trade map: {suppliers} suppliers, {sites} sites")
        print(f"Sign in locally with: Authorization: Bearer dev:{email}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", default="lan@example.com")
    parser.add_argument("--firebase-uid", help="defaults to the dev-mode uid 'dev:<email>'")
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    seed_demo_data(args.email, args.firebase_uid or f"dev:{args.email}")


if __name__ == "__main__":
    main()
