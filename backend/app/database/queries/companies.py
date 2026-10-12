from sqlalchemy.orm import Session

from app.database.models import Company


def create_company(
    db: Session,
    *,
    name: str,
    business_role: str,
    origin: str,
    transit: list[str],
    destination: str,
    currency: str,
    description: str,
) -> Company:
    company = Company(
        name=name,
        business_role=business_role,
        origin=origin,
        transit=transit,
        destination=destination,
        currency=currency,
        description=description,
    )
    db.add(company)
    db.flush()
    return company
