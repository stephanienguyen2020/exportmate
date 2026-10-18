"""Graph change events: after each commit, what changed that the Neo4j read model copies (the
architecture's "Postgres → Pub/Sub change events"). The shared chain (graph_nodes, graph_edges,
graph_link_weights) or a company's suppliers, their sourcing and its orders. Seen from the ORM
objects a flush writes and from bulk statements; a bulk write that names its supplier only in
its rows says so with `note_supplier_changed`. What is done with a change (published to Pub/Sub
or synced in-process) is the handler's business (services/graph_events.py)."""

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import event
from sqlalchemy.orm import ORMExecuteState, Session

from app.database.models import (
    GraphEdge,
    GraphLinkWeight,
    GraphNode,
    Order,
    Supplier,
    SupplierSourcing,
)

log = logging.getLogger(__name__)

CHAIN_TABLES = {"graph_nodes", "graph_edges", "graph_link_weights"}
# Bulk writes to these name no company we can read here; supplier_sourcing's say so themselves.
COMPANY_TABLES = {"orders", "suppliers"}
PENDING = "graph_change"


@dataclass
class GraphChange:
    chain: bool = False
    company_ids: set[uuid.UUID] = field(default_factory=set)
    supplier_ids: set[uuid.UUID] = field(default_factory=set)
    every_company: bool = False

    def __bool__(self) -> bool:
        return self.chain or self.every_company or bool(self.company_ids or self.supplier_ids)


_handler: Callable[[GraphChange], None] | None = None


def set_change_handler(handler: Callable[[GraphChange], None] | None) -> None:
    global _handler
    _handler = handler


def _pending(session: Session) -> GraphChange:
    return session.info.setdefault(PENDING, GraphChange())


def note_supplier_changed(db: Session, supplier_id: uuid.UUID) -> None:
    _pending(db).supplier_ids.add(supplier_id)


@event.listens_for(Session, "after_flush")
def _collect_flushed(session: Session, flush_context) -> None:
    change = _pending(session)
    for obj in (*session.new, *session.dirty, *session.deleted):
        if isinstance(obj, GraphNode | GraphEdge | GraphLinkWeight):
            change.chain = True
        elif isinstance(obj, Order | Supplier):
            change.company_ids.add(obj.company_id)
        elif isinstance(obj, SupplierSourcing):
            change.supplier_ids.add(obj.supplier_id)


@event.listens_for(Session, "do_orm_execute")
def _collect_bulk(state: ORMExecuteState) -> None:
    if not (state.is_insert or state.is_update or state.is_delete):
        return
    table = getattr(getattr(state.statement, "table", None), "name", None)
    if table in CHAIN_TABLES:
        _pending(state.session).chain = True
    elif table in COMPANY_TABLES:
        _pending(state.session).every_company = True


@event.listens_for(Session, "after_commit")
def _hand_over(session: Session) -> None:
    change = session.info.pop(PENDING, None)
    if not change or _handler is None:
        return
    try:
        _handler(change)
    except Exception:  # the commit stands; the nightly full sync catches up
        log.exception("graph.change_not_handled")


@event.listens_for(Session, "after_rollback")
def _forget(session: Session) -> None:
    session.info.pop(PENDING, None)
