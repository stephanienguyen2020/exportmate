"""Analysis runs: for each order, what is missing, what it costs, what the playbook says, what
to do, and an audit of all of it. Plain code, no AI (docs/REQUIREMENTS.md §4.6).

Steps, in order, for every order in the run:
1. relevance: which market the destination is in (orders outside every market need data).
2. exposure: the trade map's check (services/trade_map.py) against the market requirements.
3. cost: a line per problem, priced from the regulation's own figure or a cost setting.
4. playbook: the company's checked rules against the order's facts.
5. plan: one suggested action.
6. auditor: every finding cites a quote, every number re-computes; otherwise human review.

A run finishes inside the request; nothing in it waits on AI. Each report keeps a copy of what
it cites, so it reads the same after requirements, rules or settings change.
"""

import logging
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import (
    AnalysisReport,
    AnalysisRun,
    MarketRequirement,
    Order,
    OrderStatus,
    OrderStatusChange,
    PlaybookRule,
    ReportState,
    RunStatus,
    StatusChangeSource,
)
from app.database.queries import analysis as analysis_queries
from app.database.queries import audit as audit_queries
from app.database.queries import orders as order_queries
from app.database.queries import playbook as playbook_queries
from app.database.queries import trade_map as map_queries
from app.schemas.analysis import (
    AuditResultOut,
    CostBasisOut,
    CostLineOut,
    ExposureOut,
    OrderSourceRowOut,
    ReportContentOut,
    ReportOut,
    ReportSummaryOut,
    RuleResultOut,
    RunOut,
    RunStepOut,
    SuggestedActionOut,
    UnpricedCostOut,
)
from app.schemas.cost_settings import CostSettingOut
from app.schemas.orders import OrderOut
from app.schemas.trade_map import RequirementCheckOut, RequirementSourceOut
from app.services import cost_settings as cost_service
from app.services import report_review, rule_checks
from app.services import trade_map as trade_map_service

log = logging.getLogger(__name__)

GAP_STATUSES = {"missing", "mismatch"}
DAYS = "days"


def money(amount_minor: int, currency: str) -> str:
    return f"{currency} {amount_minor / 100:,.2f}"


def _setting_basis(setting: CostSettingOut) -> CostBasisOut:
    return CostBasisOut(
        type="company_setting" if setting.source == "company_setting" else "default",
        label=setting.label,
        setting_key=setting.key,
    )


def duty_amount(base_minor: int, rate_percent: Decimal) -> int:
    return int((Decimal(base_minor) * rate_percent / 100).quantize(Decimal(1), ROUND_HALF_UP))


@dataclass
class OrderAnalysis:
    """Everything one order's report says, before it is saved."""

    content: ReportContentOut
    state: ReportState
    order_status: OrderStatus
    blocked: bool
    facts: dict[str, Any] = field(default_factory=dict)


def price_problems(
    order: Order,
    checked: list[tuple[MarketRequirement, RequirementCheckOut]],
    settings: dict[str, CostSettingOut],
    days_until_ship: int,
) -> list[CostLineOut]:
    """Step 3: a line per problem. Regulation figures first; settings for everything else."""
    lines: list[CostLineOut] = []
    gaps = [(req, check) for req, check in checked if check.status in GAP_STATUSES]
    for req, check in gaps:
        key = "missing_document" if check.status == "missing" else "new_test"
        setting = settings[key]
        lines.append(
            CostLineOut(
                kind=key,
                label=f"{'Getting' if key == 'missing_document' else 'New test for'}: {req.title}",
                requirement_key=req.requirement_key,
                quantity=1,
                unit_amount_minor=setting.value,
                base_amount_minor=None,
                rate_percent=None,
                amount_minor=setting.value,
                currency=setting.unit,
                formula=f"1 × {money(setting.value, setting.unit)}",
                basis=[_setting_basis(setting)],
            )
        )
    lead_days = settings["supplier_lead_days"].value
    late_by = lead_days - max(days_until_ship, 0)
    if gaps and late_by > 0:
        per_day = settings["delay_per_day"]
        lines.append(
            CostLineOut(
                kind="delay",
                label=f"Delay: the supplier needs {lead_days} days, the ship date is in "
                f"{max(days_until_ship, 0)}",
                requirement_key=None,
                quantity=late_by,
                unit_amount_minor=per_day.value,
                base_amount_minor=None,
                rate_percent=None,
                amount_minor=late_by * per_day.value,
                currency=per_day.unit,
                formula=f"{late_by} days × {money(per_day.value, per_day.unit)}",
                basis=[_setting_basis(settings["supplier_lead_days"]), _setting_basis(per_day)],
            )
        )
    for req, check in checked:
        if req.duty_rate_percent is None or rate_changes_by(req, order.ship_date):
            continue
        amount = duty_amount(order.value_minor, req.duty_rate_percent)
        lines.append(
            CostLineOut(
                kind="duty",
                label=req.title,
                requirement_key=req.requirement_key,
                quantity=1,
                unit_amount_minor=None,
                base_amount_minor=order.value_minor,
                rate_percent=float(req.duty_rate_percent),
                amount_minor=amount,
                currency=order.currency,
                formula=f"{req.duty_rate_percent.normalize():f}% × "
                f"{money(order.value_minor, order.currency)}",
                basis=[CostBasisOut(type="regulation", label=req.title, source=check.source)],
            )
        )
    return lines


def rate_changes_by(requirement: MarketRequirement, ship_date: date) -> bool:
    """The stated rate changes on or before the ship date, so the rate we have may be wrong."""
    return requirement.changes_on is not None and ship_date >= requirement.changes_on


def unpriced_duties(
    order: Order, checked: list[tuple[MarketRequirement, RequirementCheckOut]]
) -> list[UnpricedCostOut]:
    """Duties whose rate changes by the ship date: named, with no amount."""
    return [
        UnpricedCostOut(
            kind="duty",
            label=req.title,
            requirement_key=req.requirement_key,
            reason=f"The rate changes on {req.changes_on.isoformat()}, on or before the ship "
            f"date: recheck it.{' ' + req.change_note if req.change_note else ''}",
            source=check.source,
        )
        for req, check in checked
        if req.duty_rate_percent is not None and rate_changes_by(req, order.ship_date)
    ]


def problem_lines(lines: list[CostLineOut]) -> list[CostLineOut]:
    """Lines caused by a missing or wrong document; a duty is owed whatever the paperwork."""
    return [line for line in lines if line.kind != "duty"]


def total_by_currency(lines: list[CostLineOut]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for line in lines:
        totals[line.currency] += line.amount_minor
    return dict(totals)


def apply_rules(
    rules: list[PlaybookRule], facts: dict[str, Any]
) -> tuple[list[RuleResultOut], int]:
    """Step 4: (rules that fired, enabled rules that are stored only)."""
    fired = [
        RuleResultOut(
            rule_id=rule.id,
            text=rule.text,
            action=rule.action,
            note=rule.action_note,
            conditions=[rule_checks.describe_condition(c) for c in rule.conditions],
        )
        for rule in rules
        if rule.enabled and rule.conditions and rule_checks.rule_fires(rule.conditions, facts)
    ]
    return fired, sum(rule.enabled and not rule.conditions for rule in rules)


def suggest_action(
    order: Order,
    missing_data: list[str],
    gaps: list[RequirementCheckOut],
    lines: list[CostLineOut],
    unpriced: list[UnpricedCostOut],
    lead_days: int,
    today: date,
) -> SuggestedActionOut:
    """Step 5: one action, in code. Drafting the supplier message is phase 3."""
    if missing_data:
        return SuggestedActionOut(kind="complete_data", text=missing_data[0])
    titles = ", ".join(g.title for g in gaps)
    delay = next((line for line in lines if line.kind == "delay"), None)
    if gaps and delay:
        return SuggestedActionOut(
            kind="move_ship_date",
            text=f"{order.supplier} needs {lead_days} days to send: {titles}. Move the ship "
            f"date by {delay.quantity} days, or ship once the documents are in.",
            request_by=today,
        )
    if gaps:
        request_by = order.ship_date - timedelta(days=lead_days)
        return SuggestedActionOut(
            kind="request_documents",
            text=f"Ask {order.supplier} for: {titles}, by {request_by.isoformat()}.",
            request_by=request_by,
        )
    duties = [
        f"{d.label} adds {money(d.amount_minor, d.currency)}" for d in lines if d.kind == "duty"
    ]
    duties += [f"{u.label}: {u.reason}" for u in unpriced]
    if duties:
        return SuggestedActionOut(
            kind="recheck_landed_cost", text="Recheck the landed cost: " + "; ".join(duties)
        )
    return SuggestedActionOut(kind="none", text="Nothing to do for this order.")


def audit_report(content: ReportContentOut, rule_ids: set[uuid.UUID]) -> AuditResultOut:
    """Step 6: every finding cites a quote, every number re-computes, every rule exists."""
    problems = []
    for finding in content.findings:
        if not finding.source.quote.strip():
            problems.append(f"Finding '{finding.title}' has no quote from its source.")
    for line in content.cost_lines:
        if line.kind == "duty":
            expected = duty_amount(line.base_amount_minor or 0, Decimal(str(line.rate_percent)))
        else:
            expected = (line.unit_amount_minor or 0) * line.quantity
        if line.amount_minor != expected:
            problems.append(f"Cost line '{line.label}' doesn't re-compute: {expected}.")
        if not line.basis or any(b.type == "regulation" and not b.source for b in line.basis):
            problems.append(f"Cost line '{line.label}' doesn't say where its number came from.")
    if content.cost_totals != total_by_currency(content.cost_lines) or (
        content.problem_cost_totals != total_by_currency(problem_lines(content.cost_lines))
    ):
        problems.append("The totals don't match the cost lines.")
    problems += [
        f"Rule '{r.text}' isn't in the playbook."
        for r in content.rules_fired
        if r.rule_id not in rule_ids
    ]
    gaps = any(f.status in GAP_STATUSES for f in content.findings)
    if gaps and content.suggested_action.kind in ("none", "recheck_landed_cost"):
        problems.append("Documents are missing but the suggested action doesn't ask for them.")
    return AuditResultOut(passed=not problems, problems=problems)


def analyse_order(
    order: Order,
    *,
    gazetteer: trade_map_service.Gazetteer,
    requirements: dict[str, list[MarketRequirement]],
    sources: dict[uuid.UUID, RequirementSourceOut],
    documents: trade_map_service.SupplierDocs | None,
    settings: dict[str, CostSettingOut],
    rules: list[PlaybookRule],
    order_source: OrderSourceRowOut | None,
    today: date,
) -> OrderAnalysis:
    placement = trade_map_service.locate_destination(order.destination, gazetteer)
    applicable = [
        req
        for req in requirements.get(placement.market, [])
        if trade_map_service.applies_to(req, order.hs_code)
        and trade_map_service.applies_on(req, order.ship_date)
    ]
    findings = (
        trade_map_service.check_order(order, applicable, documents, sources)
        if placement.market
        else []
    )
    checked = list(zip(applicable, findings, strict=True))

    missing_data = []
    if not order.hs_code:
        missing_data.append(
            "Add the HS code, or ask for a suggested one: without it only the requirements for every "
            "product are checked."
        )
    if not placement.market:
        missing_data.append(f"No checklist for {order.destination}: we can't say it is clear.")
    if any(f.status == "unknown" for f in findings):
        missing_data.append(f"Add {order.supplier} to the suppliers, with their documents.")

    days_until_ship = (order.ship_date - today).days
    lines = price_problems(order, checked, settings, days_until_ship)
    unpriced = unpriced_duties(order, checked)
    totals = total_by_currency(lines)
    problem_totals = total_by_currency(problem_lines(lines))
    gaps = [f for f in findings if f.status in GAP_STATUSES]
    facts = {
        "market": placement.market,
        "supplier": order.supplier,
        "hs_code": order.hs_code,
        "order_value": {order.currency: order.value_minor},
        "days_until_ship": days_until_ship,
        "missing_documents": sorted(
            {
                req.document_kind
                for req, f in checked
                if f.status in GAP_STATUSES and req.document_kind
            }
        ),
        "estimated_cost": problem_totals,
    }
    fired, not_checked = apply_rules(rules, facts)
    action = suggest_action(
        order, missing_data, gaps, lines, unpriced, settings["supplier_lead_days"].value, today
    )
    content = ReportContentOut(
        order=OrderOut.from_order(order),
        order_source=order_source,
        market=placement.market,
        findings=findings,
        missing_data=missing_data,
        days_until_ship=days_until_ship,
        cost_lines=lines,
        cost_totals=totals,
        problem_cost_totals=problem_totals,
        unpriced_costs=unpriced,
        rules_fired=fired,
        rules_not_checked=not_checked,
        suggested_action=action,
        audit=AuditResultOut(passed=True, problems=[]),
    )
    content.audit = audit_report(content, {r.id for r in rules})

    # Missing data is something to do, like a missing document: the order is never clear
    # without it, and its next step names what to add.
    order_status = OrderStatus.exposed if missing_data or gaps else OrderStatus.clear
    if not content.audit.passed or any(r.action == "owner_review" for r in fired):
        state = ReportState.needs_human_review
    else:
        state = ReportState.passed
    return OrderAnalysis(
        content=content,
        state=state,
        order_status=order_status,
        blocked=any(r.action == "block" for r in fired),
        facts=facts,
    )


def _run_steps(
    analyses: list[OrderAnalysis],
    requirement_count: int,
    rules: list[PlaybookRule],
    revision: int,
) -> list[RunStepOut]:
    n = len(analyses)
    markets = Counter(a.content.market for a in analyses if a.content.market)
    statuses = Counter(a.order_status for a in analyses)
    totals: dict[str, int] = defaultdict(int)
    for analysis in analyses:
        for currency, amount in analysis.content.cost_totals.items():
            totals[currency] += amount
    checked_rules = [r for r in rules if r.enabled and r.conditions]
    fired = sum(len(a.content.rules_fired) for a in analyses)
    actions = Counter(a.content.suggested_action.kind for a in analyses)
    review = sum(a.state == ReportState.needs_human_review for a in analyses)
    failed_audits = sum(not a.content.audit.passed for a in analyses)
    incomplete = sum(bool(a.content.missing_data) for a in analyses)
    return [
        RunStepOut(
            name="relevance",
            summary=f"{sum(markets.values())} of {n} orders ship to a market with a checklist"
            + (f" ({', '.join(sorted(markets))})." if markets else "."),
        ),
        RunStepOut(
            name="exposure",
            summary=f"{statuses[OrderStatus.exposed]} exposed ({incomplete} missing data), "
            f"{statuses[OrderStatus.clear]} clear. Checked against {requirement_count} market "
            "requirements.",
        ),
        RunStepOut(
            name="cost",
            summary="Estimated cost: "
            + (", ".join(money(v, c) for c, v in sorted(totals.items())) or "none")
            + ".",
        ),
        RunStepOut(
            name="playbook",
            summary=f"{len(checked_rules)} checked rules (playbook revision {revision}) fired "
            f"{fired} times. {sum(r.enabled and not r.conditions for r in rules)} enabled rules "
            "are stored only, not checked.",
        ),
        RunStepOut(
            name="plan",
            summary=f"{n - actions['none']} orders have a suggested action.",
        ),
        RunStepOut(
            name="auditor",
            summary=f"{n - failed_audits} of {n} reports passed the checks; {review} go to "
            "human review.",
        ),
    ]


def start_run(db: Session, ctx: CompanyContext, order_ids: list[str] | None) -> RunOut:
    """Analyse the company's orders (all, or `order_ids`) and save a report for each."""
    started = time.perf_counter()
    if order_ids is None:
        orders = order_queries.list_company_orders(db, ctx.company_id)
    else:
        wanted = set(order_ids)
        orders = order_queries.list_orders_by_external_ids(db, ctx.company_id, wanted)
        unknown = wanted - {o.external_id for o in orders}
        if unknown:
            raise AppError(
                422,
                "unknown_orders",
                f"Unknown orders: {', '.join(sorted(unknown)[:10])}.",
                {"orderIds": "Use your order IDs, e.g. PO-2291"},
            )
    if not orders:
        raise AppError(422, "no_orders", "Import orders before running an analysis.")

    settings = cost_service.get_cost_settings(db, ctx.company_id)
    revision = playbook_queries.get_latest_revision_number(db, ctx.company_id)
    run = analysis_queries.add_run(
        db,
        AnalysisRun(
            company_id=ctx.company_id,
            status=RunStatus.running,
            order_count=len(orders),
            steps=[],
            playbook_revision=revision,
            cost_settings={
                k: s.model_dump(mode="json", by_alias=True) for k, s in settings.items()
            },
            created_by=ctx.user.id,
        ),
    )
    db.commit()
    try:
        analyses = _analyse_orders(db, ctx, orders, settings)
        reports = [
            AnalysisReport(
                run_id=run.id,
                company_id=ctx.company_id,
                order_id=order.id,
                state=analysis.state,
                order_status=analysis.order_status,
                blocked=analysis.blocked,
                content=analysis.content.model_dump(mode="json", by_alias=True),
            )
            for order, analysis in zip(orders, analyses, strict=True)
        ]
        analysis_queries.add_reports(db, reports)
        changes = []
        for order, analysis in zip(orders, analyses, strict=True):
            if order.status != analysis.order_status:
                changes.append(
                    OrderStatusChange(
                        company_id=ctx.company_id,
                        order_id=order.id,
                        from_status=order.status,
                        to_status=analysis.order_status,
                        source=StatusChangeSource.analysis,
                        run_id=run.id,
                        changed_by=ctx.user.id,
                    )
                )
            order.status = analysis.order_status
        order_queries.add_status_changes(db, changes)
        rules = playbook_queries.list_live_rules(db, ctx.company_id)
        run.steps = [
            s.model_dump(mode="json")
            for s in _run_steps(
                analyses,
                len(map_queries.list_requirements_in_force(db, ctx.company_id)),
                rules,
                revision,
            )
        ]
        run.status = RunStatus.done
        run.finished_at = datetime.now(UTC)
        audit_queries.record_audit_event(
            db,
            company_id=ctx.company_id,
            user_id=ctx.user.id,
            action="analysis.run_completed",
            object_type="analysis_run",
            object_id=str(run.id),
            data={
                "orders": len(orders),
                "states": dict(Counter(a.state.value for a in analyses)),
                "statusChanges": len(changes),
            },
        )
        db.commit()
    except Exception as error:
        db.rollback()
        run = analysis_queries.get_company_run(db, ctx.company_id, run.id)
        run.status = RunStatus.failed
        run.error = "The analysis stopped on an unexpected error."
        run.finished_at = datetime.now(UTC)
        db.commit()
        log.exception(
            "analysis.run_failed",
            extra={
                "company_id": str(ctx.company_id),
                "run_id": str(run.id),
                "error_type": type(error).__name__,
            },
        )
        raise AppError(500, "analysis_failed", "The analysis failed. Try again.")
    log.info(
        "analysis.run_completed",
        extra={
            "company_id": str(ctx.company_id),
            "run_id": str(run.id),
            "orders": len(orders),
            "states": dict(Counter(a.state.value for a in analyses)),
            "order_statuses": dict(Counter(a.order_status.value for a in analyses)),
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    return get_run(db, ctx, run.id)


def _analyse_orders(
    db: Session, ctx: CompanyContext, orders: list[Order], settings: dict[str, CostSettingOut]
) -> list[OrderAnalysis]:
    gazetteer = trade_map_service.load_gazetteer(db)
    requirements = trade_map_service.requirements_by_market(db, ctx.company_id)
    sources = trade_map_service.load_requirement_sources(db, requirements)
    suppliers = map_queries.list_company_suppliers(db, ctx.company_id)
    by_key = {s.name_key: s for s in suppliers}
    documents = trade_map_service.documents_by_supplier(db, suppliers)
    rules = playbook_queries.list_live_rules(db, ctx.company_id)
    positions = order_queries.list_import_row_positions(
        db, [o.source_row_id for o in orders if o.source_row_id]
    )
    today = datetime.now(UTC).date()
    analyses = []
    for order in orders:
        supplier = by_key.get(trade_map_service.supplier_name_key(order.supplier))
        position = positions.get(order.source_row_id) if order.source_row_id else None
        analyses.append(
            analyse_order(
                order,
                gazetteer=gazetteer,
                requirements=requirements,
                sources=sources,
                documents=documents[supplier.id] if supplier else None,
                settings=settings,
                rules=rules,
                order_source=OrderSourceRowOut(import_id=position[0], row_number=position[1])
                if position
                else None,
                today=today,
            )
        )
    return analyses


def _summary(report: AnalysisReport, external_id: str) -> ReportSummaryOut:
    return ReportSummaryOut(
        id=report.id,
        order_id=external_id,
        state=report.state,
        order_status=report.order_status,
        blocked=report.blocked,
        cost_totals=report.content["costTotals"],
        missing_data=report.content.get("missingData", []),
    )


def get_run(db: Session, ctx: CompanyContext, run_id: uuid.UUID) -> RunOut:
    run = analysis_queries.get_company_run(db, ctx.company_id, run_id)
    if not run:
        raise not_found_error("Run")
    return RunOut(
        id=run.id,
        status=run.status,
        order_count=run.order_count,
        steps=run.steps,
        playbook_revision=run.playbook_revision,
        cost_settings=list(run.cost_settings.values()),
        error=run.error,
        created_at=run.created_at,
        finished_at=run.finished_at,
        reports=[_summary(r, oid) for r, oid in analysis_queries.list_run_reports(db, run.id)],
    )


def report_out(report: AnalysisReport) -> ReportOut:
    return ReportOut(
        **ReportContentOut.model_validate(report.content).model_dump(),
        id=report.id,
        run_id=report.run_id,
        state=report.state,
        order_status=report.order_status,
        blocked=report.blocked,
        created_at=report.created_at,
    )


def get_report(db: Session, ctx: CompanyContext, report_id: uuid.UUID) -> ReportOut:
    report = analysis_queries.get_company_report(db, ctx.company_id, report_id)
    if not report:
        raise not_found_error("Report")
    return report_with_actions_out(db, ctx, report)


def report_with_actions_out(db: Session, ctx: CompanyContext, report: AnalysisReport) -> ReportOut:
    """The report, its owner review, feedback, and whether a supplier message can follow."""
    out = report_out(report)
    out.review = report_review.review_out(db, report)
    out.message_blocked_reason = report_review.message_blocked_reason(db, report)
    out.feedback = report_review.feedback_out(db, ctx, report.id)
    return out


def latest_exposures(db: Session, order: Order) -> tuple[uuid.UUID | None, list[ExposureOut]]:
    """The order's latest report ID and the problems it found, for the order page."""
    report = analysis_queries.get_latest_order_report(db, order.id)
    if not report:
        return None, []
    content = ReportContentOut.model_validate(report.content)
    return report.id, [
        ExposureOut(
            report_id=report.id,
            requirement_key=f.requirement_key,
            title=f.title,
            status=f.status,
            note=f.note,
            source=f.source,
        )
        for f in content.findings
        if f.status in GAP_STATUSES
    ]
