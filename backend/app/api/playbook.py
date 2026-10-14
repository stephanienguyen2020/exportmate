import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.playbook import RuleFieldsOut, RuleIn, RuleOut, RuleUpdate
from app.services import playbook as playbook_service

router = APIRouter(prefix="/playbook", tags=["playbook"])
Db = Annotated[Session, Depends(get_db)]


@router.get("/rules", response_model=SuccessResponse[list[RuleOut]])
def list_rules(ctx: ViewerContext, db: Db):
    rules, revision = playbook_service.list_playbook_rules(db, ctx)
    return success_response([RuleOut.from_rule(r) for r in rules], revision=revision)


@router.post("/rules", response_model=SuccessResponse[RuleOut], status_code=201)
def create_rule(payload: RuleIn, ctx: EditorContext, db: Db):
    """A rule with `when` and `then` is checked by every analysis; without them it is stored."""
    rule, revision = playbook_service.create_playbook_rule(db, ctx, payload)
    return success_response(RuleOut.from_rule(rule), revision=revision)


@router.patch("/rules/{rule_id}", response_model=SuccessResponse[RuleOut])
def update_rule(rule_id: uuid.UUID, payload: RuleUpdate, ctx: EditorContext, db: Db):
    rule, revision = playbook_service.update_playbook_rule(db, ctx, rule_id, payload)
    return success_response(RuleOut.from_rule(rule), revision=revision)


@router.delete("/rules/{rule_id}", response_model=SuccessResponse[dict])
def delete_rule(rule_id: uuid.UUID, ctx: EditorContext, db: Db):
    revision = playbook_service.delete_playbook_rule(db, ctx, rule_id)
    return success_response({"deleted": True}, revision=revision)


@router.get("/fields", response_model=SuccessResponse[RuleFieldsOut])
def list_rule_fields(ctx: ViewerContext, db: Db):
    """The fields, comparisons and actions a checked rule can use, for the rule form."""
    return success_response(playbook_service.get_rule_fields(db))
