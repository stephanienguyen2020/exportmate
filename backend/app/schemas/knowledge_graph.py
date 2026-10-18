import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import CamelCaseModel
from app.schemas.news import AccuracyByWayOut, NewsPathStepOut


class ChainProductOut(CamelCaseModel):
    key: str  # "wood.plywood"
    name: str
    hs_codes: list[str]
    stage: str | None  # raw, first processing, panel, final, by-product


class AiCheckOut(CamelCaseModel):
    verdict: str  # "agree", "agree, secondary route", "added"
    note: str
    by: str  # who checked: a model's name
    on: str  # YYYY-MM-DD


class VerdictCountsOut(CamelCaseModel):
    confirmed: int
    rejected: int


class ChainLinkOut(CamelCaseModel):
    from_key: str
    from_name: str
    to_key: str
    to_name: str
    relation: Literal["used_to_make", "by_product"]
    secondary: bool  # used only when no equally short path avoids it
    source_title: str
    source_url: str
    quote: str | None  # the source's words, when it says so
    basis: str | None  # otherwise why, from the source
    ai_check: AiCheckOut | None
    company: VerdictCountsOut  # this company's verdicts on suggestions through the link
    everyone: VerdictCountsOut  # every company's, as of the last link weights job
    weight: float  # share confirmed, smoothed (0.5 unjudged); breaks ties between paths
    doubt: str | None  # "Often rejected at your company": the walk avoids it when it can


class ChainIndustryOut(CamelCaseModel):
    key: str  # "wood"
    name: str  # the EUDR commodity's name
    version: int | None  # the published chain version, None before versions existed
    published_at: datetime | None
    products: list[ChainProductOut]
    links: list[ChainLinkOut]


class ChainMaterialOut(CamelCaseModel):
    key: str
    name: str
    industry: str | None
    scientific_names: list[str]
    wood_type: str | None


class MaterialChainOut(CamelCaseModel):
    """The shared material chain, as the knowledge graph walks it, with what this company's
    verdicts say about each link."""

    industries: list[ChainIndustryOut]
    materials: list[ChainMaterialOut]
    by_way: list[AccuracyByWayOut]  # how often each way of suggesting was confirmed
    weights_updated_at: datetime | None  # the link weights job's last run (every company's counts)
    is_chain_admin: bool  # may review chain versions (CHAIN_ADMIN_EMAILS)
    drafts_waiting: int  # chain versions waiting for a chain admin


class GraphQueryUnderstoodOut(CamelCaseModel):
    """What the walk made of the question's words, so an answer can say what it couldn't use."""

    materials: list[str]  # graph materials, e.g. "Acacia"
    products: list[
        str
    ]  # chain products named as words or HS codes, e.g. "Logs (wood in the rough)"
    countries: list[str]  # origin countries, by name
    markets: list[str]  # our market codes
    unknown: list[str]  # words and codes the graph doesn't know


class GraphQueryMatchOut(CamelCaseModel):
    """One of the company's orders the question's material, origin, product or market reaches."""

    order_id: str  # the order's external ID, as in /orders/{id}
    product: str
    supplier: str
    destination: str
    market: str | None
    ship_date: date
    status: str
    via: Literal["supplier", "hs"]  # through a supplier's sourcing, or the same HS heading
    reason: str
    path: list[NewsPathStepOut]


class GraphQueryOut(CamelCaseModel):
    understood: GraphQueryUnderstoodOut
    orders_checked: int  # the orders walked (open ones, or every one with includeShipped)
    matches: list[GraphQueryMatchOut]


class ChainDiffLinkOut(CamelCaseModel):
    """A link a chain version adds, removes or changes."""

    from_key: str  # within the industry, e.g. "roundwood"
    from_name: str
    to_key: str
    to_name: str
    relation: Literal["used_to_make", "by_product"]
    source_title: str
    source_url: str | None
    quote: str | None
    basis: str | None
    secondary: bool
    changed: list[str] = Field(default_factory=list)  # for a changed link: source, quote, …


class ChainVersionChangesOut(CamelCaseModel):
    """What a version changes against its baseline: a draft against the published version, a
    published one against the version it replaced."""

    products_added: list[str]
    products_removed: list[str]
    links_added: list[ChainDiffLinkOut]
    links_removed: list[ChainDiffLinkOut]
    links_changed: list[ChainDiffLinkOut]


class ChainVersionSummaryOut(CamelCaseModel):
    id: uuid.UUID
    industry: str
    industry_name: str
    number: int
    status: Literal["draft", "published", "superseded", "rejected"]
    origin: str  # "seed" (a file in data/industries/) or "pipeline"
    note: str | None
    product_count: int
    link_count: int
    created_at: datetime
    reviewed_by: str | None
    reviewed_at: datetime | None
    review_note: str | None
    published_at: datetime | None


class ChainVersionOut(ChainVersionSummaryOut):
    changes: ChainVersionChangesOut
    flagged: dict | None  # what the pipeline couldn't keep: dropped links, links no longer sourced


class ChainVersionPublishIn(CamelCaseModel):
    note: str | None = Field(default=None, max_length=500)


class ChainVersionRejectIn(CamelCaseModel):
    note: str = Field(min_length=1, max_length=500)  # why, for whoever builds the next draft
