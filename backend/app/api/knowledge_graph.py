import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.knowledge_graph import (
    ChainVersionOut,
    ChainVersionPublishIn,
    ChainVersionRejectIn,
    ChainVersionSummaryOut,
    GraphQueryOut,
    MaterialChainOut,
)
from app.services import chain_versions as chain_versions_service
from app.services import graph_query as graph_query_service
from app.services import material_chain as material_chain_service

router = APIRouter(prefix="/knowledge-graph", tags=["knowledge graph"])
Db = Annotated[Session, Depends(get_db)]
Terms = Annotated[list[str] | None, Query()]


@router.get("/chain", response_model=SuccessResponse[MaterialChainOut])
def get_material_chain(ctx: ViewerContext, db: Db):
    """The shared material chain the knowledge graph walks: products, links with their sources
    and checks, and this company's verdicts on suggestions through each link."""
    return success_response(material_chain_service.build_material_chain(db, ctx))


@router.get("/query", response_model=SuccessResponse[GraphQueryOut])
def query_knowledge_graph(
    ctx: ViewerContext,
    db: Db,
    material: Terms = None,
    country: Terms = None,
    hs_code: Annotated[list[str] | None, Query(alias="hsCode")] = None,
    market: Terms = None,
    include_shipped: Annotated[bool, Query(alias="includeShipped")] = False,
):
    """Which of this company's orders a material ("acacia", "timber", "plywood"), an origin
    country (ISO alpha-2), an HS code or a market reaches, each with its cited path: the walk
    News watch uses, for the assistant's query_graph tool. Repeat a parameter for several."""
    return success_response(
        graph_query_service.query_graph(
            db,
            ctx,
            materials=material,
            countries=country,
            hs_codes=hs_code,
            markets=market,
            include_shipped=include_shipped,
        )
    )


@router.get("/chain-versions", response_model=SuccessResponse[list[ChainVersionSummaryOut]])
def list_chain_versions(ctx: ViewerContext, db: Db):
    """Every version of every industry's material chain, drafts first to review. Chain admins
    only (CHAIN_ADMIN_EMAILS)."""
    return success_response(chain_versions_service.list_versions(db, ctx))


@router.get("/chain-versions/{version_id}", response_model=SuccessResponse[ChainVersionOut])
def get_chain_version(version_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """One version with what it changes and what the pipeline flagged. Chain admins only."""
    return success_response(chain_versions_service.version_detail(db, ctx, version_id))


@router.post(
    "/chain-versions/{version_id}/publish", response_model=SuccessResponse[ChainVersionOut]
)
def publish_chain_version(
    version_id: uuid.UUID, payload: ChainVersionPublishIn, ctx: ViewerContext, db: Db
):
    """Publishes a draft and rebuilds the graph from the published versions. Chain admins only."""
    return success_response(
        chain_versions_service.publish_version(db, ctx, version_id, payload.note)
    )


@router.post("/chain-versions/{version_id}/reject", response_model=SuccessResponse[ChainVersionOut])
def reject_chain_version(
    version_id: uuid.UUID, payload: ChainVersionRejectIn, ctx: ViewerContext, db: Db
):
    """Rejects a draft, with why. Chain admins only."""
    return success_response(
        chain_versions_service.reject_version(db, ctx, version_id, payload.note)
    )
