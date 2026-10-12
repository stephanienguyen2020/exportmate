import uuid
from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database.models import (
    CompanySite,
    Country,
    DocumentKind,
    Market,
    MarketRequirement,
    Port,
    SatelliteObservation,
    Supplier,
    SupplierDocument,
)

# --- Shared reference data


def list_markets(db: Session) -> list[Market]:
    return list(db.scalars(select(Market).order_by(Market.sort_order, Market.code)))


def get_market(db: Session, code: str) -> Market | None:
    return db.get(Market, code)


def list_countries(db: Session) -> list[Country]:
    return list(db.scalars(select(Country).order_by(Country.alpha2)))


def list_ports(db: Session) -> list[Port]:
    return list(db.scalars(select(Port).order_by(Port.name_key, Port.country_alpha2)))


def list_document_kinds(db: Session) -> list[DocumentKind]:
    return list(db.scalars(select(DocumentKind).order_by(DocumentKind.sort_order)))


def list_market_requirements(db: Session) -> list[MarketRequirement]:
    return list(
        db.scalars(
            select(MarketRequirement).order_by(
                MarketRequirement.market_code, MarketRequirement.sort_order
            )
        )
    )


def list_satellite_observations(db: Session, limit: int) -> list[SatelliteObservation]:
    return list(
        db.scalars(
            select(SatelliteObservation)
            .order_by(SatelliteObservation.observed_on.desc(), SatelliteObservation.source_ref)
            .limit(limit)
        )
    )


# --- One company's data


def list_company_suppliers(db: Session, company_id: uuid.UUID) -> list[Supplier]:
    return list(
        db.scalars(
            select(Supplier).where(Supplier.company_id == company_id).order_by(Supplier.name)
        )
    )


def get_supplier_by_name_key(db: Session, company_id: uuid.UUID, name_key: str) -> Supplier | None:
    return db.scalar(
        select(Supplier).where(Supplier.company_id == company_id, Supplier.name_key == name_key)
    )


def list_supplier_documents(
    db: Session, supplier_ids: Iterable[uuid.UUID]
) -> list[SupplierDocument]:
    ids = list(supplier_ids)
    if not ids:
        return []
    return list(
        db.scalars(
            select(SupplierDocument)
            .where(SupplierDocument.supplier_id.in_(ids))
            .order_by(SupplierDocument.supplier_id, SupplierDocument.kind)
        )
    )


def list_company_sites(db: Session, company_id: uuid.UUID) -> list[CompanySite]:
    return list(
        db.scalars(
            select(CompanySite)
            .where(CompanySite.company_id == company_id)
            .order_by(CompanySite.is_route_origin.desc(), CompanySite.name)
        )
    )


# --- Seed upserts (re-running a seed updates rows instead of duplicating them)


def _upsert(db: Session, model, rows: list[dict], key: list[str]) -> None:
    if not rows:
        return
    stmt = insert(model).values(rows)
    updates = {c: stmt.excluded[c] for c in rows[0] if c not in key and c != "id"}
    db.execute(stmt.on_conflict_do_update(index_elements=key, set_=updates))


def upsert_document_kinds(db: Session, rows: list[dict]) -> None:
    _upsert(db, DocumentKind, rows, ["kind"])


def upsert_markets(db: Session, rows: list[dict]) -> None:
    _upsert(db, Market, rows, ["code"])


def upsert_countries(db: Session, rows: list[dict]) -> None:
    _upsert(db, Country, rows, ["alpha2"])


def upsert_ports(db: Session, rows: list[dict]) -> None:
    _upsert(db, Port, rows, ["name_key", "country_alpha2"])


def replace_market_requirements(db: Session, market_code: str, rows: list[dict]) -> None:
    """The seed file is the whole checklist: keys no longer in it are removed."""
    _upsert(db, MarketRequirement, rows, ["market_code", "requirement_key"])
    db.execute(
        delete(MarketRequirement).where(
            MarketRequirement.market_code == market_code,
            MarketRequirement.requirement_key.not_in([r["requirement_key"] for r in rows]),
        )
    )


def upsert_satellite_observations(db: Session, rows: list[dict]) -> None:
    _upsert(db, SatelliteObservation, rows, ["source_ref"])


def upsert_supplier(db: Session, row: dict) -> uuid.UUID:
    stmt = insert(Supplier).values(row)
    updates = {c: stmt.excluded[c] for c in row if c not in ("company_id", "name_key", "id")}
    stmt = stmt.on_conflict_do_update(index_elements=["company_id", "name_key"], set_=updates)
    return db.scalar(stmt.returning(Supplier.id))


def upsert_supplier_documents(db: Session, rows: list[dict]) -> None:
    _upsert(db, SupplierDocument, rows, ["supplier_id", "kind"])


def upsert_company_sites(db: Session, rows: list[dict]) -> None:
    _upsert(db, CompanySite, rows, ["company_id", "site_key"])
