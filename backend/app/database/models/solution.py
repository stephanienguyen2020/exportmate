"""Solutions: how to fix one kind of problem an analysis report found, kept for later orders.

A problem is a gap in a report (a document missing or wrong) for one market requirement. AI
drafts the steps from the report's facts, the requirement's cited text and the notes people left
on earlier solutions to the same problem. People add notes (how they handle it), adopt or reject
a solution, and record which one they used for which order. Every change is in the audit log.

A solution is offered for every later gap with the same market, requirement and problem until it
expires: past `valid_until`, or once the requirement cites another regulation version or leaves
the checklist (services/solutions.py works that out on each read). An expired solution is shown
for reference and is never the default; it can't be used, only analysed again.
"""

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class SolutionStatus(str, enum.Enum):
    suggested = "suggested"  # AI drafted it; nobody has judged it yet
    adopted = "adopted"  # a person said this is how the company handles it
    rejected = "rejected"  # a person said not to follow it; never the default


class Solution(Base):
    __tablename__ = "solutions"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    # The problem it solves: later gaps with the same three are offered it.
    market_code: Mapped[str] = mapped_column(String(10), nullable=False)
    requirement_key: Mapped[str] = mapped_column(String(40), nullable=False)
    problem_status: Mapped[str] = mapped_column(String(20), nullable=False)  # missing, mismatch
    # Where it was first written, to rank closer cases first. Not part of the match.
    hs_heading: Mapped[str | None] = mapped_column(String(4))
    supplier_name_key: Mapped[str | None] = mapped_column(String(200))
    report_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("analysis_reports.id", ondelete="SET NULL")
    )
    order_external_id: Mapped[str | None] = mapped_column(String(100))
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    steps: Mapped[list] = mapped_column(JSONB, nullable=False)  # [str], in order
    # The requirement's cited text when it was written. Another version in force expires it.
    regulation_document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regulation_documents.id"), nullable=False
    )
    document_version: Mapped[int] = mapped_column(Integer, nullable=False)
    source_quote: Mapped[str] = mapped_column(Text, nullable=False)
    valid_until: Mapped[date] = mapped_column(Date, nullable=False)  # last day it may be used
    model: Mapped[str] = mapped_column(String(100), nullable=False)  # the Gemini model
    # The expired solution this one was analysed again from.
    supersedes_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("solutions.id", ondelete="SET NULL")
    )
    status: Mapped[SolutionStatus] = mapped_column(
        pg_enum(SolutionStatus, "solution_status"),
        nullable=False,
        default=SolutionStatus.suggested,
    )
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (
        Index("ix_solutions_problem", "company_id", "market_code", "requirement_key"),
    )


class SolutionNote(Base):
    """A person's note on a solution: how they handle it. Never edited or deleted, and given
    to the AI the next time it writes a solution to the same problem."""

    __tablename__ = "solution_notes"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    solution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("solutions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_column()


class SolutionUse(Base):
    """A person chose this solution for one gap in one report. The latest use is the answer."""

    __tablename__ = "solution_uses"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    solution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("solutions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_reports.id", ondelete="CASCADE"), nullable=False
    )
    requirement_key: Mapped[str] = mapped_column(String(40), nullable=False)
    used_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (Index("ix_solution_uses_case", "report_id", "requirement_key"),)
