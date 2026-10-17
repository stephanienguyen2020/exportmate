import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.database.models import SolutionStatus
from app.schemas.analysis import PersonOut
from app.schemas.common import CamelCaseModel


class SolutionDraft(BaseModel):
    """The AI's answer (checked in code before saving)."""

    summary: str
    steps: list[str]


class SolutionSuggestIn(CamelCaseModel):
    requirement_key: str = Field(min_length=1, max_length=40)


class SolutionWriteIn(CamelCaseModel):
    """A solution a person writes. No AI, so none of its checks: the service only tidies it and
    applies the same limits as the AI's answer."""

    requirement_key: str = Field(min_length=1, max_length=40)
    summary: str
    steps: list[str] = Field(default_factory=list)


class SolutionUseIn(CamelCaseModel):
    report_id: uuid.UUID


class SolutionNoteIn(CamelCaseModel):
    text: str = Field(min_length=1, max_length=2000)


class SolutionReviewIn(CamelCaseModel):
    verdict: Literal["adopted", "rejected"]
    note: str | None = Field(default=None, max_length=2000)  # saved as a note


class SolutionNoteOut(CamelCaseModel):
    id: uuid.UUID
    author: PersonOut
    text: str
    created_at: datetime


class SolutionBasisOut(CamelCaseModel):
    """The requirement text the solution was written from."""

    regulation_title: str
    document_id: uuid.UUID
    version_number: int
    source_url: str | None
    quote: str


class SolutionOut(CamelCaseModel):
    id: uuid.UUID
    market: str
    requirement_key: str
    problem_status: str  # missing, mismatch
    summary: str
    steps: list[str]
    status: SolutionStatus
    written_for: str | None  # the order ID it was first written for
    basis: SolutionBasisOut
    valid_until: date
    expired: bool
    # Why it can't be used any more: past its date, or the requirement changed.
    expired_reason: str | None
    model: str | None  # the Gemini model; None when a person wrote it
    created_by: PersonOut
    created_at: datetime
    reviewed_by: PersonOut | None
    reviewed_at: datetime | None
    supersedes_id: uuid.UUID | None
    used_for: int  # how many orders' problems it was chosen for
    notes: list[SolutionNoteOut]  # oldest first


class SolutionCaseOut(CamelCaseModel):
    """One problem in a report and the saved solutions for it."""

    requirement_key: str
    title: str
    problem_status: str
    note: str  # what the check found
    # The answer: the one chosen for this order if still valid, else the best valid one.
    # Never an expired or rejected solution.
    default: SolutionOut | None
    in_use: bool  # `default` was chosen for this order
    others: list[SolutionOut]  # other valid ones, rejected ones last
    expired: list[SolutionOut]  # for reference only; they must be analysed again
    # No valid solution: AI should be asked (again, when expired ones exist).
    needs_analysis: bool


class SolutionProblemOut(CamelCaseModel):
    """One kind of problem in the company's knowledge base, with every solution saved for it."""

    market: str
    requirement_key: str
    problem_status: str  # missing, mismatch
    title: str  # the requirement's title in force, else its key
    in_checklist: bool  # false once the requirement left the market's checklist
    # Valid before expired; adopted, then suggested, then rejected; newest first.
    solutions: list[SolutionOut]
