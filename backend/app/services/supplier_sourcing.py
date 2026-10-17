"""Which materials a supplier buys, from which country and in what form.

The knowledge graph walks from news about a material or a country to the suppliers that buy
it, then along the material chain to their orders (services/knowledge_graph.py). Editors enter
sourcing with the supplier in the trade map; keys are the graph's own ("acacia", "roundwood"),
without the node prefixes ("material.", "wood.").
"""

import uuid
from collections import defaultdict

from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.database.models import GraphNode, GraphNodeKind
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import trade_map as map_queries
from app.schemas.supplier_documents import ReadMaterial, SuggestedSourcing
from app.schemas.trade_map import (
    SourcingFormOut,
    SourcingMaterialOut,
    SupplierSourcingIn,
    SupplierSourcingOut,
)
from app.services.graph_words import named_nodes

MATERIAL_PREFIX = "material."
ENTERED_BASIS = "Entered on the trade map"


def _material_key(node_key: str) -> str:
    return node_key.removeprefix(MATERIAL_PREFIX)


def _form_key(node_key: str) -> str:
    return node_key.split(".", 1)[1]


def _hs_code(prefix: str) -> str:
    return f"{prefix[:4]}.{prefix[4:]}" if len(prefix) > 4 else prefix


def sourcing_options(db: Session) -> list[SourcingMaterialOut]:
    """Every material sourcing can name, with the chain steps of its industry."""
    nodes = graph_queries.list_graph_nodes(db)
    forms_by_industry: dict[str | None, list[SourcingFormOut]] = defaultdict(list)
    for node in nodes:
        if node.kind == GraphNodeKind.product:
            forms_by_industry[node.industry].append(
                SourcingFormOut(
                    key=_form_key(node.key),
                    name=node.name,
                    hs_codes=[_hs_code(p) for p in node.hs_prefixes],
                )
            )
    return sorted(
        (
            SourcingMaterialOut(
                key=_material_key(node.key),
                name=node.name,
                industry=node.industry,
                forms=forms_by_industry[node.industry],
            )
            for node in nodes
            if node.kind == GraphNodeKind.material
        ),
        key=lambda m: m.name,
    )


def sourcing_by_supplier(
    db: Session, supplier_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[SupplierSourcingOut]]:
    names = {n.key: n.name for n in graph_queries.list_graph_nodes(db)}
    found: dict[uuid.UUID, list[SupplierSourcingOut]] = defaultdict(list)
    for row in graph_queries.list_supplier_sourcing(db, supplier_ids):
        found[row.supplier_id].append(
            SupplierSourcingOut(
                material=_material_key(row.material_key),
                material_name=names.get(row.material_key, row.material_key),
                country=row.country_alpha2,
                form=_form_key(row.form_key) if row.form_key else None,
                form_name=names.get(row.form_key) if row.form_key else None,
                basis=row.basis,
            )
        )
    return found


def _invalid(message: str) -> AppError:
    return AppError(422, "invalid_input", "Some fields are invalid.", {"sourcing": message})


def save_sourcing(db: Session, supplier_id: uuid.UUID, sourcing: list[SupplierSourcingIn]) -> None:
    """Replace the supplier's sourcing, after checking each line names a known material, a
    country on the map and, if given, a step of that material's chain."""
    materials: dict[str, GraphNode] = {
        _material_key(n.key): n for n in graph_queries.list_graph_nodes(db, GraphNodeKind.material)
    }
    products = {n.key for n in graph_queries.list_graph_nodes(db, GraphNodeKind.product)}
    countries = {c.alpha2 for c in map_queries.list_countries(db)}
    rows = []
    for line in sourcing:
        material = materials.get(line.material)
        if material is None:
            raise _invalid(f"Unknown material: {line.material}")
        if line.country not in countries:
            raise _invalid(f"Not a country on the map: {line.country}")
        form_key = f"{material.industry}.{line.form}" if line.form else None
        if form_key and form_key not in products:
            raise _invalid(f"{material.name} can't be bought as {line.form}")
        rows.append(
            {
                "supplier_id": supplier_id,
                "material_key": material.key,
                "country_alpha2": line.country,
                "form_key": form_key,
                "basis": line.basis or ENTERED_BASIS,
            }
        )
    graph_queries.replace_supplier_sourcing(db, supplier_id, rows)


def add_sourcing(db: Session, supplier_id: uuid.UUID, lines: list[SupplierSourcingIn]) -> None:
    """Add lines to the supplier's sourcing, keeping what it has; a material and country it
    already lists keeps its line."""
    kept = [
        SupplierSourcingIn(
            material=_material_key(row.material_key),
            country=row.country_alpha2,
            form=_form_key(row.form_key) if row.form_key else None,
            basis=row.basis,
        )
        for row in graph_queries.list_supplier_sourcing(db, [supplier_id])
    ]
    known = {(line.material, line.country) for line in kept}
    save_sourcing(
        db,
        supplier_id,
        kept + [line for line in lines if (line.material, line.country) not in known],
    )


def suggest_sourcing(db: Session, materials: list[ReadMaterial]) -> list[SuggestedSourcing]:
    """The materials AI read from a document that the knowledge graph knows, with a country on
    the map and a form of that material's chain when the document names them. Others are
    dropped: a person adds them by hand if they matter."""
    material_nodes = graph_queries.list_graph_nodes(db, GraphNodeKind.material)
    products = graph_queries.list_graph_nodes(db, GraphNodeKind.product)
    countries = {c.alpha2 for c in map_queries.list_countries(db)}
    found: dict[tuple[str, str | None], SuggestedSourcing] = {}
    for read in materials[:20]:
        name = (read.name or "").strip()[:100]
        matched = named_nodes((name,), material_nodes)
        if not matched:
            continue
        material = matched[0]
        country = (read.country or "").strip().upper()[:2] or None
        if country == "UK":
            country = "GB"
        country = country if country in countries else None
        forms = [
            p
            for p in named_nodes(((read.form or "").strip()[:100],), products)
            if p.industry == material.industry
        ]
        form = forms[0] if forms else None
        key = (_material_key(material.key), country)
        if key in found:
            continue
        found[key] = SuggestedSourcing(
            material=key[0],
            material_name=material.name,
            country=country,
            form=_form_key(form.key) if form else None,
            form_name=form.name if form else None,
            read_as=", ".join(part for part in (name, read.form, read.country) if part)[:200],
        )
    return list(found.values())
