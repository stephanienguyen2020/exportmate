"""The material chain page: the shared chain the knowledge graph walks (products, links and the
sources behind them, who checked each link) and what this company's verdicts say about it."""

from collections import defaultdict

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.database.models import GraphNodeKind
from app.database.queries import knowledge_graph as graph_queries
from app.schemas.knowledge_graph import (
    AiCheckOut,
    ChainIndustryOut,
    ChainLinkOut,
    ChainMaterialOut,
    ChainProductOut,
    MaterialChainOut,
    VerdictCountsOut,
)
from app.services import graph_feedback
from app.services import news_matches as news_service

STAGE_ORDER = ["raw", "by-product", "first processing", "further processing", "processed", "panel"]


def _hs_code(prefix: str) -> str:
    return f"{prefix[:4]}.{prefix[4:]}" if len(prefix) > 4 else prefix


def _stage_rank(stage: str | None) -> int:
    return STAGE_ORDER.index(stage) if stage in STAGE_ORDER else len(STAGE_ORDER)


def build_material_chain(db: Session, ctx: CompanyContext) -> MaterialChainOut:
    nodes = graph_queries.list_graph_nodes(db)
    by_key = {n.key: n for n in nodes}
    sources = {s.key: s for s in graph_queries.list_graph_sources(db)}
    feedback = graph_feedback.link_feedback(db, ctx.company_id)
    links_by_industry = defaultdict(list)
    for edge in graph_queries.list_all_graph_edges(db):
        start, end = by_key[edge.from_key], by_key[edge.to_key]
        source = sources[edge.source_key]
        verdicts = feedback.get((edge.from_key, edge.to_key))
        links_by_industry[start.industry].append(
            ChainLinkOut(
                from_key=start.key,
                from_name=start.name,
                to_key=end.key,
                to_name=end.name,
                relation=edge.relation.value,
                secondary=edge.secondary,
                source_title=source.title,
                source_url=source.url,
                quote=edge.quote,
                basis=edge.basis,
                ai_check=AiCheckOut.model_validate(edge.ai_check) if edge.ai_check else None,
                company=VerdictCountsOut(
                    confirmed=verdicts.company.confirmed if verdicts else 0,
                    rejected=verdicts.company.rejected if verdicts else 0,
                ),
                everyone=VerdictCountsOut(
                    confirmed=verdicts.everyone.confirmed if verdicts else 0,
                    rejected=verdicts.everyone.rejected if verdicts else 0,
                ),
                weight=verdicts.weight if verdicts else graph_feedback.UNJUDGED_WEIGHT,
                doubt=verdicts.doubt if verdicts else None,
            )
        )
    commodities = {n.industry: n for n in nodes if n.kind == GraphNodeKind.commodity and n.industry}
    products = [n for n in nodes if n.kind == GraphNodeKind.product]
    industries = []
    for industry in sorted({p.industry for p in products if p.industry}):
        ranked = sorted(
            (p for p in products if p.industry == industry),
            key=lambda p: (_stage_rank(p.details.get("stage")), p.name),
        )
        rank = {p.key: i for i, p in enumerate(ranked)}
        industries.append(
            ChainIndustryOut(
                key=industry,
                name=commodities[industry].name if industry in commodities else industry,
                products=[
                    ChainProductOut(
                        key=p.key,
                        name=p.name,
                        hs_codes=[_hs_code(c) for c in p.hs_prefixes],
                        stage=p.details.get("stage"),
                    )
                    for p in ranked
                ],
                # Raw materials first, so the list reads from forest to finished goods.
                links=sorted(
                    links_by_industry[industry],
                    key=lambda link: (rank.get(link.from_key, 0), rank.get(link.to_key, 0)),
                ),
            )
        )
    return MaterialChainOut(
        industries=industries,
        materials=[
            ChainMaterialOut(
                key=n.key.removeprefix("material."),
                name=n.name,
                industry=n.industry,
                scientific_names=n.details.get("scientificNames") or [],
                wood_type=n.details.get("woodType"),
            )
            for n in sorted(nodes, key=lambda n: n.name)
            if n.kind == GraphNodeKind.material
        ],
        by_way=news_service.news_match_accuracy(db, ctx).by_way,
        weights_updated_at=graph_feedback.weights_updated_at(db),
    )
