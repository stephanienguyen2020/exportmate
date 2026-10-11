import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.playbook import RuleIn, RuleOut, RuleUpdate
from app.services import playbook as playbook_service

router = APIRouter(prefix="/playbook/rules", tags=["playbook"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[list[RuleOut]])
def list_rules(ctx: ViewerContext, db: Db):
    rules, revision = playbook_service.list_playbook_rules(db, ctx)
    return success_response([RuleOut.model_validate(r) for r in rules], revision=revision)


@router.post("", response_model=SuccessResponse[RuleOut], status_code=201)
def create_rule(payload: RuleIn, ctx: EditorContext, db: Db):
    rule, revision = playbook_service.create_playbook_rule(db, ctx, payload)
    return success_response(RuleOut.model_validate(rule), revision=revision)


@router.patch("/{rule_id}", response_model=SuccessResponse[RuleOut])
def update_rule(rule_id: uuid.UUID, payload: RuleUpdate, ctx: EditorContext, db: Db):
    rule, revision = playbook_service.update_playbook_rule(db, ctx, rule_id, payload)
    return success_response(RuleOut.model_validate(rule), revision=revision)


@router.delete("/{rule_id}", response_model=SuccessResponse[dict])
def delete_rule(rule_id: uuid.UUID, ctx: EditorContext, db: Db):
    revision = playbook_service.delete_playbook_rule(db, ctx, rule_id)
    return success_response({"deleted": True}, revision=revision)
