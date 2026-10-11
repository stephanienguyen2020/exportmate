"""Playbook rules. Every change saves a new revision snapshot; old revisions are kept."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import not_found_error
from app.database.models import PlaybookRule
from app.database.queries import audit as audit_queries
from app.database.queries import playbook as playbook_queries
from app.schemas.playbook import RuleIn, RuleOut, RuleUpdate


def list_playbook_rules(db: Session, ctx: CompanyContext) -> tuple[list[PlaybookRule], int]:
    rules = playbook_queries.list_live_rules(db, ctx.company_id)
    return rules, playbook_queries.get_latest_revision_number(db, ctx.company_id)


def _save_revision(db: Session, ctx: CompanyContext, action: str, rule: PlaybookRule) -> int:
    revision = playbook_queries.get_latest_revision_number(db, ctx.company_id) + 1
    snapshot = [
        RuleOut.model_validate(r).model_dump(mode="json", by_alias=True)
        for r in playbook_queries.list_live_rules(db, ctx.company_id)
    ]
    playbook_queries.add_playbook_revision(
        db, company_id=ctx.company_id, revision=revision, rules=snapshot, user_id=ctx.user.id
    )
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action=action,
        object_type="playbook_rule",
        object_id=str(rule.id),
        data={"revision": revision, "text": rule.text, "enabled": rule.enabled},
    )
    db.commit()
    return revision


def create_playbook_rule(
    db: Session, ctx: CompanyContext, payload: RuleIn
) -> tuple[PlaybookRule, int]:
    rule = playbook_queries.add_rule(
        db,
        PlaybookRule(
            company_id=ctx.company_id,
            text=payload.text,
            category=payload.category,
            enabled=payload.enabled,
        ),
    )
    return rule, _save_revision(db, ctx, "playbook.rule_created", rule)


def update_playbook_rule(
    db: Session, ctx: CompanyContext, rule_id: uuid.UUID, payload: RuleUpdate
) -> tuple[PlaybookRule, int]:
    rule = playbook_queries.get_live_rule(db, ctx.company_id, rule_id)
    if not rule:
        raise not_found_error("Rule")
    for field, value in payload.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(rule, field, value)
    db.flush()
    return rule, _save_revision(db, ctx, "playbook.rule_updated", rule)


def delete_playbook_rule(db: Session, ctx: CompanyContext, rule_id: uuid.UUID) -> int:
    rule = playbook_queries.get_live_rule(db, ctx.company_id, rule_id)
    if not rule:
        raise not_found_error("Rule")
    rule.deleted_at = datetime.now(UTC)
    db.flush()
    return _save_revision(db, ctx, "playbook.rule_deleted", rule)
