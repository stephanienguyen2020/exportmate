import uuid
from collections.abc import Iterable

from sqlalchemy import delete, exists, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, aliased

from app.database.models import (
    CompanyCostSetting,
    CompanySite,
    CostDefault,
    Country,
    DocumentKind,
    Market,
    MarketRequirement,
    Port,
    RequirementStatus,
    SatelliteObservation,
    Supplier,
    SupplierDocument,
    SupplierDocumentUpload,
)

# --- Shared reference data


def list_markets(db: Session) -> list[Market]:
    return list(db.scalars(select(Market).order_by(Market.sort_order, Market.code)))


def get_market(db: Session, code: str) -> Market | None:
    return db.get(Market, code)


def get_country(db: Session, alpha2: str) -> Country | None:
    return db.get(Country, alpha2)


def list_countries(db: Session) -> list[Country]:
    return list(db.scalars(select(Country).order_by(Country.alpha2)))


def list_ports(db: Session) -> list[Port]:
    return list(db.scalars(select(Port).order_by(Port.name_key, Port.country_alpha2)))


def list_document_kinds(db: Session) -> list[DocumentKind]:
    return list(db.scalars(select(DocumentKind).order_by(DocumentKind.sort_order)))


def list_requirements_in_force(db: Session, company_id: uuid.UUID) -> list[MarketRequirement]:
    """What a company's orders are checked against: reviewed shared requirements and its own,
    leaving out a version while any of its requirements is still a draft."""
    draft = aliased(MarketRequirement)
    version_in_review = exists().where(
        draft.regulation_document_id == MarketRequirement.regulation_document_id,
        draft.status == RequirementStatus.draft,
    )
    return list(
        db.scalars(
            select(MarketRequirement)
            .where(
                MarketRequirement.status == RequirementStatus.reviewed,
                or_(
                    MarketRequirement.company_id.is_(None),
                    MarketRequirement.company_id == company_id,
                ),
                ~version_in_review,
            )
            .order_by(
                MarketRequirement.market_code,
                MarketRequirement.company_id.nulls_first(),
                MarketRequirement.sort_order,
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


def get_company_supplier(
    db: Session, company_id: uuid.UUID, supplier_id: uuid.UUID
) -> Supplier | None:
    return db.scalar(
        select(Supplier).where(Supplier.id == supplier_id, Supplier.company_id == company_id)
    )


def add_supplier(db: Session, supplier: Supplier) -> Supplier:
    db.add(supplier)
    db.flush()
    return supplier


def replace_supplier_documents(
    db: Session, supplier_id: uuid.UUID, documents: list[SupplierDocument]
) -> None:
    db.execute(delete(SupplierDocument).where(SupplierDocument.supplier_id == supplier_id))
    db.add_all(documents)
    db.flush()


def list_supplier_upload_paths(db: Session, supplier_id: uuid.UUID) -> list[str]:
    """Where the certificates uploaded for this supplier are in Cloud Storage."""
    return list(
        db.scalars(
            select(SupplierDocumentUpload.storage_path).where(
                SupplierDocumentUpload.supplier_id == supplier_id
            )
        )
    )


def delete_supplier(db: Session, supplier: Supplier) -> None:
    """Its documents go with it. Orders keep the supplier's name as text."""
    db.delete(supplier)
    db.flush()


def get_company_site(db: Session, company_id: uuid.UUID, site_id: uuid.UUID) -> CompanySite | None:
    return db.scalar(
        select(CompanySite).where(CompanySite.id == site_id, CompanySite.company_id == company_id)
    )


def list_company_site_keys(db: Session, company_id: uuid.UUID) -> set[str]:
    return set(db.scalars(select(CompanySite.site_key).where(CompanySite.company_id == company_id)))


def add_company_site(db: Session, site: CompanySite) -> CompanySite:
    db.add(site)
    db.flush()
    return site


def clear_route_origin(db: Session, company_id: uuid.UUID) -> None:
    db.execute(
        update(CompanySite)
        .where(CompanySite.company_id == company_id, CompanySite.is_route_origin.is_(True))
        .values(is_route_origin=False)
    )


def delete_company_site(db: Session, site: CompanySite) -> None:
    db.delete(site)
    db.flush()


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


def replace_shared_market_requirements(db: Session, market_code: str, rows: list[dict]) -> None:
    """The seed file is the whole shared checklist: rows no longer in it are removed. Companies'
    own requirements are never touched."""
    _upsert(
        db, MarketRequirement, rows, ["regulation_document_id", "market_code", "requirement_key"]
    )
    kept = [(r["regulation_document_id"], r["requirement_key"]) for r in rows]
    stale = delete(MarketRequirement).where(
        MarketRequirement.market_code == market_code, MarketRequirement.company_id.is_(None)
    )
    if kept:
        stale = stale.where(
            tuple_(
                MarketRequirement.regulation_document_id, MarketRequirement.requirement_key
            ).not_in(kept)
        )
    db.execute(stale)


def upsert_cost_defaults(db: Session, rows: list[dict]) -> None:
    _upsert(db, CostDefault, rows, ["key"])


def list_cost_defaults(db: Session) -> list[CostDefault]:
    return list(db.scalars(select(CostDefault).order_by(CostDefault.sort_order)))


def list_company_cost_settings(db: Session, company_id: uuid.UUID) -> list[CompanyCostSetting]:
    return list(
        db.scalars(select(CompanyCostSetting).where(CompanyCostSetting.company_id == company_id))
    )


def upsert_company_cost_setting(db: Session, row: dict) -> None:
    _upsert(db, CompanyCostSetting, [row], ["company_id", "key"])


def delete_company_cost_setting(db: Session, company_id: uuid.UUID, key: str) -> None:
    db.execute(
        delete(CompanyCostSetting).where(
            CompanyCostSetting.company_id == company_id, CompanyCostSetting.key == key
        )
    )


def upsert_satellite_observations(db: Session, rows: list[dict]) -> None:
    _upsert(db, SatelliteObservation, rows, ["source_ref"])


def upsert_supplier(db: Session, row: dict) -> uuid.UUID:
    stmt = insert(Supplier).values(row)
    updates = {c: stmt.excluded[c] for c in row if c not in ("company_id", "name_key", "id")}
    stmt = stmt.on_conflict_do_update(index_elements=["company_id", "name_key"], set_=updates)
    return db.scalar(stmt.returning(Supplier.id))


def upsert_supplier_document(db: Session, row: dict) -> uuid.UUID:
    """A supplier has one document per kind: a newer one replaces it."""
    stmt = insert(SupplierDocument).values(row)
    updates = {c: stmt.excluded[c] for c in row if c not in ("supplier_id", "kind", "id")}
    stmt = stmt.on_conflict_do_update(index_elements=["supplier_id", "kind"], set_=updates)
    return db.scalar(stmt.returning(SupplierDocument.id))


def upsert_supplier_documents(db: Session, rows: list[dict]) -> None:
    _upsert(db, SupplierDocument, rows, ["supplier_id", "kind"])


def upsert_company_sites(db: Session, rows: list[dict]) -> None:
    _upsert(db, CompanySite, rows, ["company_id", "site_key"])
