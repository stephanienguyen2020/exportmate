"""Playbook rules. Every change saves a new revision snapshot; old revisions are kept.

A rule can also be checked: WHEN conditions THEN an action, saved as data and validated here
against the fields in services/rule_checks.py. Analysis runs them (services/analysis.py).
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import PlaybookRule
from app.database.queries import audit as audit_queries
from app.database.queries import playbook as playbook_queries
from app.database.queries import trade_map as map_queries
from app.schemas.playbook import (
    ActionIn,
    ConditionIn,
    FieldOut,
    RuleFieldsOut,
    RuleIn,
    RuleOut,
    RuleUpdate,
)
from app.services import rule_checks

log = logging.getLogger(__name__)


def list_playbook_rules(db: Session, ctx: CompanyContext) -> tuple[list[PlaybookRule], int]:
    rules = playbook_queries.list_live_rules(db, ctx.company_id)
    return rules, playbook_queries.get_latest_revision_number(db, ctx.company_id)


def get_rule_fields(db: Session) -> RuleFieldsOut:
    options = {
        "markets": [{"value": m.code, "label": m.name} for m in map_queries.list_markets(db)],
        "document_kinds": [
            {"value": k.kind, "label": k.label} for k in map_queries.list_document_kinds(db)
        ],
    }
    return RuleFieldsOut(
        fields=[
            FieldOut(
                key=key,
                label=field.label,
                type=field.type,
                ops=rule_checks.OPS[field.type],
                options=options[field.options] if field.options else None,
            )
            for key, field in rule_checks.FIELDS.items()
        ],
        actions=rule_checks.ACTIONS,
        no_value_ops=sorted(rule_checks.NO_VALUE_OPS),
    )


def _checked_rule(
    db: Session, when: list[ConditionIn] | None, then: ActionIn | None
) -> tuple[list[dict] | None, str | None, str | None]:
    """(conditions, action, note) to store, or a 422. Both or neither of WHEN and THEN."""
    if when is None and then is None:
        return None, None, None
    try:
        if when is None or then is None:
            missing = "when" if when is None else "then"
            raise rule_checks.RuleError(missing, "A checked rule needs both WHEN and THEN")
        rule_checks.check_action(then.action, then.note)
        conditions = rule_checks.clean_conditions(
            [c.model_dump() for c in when],
            {m.code for m in map_queries.list_markets(db)},
            {k.kind for k in map_queries.list_document_kinds(db)},
        )
    except rule_checks.RuleError as error:
        raise AppError(
            422, "invalid_rule", "This rule can't be checked.", {error.field: error.message}
        )
    note = (then.note or "").strip() or None
    return conditions, then.action, note


def _save_revision(db: Session, ctx: CompanyContext, action: str, rule: PlaybookRule) -> int:
    revision = playbook_queries.get_latest_revision_number(db, ctx.company_id) + 1
    snapshot = [
        RuleOut.from_rule(r).model_dump(mode="json", by_alias=True)
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
        data={
            "revision": revision,
            "text": rule.text,
            "enabled": rule.enabled,
            "checked": bool(rule.conditions),
        },
    )
    db.commit()
    log.info(
        action,
        extra={
            "company_id": str(ctx.company_id),
            "rule_id": str(rule.id),
            "revision": revision,
            "checked": bool(rule.conditions),
        },
    )
    return revision


def create_playbook_rule(
    db: Session, ctx: CompanyContext, payload: RuleIn
) -> tuple[PlaybookRule, int]:
    conditions, action, note = _checked_rule(db, payload.when, payload.then)
    rule = playbook_queries.add_rule(
        db,
        PlaybookRule(
            company_id=ctx.company_id,
            text=payload.text,
            category=payload.category,
            enabled=payload.enabled,
            conditions=conditions,
            action=action,
            action_note=note,
        ),
    )
    return rule, _save_revision(db, ctx, "playbook.rule_created", rule)


def update_playbook_rule(
    db: Session, ctx: CompanyContext, rule_id: uuid.UUID, payload: RuleUpdate
) -> tuple[PlaybookRule, int]:
    rule = playbook_queries.get_live_rule(db, ctx.company_id, rule_id)
    if not rule:
        raise not_found_error("Rule")
    for field in ("text", "category", "enabled"):
        value = getattr(payload, field)
        if value is not None:
            setattr(rule, field, value)
    if {"when", "then"} & payload.model_fields_set:
        rule.conditions, rule.action, rule.action_note = _checked_rule(
            db, payload.when, payload.then
        )
    db.flush()
    return rule, _save_revision(db, ctx, "playbook.rule_updated", rule)


def delete_playbook_rule(db: Session, ctx: CompanyContext, rule_id: uuid.UUID) -> int:
    rule = playbook_queries.get_live_rule(db, ctx.company_id, rule_id)
    if not rule:
        raise not_found_error("Rule")
    rule.deleted_at = datetime.now(UTC)
    db.flush()
    return _save_revision(db, ctx, "playbook.rule_deleted", rule)
