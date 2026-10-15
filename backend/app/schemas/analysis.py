import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.database.models import OrderStatus, ReportState, RunStatus
from app.schemas.common import CamelCaseModel
from app.schemas.cost_settings import CostSettingOut
from app.schemas.orders import OrderOut, OrderStatusChangeOut, SourceRowOut
from app.schemas.trade_map import RequirementCheckOut, RequirementSourceOut


class RunIn(CamelCaseModel):
    # The company's order IDs (e.g. "PO-2291"); omitted: every order.
    order_ids: list[str] | None = Field(default=None, min_length=1, max_length=10_000)


class CostBasisOut(CamelCaseModel):
    """Where a number in a cost line came from."""

    type: Literal["regulation", "company_setting", "default"]
    label: str
    setting_key: str | None = None  # for settings and defaults
    source: RequirementSourceOut | None = None  # for regulation figures, with the quote


class CostLineOut(CamelCaseModel):
    kind: Literal["missing_document", "new_test", "delay", "duty"]
    label: str
    requirement_key: str | None
    # amount = unit_amount × quantity, or base × rate / 100 for a duty (rounded half up)
    quantity: int
    unit_amount_minor: int | None
    base_amount_minor: int | None
    rate_percent: float | None
    amount_minor: int
    currency: str
    formula: str  # "14 days × USD 350.00"
    basis: list[CostBasisOut]


class UnpricedCostOut(CamelCaseModel):
    """A cost the regulation states but we can't price for this ship date, e.g. a duty rate
    that changes on or before it. Shown with no amount rather than a wrong one."""

    kind: Literal["duty"]
    label: str
    requirement_key: str
    reason: str  # "The rate changes on 2027-01-01, on or before the ship date: recheck it."
    source: RequirementSourceOut


class RuleResultOut(CamelCaseModel):
    rule_id: uuid.UUID
    text: str
    action: str  # flag, owner_review, block
    note: str | None
    conditions: list[str]  # "Days until ship date less than 21"


class SuggestedActionOut(CamelCaseModel):
    kind: Literal[
        "complete_data", "request_documents", "move_ship_date", "recheck_landed_cost", "none"
    ]
    text: str
    request_by: date | None = None  # the latest day to ask the supplier, given their lead time


class AuditResultOut(CamelCaseModel):
    passed: bool
    problems: list[str]


class OrderSourceRowOut(CamelCaseModel):
    import_id: uuid.UUID
    row_number: int


class ReportContentOut(CamelCaseModel):
    """Everything a report says, stored as JSON so it reads the same later."""

    order: OrderOut
    order_source: OrderSourceRowOut | None  # the CSV row the order came from
    market: str | None
    findings: list[RequirementCheckOut]  # every requirement checked, with its source and quote
    missing_data: list[str]
    days_until_ship: int
    cost_lines: list[CostLineOut]
    cost_totals: dict[str, int]  # every line, by currency, hundredths
    # Without duties: what the problems cost. Playbook rules on "estimated cost" use this.
    problem_cost_totals: dict[str, int]
    unpriced_costs: list[UnpricedCostOut]  # stated costs with no reliable amount for this date
    rules_fired: list[RuleResultOut]
    rules_not_checked: int  # enabled rules with no WHEN/THEN
    suggested_action: SuggestedActionOut
    audit: AuditResultOut


class PersonOut(CamelCaseModel):
    id: uuid.UUID
    name: str


class ReportReviewOut(CamelCaseModel):
    """The owner's review of a report a playbook rule sent to them."""

    reviewed_by: PersonOut
    reviewed_at: datetime
    note: str | None


class ReportFeedbackOut(CamelCaseModel):
    useful: int
    not_useful: int
    mine: bool | None  # the caller's own verdict, if any
    my_note: str | None


class ReportOut(ReportContentOut):
    id: uuid.UUID
    run_id: uuid.UUID
    state: ReportState
    order_status: OrderStatus
    blocked: bool  # a playbook rule blocks messages from this report
    created_at: datetime
    review: ReportReviewOut | None = None
    # Why no supplier message can be drafted from it (None: it can).
    message_blocked_reason: str | None = None
    feedback: ReportFeedbackOut | None = None


class ReportReviewIn(CamelCaseModel):
    note: str | None = Field(default=None, max_length=1000)


class ReportFeedbackIn(CamelCaseModel):
    useful: bool
    note: str | None = Field(default=None, max_length=1000)


class ReportSummaryOut(CamelCaseModel):
    id: uuid.UUID
    order_id: str
    state: ReportState
    order_status: OrderStatus
    blocked: bool
    cost_totals: dict[str, int]


class RunStepOut(CamelCaseModel):
    name: Literal["relevance", "exposure", "cost", "playbook", "plan", "auditor"]
    summary: str


class RunOut(CamelCaseModel):
    id: uuid.UUID
    status: RunStatus
    order_count: int
    steps: list[RunStepOut]
    playbook_revision: int
    cost_settings: list[CostSettingOut]  # the values this run used
    error: str | None
    created_at: datetime
    finished_at: datetime | None
    reports: list[ReportSummaryOut]


class ExposureOut(CamelCaseModel):
    """A problem the latest report found for an order (GET /orders/{id})."""

    report_id: uuid.UUID
    requirement_key: str
    title: str
    status: str  # missing, mismatch
    note: str
    source: RequirementSourceOut


class OrderDetailOut(CamelCaseModel):
    order: OrderOut
    source: SourceRowOut | None  # None for seeded orders
    exposures: list[ExposureOut]  # problems the latest report found; empty before any run
    latest_report_id: uuid.UUID | None = None  # the order's latest report; None before any run
    status_changes: list[OrderStatusChangeOut] = Field(default_factory=list)  # newest first
