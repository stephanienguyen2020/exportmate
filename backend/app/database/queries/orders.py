import uuid
from collections.abc import Iterable
from datetime import date

from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database.models import (
    ImportRow,
    Order,
    OrderStatus,
    OrderStatusChange,
    OrderStatusDefinition,
    User,
)


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _order_filters(company_id: uuid.UUID, status: OrderStatus | None, q: str | None) -> list:
    where = [Order.company_id == company_id]
    if status:
        where.append(Order.status == status)
    if q:
        pattern = f"%{_escape_like(q.strip())}%"
        where.append(
            or_(
                *(
                    col.ilike(pattern, escape="\\")
                    for col in (
                        Order.external_id,
                        Order.product,
                        Order.supplier,
                        Order.destination,
                        Order.hs_code,
                    )
                )
            )
        )
    return where


def list_orders_page(
    db: Session,
    company_id: uuid.UUID,
    *,
    status: OrderStatus | None,
    q: str | None,
    after: tuple[date, str] | None,
    limit: int,
) -> tuple[list[Order], int]:
    """Orders sorted by (ship date, order id). `after` is the last (ship date, id) seen."""
    where = _order_filters(company_id, status, q)
    total = db.scalar(select(func.count()).select_from(Order).where(*where)) or 0
    stmt = select(Order).where(*where)
    if after:
        stmt = stmt.where(tuple_(Order.ship_date, Order.external_id) > tuple_(*after))
    rows = db.scalars(stmt.order_by(Order.ship_date, Order.external_id).limit(limit)).all()
    return list(rows), total


def list_company_orders(db: Session, company_id: uuid.UUID) -> list[Order]:
    """Every order of one company, by ship date. For views that need them all (the map)."""
    return list(
        db.scalars(
            select(Order)
            .where(Order.company_id == company_id)
            .order_by(Order.ship_date, Order.external_id)
        )
    )


def get_order_by_external_id(
    db: Session, company_id: uuid.UUID, external_id: str, *, lock: bool = False
) -> Order | None:
    """`lock` holds the row until commit, so two status changes can't both read the old one."""
    stmt = select(Order).where(Order.company_id == company_id, Order.external_id == external_id)
    return db.scalar(stmt.with_for_update() if lock else stmt)


def lock_orders_by_external_ids(
    db: Session, company_id: uuid.UUID, external_ids: list[str]
) -> list[Order]:
    """The company's orders with these ids, held until commit. Locked in one fixed order so two
    changes over overlapping orders wait for each other instead of deadlocking."""
    return list(
        db.scalars(
            select(Order)
            .where(Order.company_id == company_id, Order.external_id.in_(external_ids))
            .order_by(Order.id)
            .with_for_update()
        )
    )


def get_import_row(db: Session, row_id: uuid.UUID) -> ImportRow | None:
    return db.get(ImportRow, row_id)


def find_existing_external_ids(db: Session, company_id: uuid.UUID, ids: Iterable[str]) -> set[str]:
    ids = list(ids)
    if not ids:
        return set()
    return set(
        db.scalars(
            select(Order.external_id).where(
                Order.company_id == company_id, Order.external_id.in_(ids)
            )
        )
    )


def add_orders(db: Session, orders: list[Order]) -> None:
    db.add_all(orders)
    db.flush()


def delete_order(db: Session, order: Order) -> None:
    """Its status history, analysis reports (with their supplier messages and solution uses),
    HS code suggestions, saved what-ifs and news reviews go with it (ON DELETE CASCADE)."""
    db.delete(order)
    db.flush()


def count_orders_by_status(db: Session, company_id: uuid.UUID) -> dict[str, int]:
    rows = db.execute(
        select(Order.status, func.count())
        .where(Order.company_id == company_id)
        .group_by(Order.status)
    ).all()
    return {status.value: count for status, count in rows}


def sum_order_value_by_currency(
    db: Session, company_id: uuid.UUID, status: OrderStatus
) -> dict[str, int]:
    rows = db.execute(
        select(Order.currency, func.sum(Order.value_minor))
        .where(Order.company_id == company_id, Order.status == status)
        .group_by(Order.currency)
    ).all()
    return {currency: int(total) for currency, total in rows}


def find_nearest_ship_date(
    db: Session, company_id: uuid.UUID, status: OrderStatus, on_or_after: date
) -> date | None:
    return db.scalar(
        select(func.min(Order.ship_date)).where(
            Order.company_id == company_id,
            Order.status == status,
            Order.ship_date >= on_or_after,
        )
    )


def list_orders_by_external_ids(
    db: Session, company_id: uuid.UUID, external_ids: Iterable[str]
) -> list[Order]:
    return list(
        db.scalars(
            select(Order)
            .where(Order.company_id == company_id, Order.external_id.in_(list(external_ids)))
            .order_by(Order.ship_date, Order.external_id)
        )
    )


def list_import_row_positions(
    db: Session, row_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[uuid.UUID, int]]:
    """{import row id: (import id, row number)}, so reports can cite "import X, row N"."""
    ids = list(row_ids)
    if not ids:
        return {}
    rows = db.execute(
        select(ImportRow.id, ImportRow.import_id, ImportRow.row_number).where(ImportRow.id.in_(ids))
    ).all()
    return {row_id: (import_id, row_number) for row_id, import_id, row_number in rows}


def upsert_order_statuses(db: Session, rows: list[dict]) -> None:
    if not rows:
        return
    stmt = insert(OrderStatusDefinition).values(rows)
    updates = {c: stmt.excluded[c] for c in rows[0] if c != "code"}
    db.execute(stmt.on_conflict_do_update(index_elements=["code"], set_=updates))


def list_order_statuses(db: Session) -> list[OrderStatusDefinition]:
    return list(
        db.scalars(select(OrderStatusDefinition).order_by(OrderStatusDefinition.sort_order))
    )


def get_order_status_definition(db: Session, code: OrderStatus) -> OrderStatusDefinition | None:
    return db.get(OrderStatusDefinition, code)


def add_status_changes(db: Session, changes: list[OrderStatusChange]) -> None:
    db.add_all(changes)
    db.flush()


def list_order_status_changes(
    db: Session, order_id: uuid.UUID
) -> list[tuple[OrderStatusChange, User]]:
    """Newest first, each with the person who made it (or started the run that did)."""
    rows = db.execute(
        select(OrderStatusChange, User)
        .join(User, OrderStatusChange.changed_by == User.id)
        .where(OrderStatusChange.order_id == order_id)
        .order_by(OrderStatusChange.changed_at.desc(), OrderStatusChange.id.desc())
    ).all()
    return [(change, user) for change, user in rows]
