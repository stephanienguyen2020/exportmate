from sqlalchemy.orm import Session

from app.database.models import Company


def create_company(
    db: Session, *, name: str, business_role: str, origin: str, destination: str, currency: str
) -> Company:
    company = Company(
        name=name,
        business_role=business_role,
        origin=origin,
        destination=destination,
        currency=currency,
    )
    db.add(company)
    db.flush()
    return company
