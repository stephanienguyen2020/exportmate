"""The graph query API behind the assistant's query_graph tool (GraphRAG): which of a company's
orders a material, an origin country, a product or HS code, or a market reaches, each with the
cited path. The same walk as News watch (`GraphWalker`), for what a question names instead of
what an article names, so "which orders depend on acacia from Laos?" and "if Vietnam restricts
acacia log exports" get the paths News watch would show. The walk decides; the assistant only
explains the paths."""

from datetime import date

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.database.queries import orders as order_queries
from app.schemas.knowledge_graph import GraphQueryMatchOut, GraphQueryOut, GraphQueryUnderstoodOut
from app.schemas.news import NewsPathStepOut
from app.services.graph_words import broad_materials, named_nodes
from app.services.knowledge_graph import (
    GraphMentions,
    GraphWalker,
    hs_heading,
    product_of_hs_code,
)
from app.services.trade_map import load_gazetteer, locate_destination

MAX_TERMS = 8  # of each kind, as News watch keeps from an article (ai/server/mentions.js)


def _clean(values: list[str] | None, upper: bool = False) -> tuple[str, ...]:
    kept = [v.strip() for v in values or [] if v and v.strip()][:MAX_TERMS]
    return tuple(v.upper() if upper else v for v in kept)


def _understood(walker: GraphWalker, mentions: GraphMentions) -> GraphQueryUnderstoodOut:
    species = named_nodes(mentions.materials, walker.materials)
    materials = species or broad_materials(mentions.materials, walker.commodities, walker.materials)
    word_products = named_nodes(mentions.materials, walker.products)
    code_products = [
        node
        for code in mentions.hs_codes
        if hs_heading(code) and (node := product_of_hs_code(code, walker.products))
    ]
    known_words = {
        word
        for word in mentions.materials
        if named_nodes((word,), walker.materials + walker.products)
        or broad_materials((word,), walker.commodities, walker.materials)
    }
    unknown = [w for w in mentions.materials if w not in known_words]
    unknown += [c for c in mentions.hs_codes if not hs_heading(c)]
    unknown += [c for c in mentions.origin_countries if c not in walker.country_names]
    markets = walker.known_markets(mentions.markets)
    unknown += [
        m
        for m in mentions.markets
        if m not in walker.market_codes and m not in walker.market_of_country
    ]
    products = {node.key: node.name for node in [*word_products, *code_products]}
    return GraphQueryUnderstoodOut(
        materials=sorted({node.name for node in materials}),
        products=list(products.values()),
        countries=[
            walker.country_names[c] for c in mentions.origin_countries if c in walker.country_names
        ],
        markets=sorted(markets),
        unknown=unknown,
    )


def query_graph(
    db: Session,
    ctx: CompanyContext,
    *,
    materials: list[str] | None = None,
    countries: list[str] | None = None,
    hs_codes: list[str] | None = None,
    markets: list[str] | None = None,
    include_shipped: bool = False,
) -> GraphQueryOut:
    mentions = GraphMentions(
        materials=_clean(materials),
        hs_codes=_clean(hs_codes),
        origin_countries=_clean(countries, upper=True),
        markets=_clean(markets, upper=True),
        named_as="named in the question",
    )
    gazetteer = load_gazetteer(db)
    today = date.today()
    orders = [
        o
        for o in order_queries.list_company_orders(db, ctx.company_id)
        if include_shipped or o.ship_date >= today
    ]
    walked = [(o, locate_destination(o.destination, gazetteer).market) for o in orders]
    walker = GraphWalker(db, ctx.company_id)
    matches = [
        GraphQueryMatchOut(
            order_id=match.order.external_id,
            product=match.order.product,
            supplier=match.order.supplier,
            destination=match.order.destination,
            market=match.market,
            ship_date=match.order.ship_date,
            status=match.order.status.value,
            via=match.via,
            reason=match.reason,
            path=[
                NewsPathStepOut.model_validate(step, from_attributes=True) for step in match.path
            ],
        )
        for match in walker.find_matches(mentions, walked)
    ]
    return GraphQueryOut(
        understood=_understood(walker, mentions),
        orders_checked=len(orders),
        matches=matches,
        walked_on=sorted(walker.store.answered_by),
    )
