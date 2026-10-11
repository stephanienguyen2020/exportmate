"""Load the frontend's demo company, 12 orders and 3 playbook rules for one user.

Usage:  uv run python -m app.seed_demo_data --email lan@example.com
With AUTH_MODE=dev, sign in as that user with the token "dev:lan@example.com".
For a real Firebase user, pass --firebase-uid <uid> as well.

Order statuses copy the frontend demo (2 exposed, 10 clear). They are demo values,
not the result of an analysis. Running it again changes nothing.
"""

import argparse
from datetime import date

from app.core.context import CompanyContext
from app.database.models import Order, OrderStatus
from app.database.queries import orders as order_queries
from app.database.session import open_session
from app.schemas.account import OnboardingIn
from app.schemas.playbook import RuleIn
from app.services import accounts
from app.services import playbook as playbook_service

DEMO_COMPANY = OnboardingIn(
    company_name="Binh Duong Wood Co.",
    business_role="Manufacturer",
    origin="Vietnam",
    destination="European Union",
    currency="USD",
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


def seed_demo_data(email: str, firebase_uid: str) -> None:
    with open_session() as db:
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

        print(f"Company: {company.name} ({company.id})")
        print(f"Orders added: {len(new_orders)} (already there: {len(existing)})")
        print(f"Rules added: {0 if rules else len(DEMO_RULES)}")
        print(f"Sign in locally with: Authorization: Bearer dev:{email}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", default="lan@example.com")
    parser.add_argument("--firebase-uid", help="defaults to the dev-mode uid 'dev:<email>'")
    args = parser.parse_args()
    seed_demo_data(args.email, args.firebase_uid or f"dev:{args.email}")


if __name__ == "__main__":
    main()
