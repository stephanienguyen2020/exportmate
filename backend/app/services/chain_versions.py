"""Versions of each industry's material chain, and the graph built from the published ones.

The architecture's material chain builder (docs/knowledge-graph-architecture.excalidraw, lane 2):
the pipeline (build_chain.py) drafts an industry's chain; a chain admin reads the draft on Rules
& news › Material chain (what changed against the published version, and what the pipeline
flagged) and publishes or rejects it. Publishing rebuilds the graph from the published versions,
so News watch, the graph query API and the assistant walk the new chain straight away.

The files in data/industries/ are where the pipeline releases to and what git reviews: an
industry with no versions gets its file as version 1, published; a file that differs from every
version of its industry becomes a draft (`sync_from_files`, run by the reference seed).
"""

import logging
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError
from app.database.models import ChainVersion, ChainVersionStatus, User
from app.database.queries import knowledge_graph as graph_queries
from app.knowledge_graph import layer_vocabulary, load_graph_file, load_released_files
from app.schemas.knowledge_graph import (
    ChainDiffLinkOut,
    ChainVersionChangesOut,
    ChainVersionOut,
    ChainVersionSummaryOut,
)

log = logging.getLogger(__name__)

LINK_FIELDS = ("source", "quote", "basis", "secondary")  # what a changed link differs in


def chain_admin_emails() -> set[str]:
    return {e.strip().lower() for e in get_settings().chain_admin_emails.split(",") if e.strip()}


def is_chain_admin(user: User) -> bool:
    return user.email.lower() in chain_admin_emails()


def require_chain_admin(ctx: CompanyContext) -> None:
    if not is_chain_admin(ctx.user):
        raise AppError(403, "not_chain_admin", "Only chain admins can review chain versions.")


# --- From the files in git


def sync_from_files(db: Session) -> int:
    """Each file in data/industries/ as a version: the first one published, a changed one as a
    draft for a chain admin. Returns how many versions were added."""
    added = 0
    for content in load_released_files():
        industry = content["industry"]["key"]
        versions = graph_queries.list_chain_versions(db, industry)
        if any(v.content == content for v in versions):
            continue
        first = not versions
        graph_queries.add_chain_version(
            db,
            industry=industry,
            status=ChainVersionStatus.published if first else ChainVersionStatus.draft,
            content=content,
            origin="seed",
            note=f"data/industries/{industry}.json"
            + (" (the first version)" if first else " changed in git"),
            published_at=datetime.now(UTC) if first else None,
        )
        added += 1
    return added


def published_chain(db: Session) -> dict:
    """The chain the graph is built from: the published versions, with the vocabulary laid over
    them. Before any version exists (a fresh database), the files."""
    published = graph_queries.list_published_versions(db)
    if not published:
        return layer_vocabulary(load_released_files())
    return layer_vocabulary([v.content for v in published])


# --- The graph


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


def rebuild_graph(db: Session) -> dict[str, int]:
    """The graph's sources, nodes and links from the published chain. Nodes are updated in
    place; links not in the chain are removed."""
    chain = published_chain(db)
    eudr = load_graph_file("eudr_products.json")
    graph_queries.upsert_graph_sources(
        db, [{"key": k, "title": v["title"], "url": v["url"]} for k, v in chain["sources"].items()]
    )
    industry_of_commodity = {i["eudrCommodity"]: i["key"] for i in chain["industries"]}
    generic_terms = {i["eudrCommodity"]: i.get("genericTerms", {}) for i in chain["industries"]}
    nodes = [
        {
            "key": f"commodity.{_slug(c['commodity'])}",
            "kind": "commodity",
            "industry": industry_of_commodity.get(c["commodity"]),
            "name": c["commodity"],
            "hs_prefixes": sorted({_digits(p["hsCode"]) for p in c["products"]}),
            "aliases": sorted({c["commodity"].lower(), *generic_terms.get(c["commodity"], {})}),
            # Broad words for the commodity's materials, and the wood types each stands for.
            "details": {
                "lines": c["products"],
                "genericTerms": generic_terms.get(c["commodity"], {}),
            },
            "source_key": "eudr-annex-i",
        }
        for c in eudr["commodities"]
    ]
    edges = []
    for industry in chain["industries"]:
        nodes += [
            {
                "key": f"{industry['key']}.{p['key']}",
                "kind": "product",
                "industry": industry["key"],
                "name": p["name"],
                "hs_prefixes": [_digits(code) for code in p["hsCodes"]],
                "aliases": sorted({p["name"].lower(), *p.get("aliases", [])}),
                "details": {"stage": p["stage"]},
                "source_key": None,
            }
            for p in industry["products"]
        ]
        edges += [
            {
                "from_key": f"{industry['key']}.{link['from']}",
                "to_key": f"{industry['key']}.{link['to']}",
                "relation": link["relation"],
                "source_key": link["source"],
                "quote": link.get("quote"),
                "basis": link.get("basis"),
                "secondary": link.get("secondary", False),
                "ai_check": link.get("aiCheck"),
            }
            for link in industry["links"]
        ]
    nodes += [
        {
            "key": f"material.{m['key']}",
            "kind": "material",
            "industry": m["industry"],
            "name": m["name"],
            "hs_prefixes": [],
            "aliases": sorted(
                {a.lower() for a in [m["name"], *m["aliases"], *m["scientificNames"]]}
            ),
            "details": {
                "scientificNames": m["scientificNames"],
                "woodType": m.get("woodType"),
                "note": m.get("note"),
            },
            "source_key": None,
        }
        for m in chain["materials"]
    ]
    graph_queries.upsert_graph_nodes(db, nodes)
    graph_queries.replace_graph_edges(db, edges)
    return {"graph_nodes": len(nodes), "graph_edges": len(edges)}


# --- Reviewing versions


def _link_key(link: dict) -> tuple[str, str, str]:
    return (link["from"], link["to"], link["relation"])


def _diff_link(link: dict, names: dict[str, str], sources: dict, changed=()) -> ChainDiffLinkOut:
    source = sources.get(link["source"], {})
    return ChainDiffLinkOut(
        from_key=link["from"],
        from_name=names.get(link["from"], link["from"]),
        to_key=link["to"],
        to_name=names.get(link["to"], link["to"]),
        relation=link["relation"],
        source_title=source.get("title", link["source"]),
        source_url=source.get("url"),
        quote=link.get("quote"),
        basis=link.get("basis"),
        secondary=link.get("secondary", False),
        changed=list(changed),
    )


def _changes(version: ChainVersion, baseline: ChainVersion | None) -> ChainVersionChangesOut:
    """What this version changes against its baseline (`_baseline`)."""
    sources = load_graph_file("material_chain.json")["sources"] | version.content.get("sources", {})
    products = {p["key"]: p["name"] for p in version.content["industry"]["products"]}
    links = {_link_key(link): link for link in version.content["industry"]["links"]}
    if baseline is None:
        before_products, before_links = {}, {}
    else:
        sources = baseline.content.get("sources", {}) | sources
        before_products = {p["key"]: p["name"] for p in baseline.content["industry"]["products"]}
        before_links = {_link_key(link): link for link in baseline.content["industry"]["links"]}
    names = before_products | products
    return ChainVersionChangesOut(
        products_added=[name for key, name in products.items() if key not in before_products],
        products_removed=[name for key, name in before_products.items() if key not in products],
        links_added=[
            _diff_link(link, names, sources)
            for key, link in links.items()
            if key not in before_links
        ],
        links_removed=[
            _diff_link(link, names, sources)
            for key, link in before_links.items()
            if key not in links
        ],
        links_changed=[
            _diff_link(link, names, sources, changed)
            for key, link in links.items()
            if key in before_links
            and (changed := [f for f in LINK_FIELDS if link.get(f) != before_links[key].get(f)])
        ],
    )


def _summary(db: Session, version: ChainVersion) -> ChainVersionSummaryOut:
    reviewer = db.get(User, version.reviewed_by) if version.reviewed_by else None
    industry = version.content["industry"]
    return ChainVersionSummaryOut(
        id=version.id,
        industry=version.industry,
        industry_name=industry.get("name", version.industry),
        number=version.number,
        status=version.status.value,
        origin=version.origin,
        note=version.note,
        product_count=len(industry["products"]),
        link_count=len(industry["links"]),
        created_at=version.created_at,
        reviewed_by=reviewer.name if reviewer else None,
        reviewed_at=version.reviewed_at,
        review_note=version.review_note,
        published_at=version.published_at,
    )


def list_versions(db: Session, ctx: CompanyContext) -> list[ChainVersionSummaryOut]:
    require_chain_admin(ctx)
    versions = graph_queries.list_chain_versions(db)
    # Drafts to review first, then each industry's versions, newest first.
    versions.sort(key=lambda v: (v.status != ChainVersionStatus.draft, v.industry, -v.number))
    return [_summary(db, v) for v in versions]


def _get(db: Session, version_id: uuid.UUID) -> ChainVersion:
    version = graph_queries.get_chain_version(db, version_id)
    if version is None:
        raise AppError(404, "chain_version_not_found", "No such chain version.")
    return version


def _published(db: Session, industry: str) -> ChainVersion | None:
    return next(
        (
            v
            for v in graph_queries.list_chain_versions(db, industry)
            if v.status == ChainVersionStatus.published
        ),
        None,
    )


def _baseline(db: Session, version: ChainVersion) -> ChainVersion | None:
    """What a version is compared with: a draft (or a rejected one) with the industry's
    published version; a published or superseded one with the version it replaced."""
    if version.status in (ChainVersionStatus.draft, ChainVersionStatus.rejected):
        return _published(db, version.industry)
    return next(
        (
            v
            for v in graph_queries.list_chain_versions(db, version.industry)
            if v.number < version.number and v.published_at is not None
        ),
        None,
    )


def version_detail(db: Session, ctx: CompanyContext, version_id: uuid.UUID) -> ChainVersionOut:
    require_chain_admin(ctx)
    version = _get(db, version_id)
    return ChainVersionOut(
        **_summary(db, version).model_dump(),
        changes=_changes(version, _baseline(db, version)),
        flagged=version.flagged,
    )


def _review(
    db: Session, ctx: CompanyContext, version_id: uuid.UUID, status: ChainVersionStatus, note
) -> ChainVersion:
    require_chain_admin(ctx)
    version = _get(db, version_id)
    if version.status != ChainVersionStatus.draft:
        raise AppError(409, "chain_version_not_draft", "Only a draft can be published or rejected.")
    now = datetime.now(UTC)
    version.status = status
    version.reviewed_by = ctx.user.id
    version.reviewed_at = now
    version.review_note = note
    return version


def publish_version(
    db: Session, ctx: CompanyContext, version_id: uuid.UUID, note: str | None
) -> ChainVersionOut:
    """Publishes a draft: the industry's published version becomes superseded, and the graph is
    rebuilt from the published versions."""
    version = _get(db, version_id)
    before = _published(db, version.industry)
    version = _review(db, ctx, version_id, ChainVersionStatus.published, note)
    if before is not None:
        before.status = ChainVersionStatus.superseded
    version.published_at = version.reviewed_at
    db.flush()
    counts = rebuild_graph(db)
    db.commit()
    log.info(
        "chain.version_published",
        extra={"industry": version.industry, "number": version.number, **counts},
    )
    return version_detail(db, ctx, version_id)


def reject_version(
    db: Session, ctx: CompanyContext, version_id: uuid.UUID, note: str
) -> ChainVersionOut:
    version = _review(db, ctx, version_id, ChainVersionStatus.rejected, note)
    db.commit()
    log.info(
        "chain.version_rejected", extra={"industry": version.industry, "number": version.number}
    )
    return version_detail(db, ctx, version_id)
