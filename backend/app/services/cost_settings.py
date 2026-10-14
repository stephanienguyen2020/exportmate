"""Cost assumptions: shared defaults (seeded), which each company can change for itself.

Analysis uses them for costs the regulation doesn't state, such as a day of delay. Every cost
line names where its number came from (docs/REQUIREMENTS.md §4.6 step 3).
"""

import logging

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.currencies import is_currency
from app.core.errors import AppError
from app.database.queries import audit as audit_queries
from app.database.queries import trade_map as map_queries
from app.schemas.cost_settings import CostSettingOut, CostSettingsUpdate

log = logging.getLogger(__name__)
DAYS = "days"


def get_cost_settings(db: Session, company_id) -> dict[str, CostSettingOut]:
    """The values in use for this company, by key."""
    own = {s.key: s for s in map_queries.list_company_cost_settings(db, company_id)}
    settings = {}
    for default in map_queries.list_cost_defaults(db):
        mine = own.get(default.key)
        settings[default.key] = CostSettingOut(
            key=default.key,
            label=default.label,
            unit=mine.unit if mine else default.unit,
            value=mine.value if mine else default.value,
            source="company_setting" if mine else "default",
            default_unit=default.unit,
            default_value=default.value,
        )
    return settings


def _invalid(index: int, field: str, message: str) -> AppError:
    return AppError(
        422, "invalid_input", "Some fields are invalid.", {f"settings.{index}.{field}": message}
    )


def update_cost_settings(
    db: Session, ctx: CompanyContext, payload: CostSettingsUpdate
) -> list[CostSettingOut]:
    defaults = {d.key: d for d in map_queries.list_cost_defaults(db)}
    changes = {}
    for i, item in enumerate(payload.settings):
        default = defaults.get(item.key)
        if default is None:
            raise _invalid(i, "key", f"Unknown setting. Use one of: {', '.join(defaults)}")
        if item.value is None:
            map_queries.delete_company_cost_setting(db, ctx.company_id, item.key)
            changes[item.key] = None
            continue
        unit = (item.unit or default.unit).upper() if default.unit != DAYS else DAYS
        if default.unit == DAYS and item.unit not in (None, DAYS):
            raise _invalid(i, "unit", "This setting is a number of days")
        if default.unit != DAYS and not is_currency(unit):
            raise _invalid(i, "unit", "An ISO 4217 currency such as USD")
        map_queries.upsert_company_cost_setting(
            db,
            {
                "company_id": ctx.company_id,
                "key": item.key,
                "unit": unit,
                "value": item.value,
                "updated_by": ctx.user.id,
            },
        )
        changes[item.key] = {"value": item.value, "unit": unit}
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="cost_settings.updated",
        object_type="company",
        object_id=str(ctx.company_id),
        data=changes,
    )
    db.commit()
    log.info(
        "cost_settings.updated",
        extra={"company_id": str(ctx.company_id), "keys": sorted(changes)},
    )
    return list(get_cost_settings(db, ctx.company_id).values())
