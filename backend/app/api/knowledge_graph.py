from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.knowledge_graph import MaterialChainOut
from app.services import material_chain as material_chain_service

router = APIRouter(prefix="/knowledge-graph", tags=["knowledge graph"])
Db = Annotated[Session, Depends(get_db)]


@router.get("/chain", response_model=SuccessResponse[MaterialChainOut])
def get_material_chain(ctx: ViewerContext, db: Db):
    """The shared material chain the knowledge graph walks: products, links with their sources
    and checks, and this company's verdicts on suggestions through each link."""
    return success_response(material_chain_service.build_material_chain(db, ctx))
