import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database.models import Solution, SolutionNote, SolutionUse


def add_solution(db: Session, solution: Solution) -> Solution:
    db.add(solution)
    db.flush()
    return solution


def get_company_solution(
    db: Session, company_id: uuid.UUID, solution_id: uuid.UUID, *, for_update: bool = False
) -> Solution | None:
    stmt = select(Solution).where(Solution.id == solution_id, Solution.company_id == company_id)
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def list_problem_solutions(
    db: Session,
    company_id: uuid.UUID,
    problems: list[tuple[str, str, str]],
) -> list[Solution]:
    """Every solution for any of `problems` (market, requirement key, problem status), newest
    first, expired and rejected ones included."""
    if not problems:
        return []
    keys = func.row(Solution.market_code, Solution.requirement_key, Solution.problem_status)
    return list(
        db.scalars(
            select(Solution)
            .where(Solution.company_id == company_id, keys.in_(problems))
            .order_by(Solution.created_at.desc(), Solution.id)
        )
    )


def list_company_solutions(db: Session, company_id: uuid.UUID) -> list[Solution]:
    """Every solution the company has, newest first, expired and rejected ones included."""
    return list(
        db.scalars(
            select(Solution)
            .where(Solution.company_id == company_id)
            .order_by(Solution.created_at.desc(), Solution.id)
        )
    )


def add_solution_note(db: Session, note: SolutionNote) -> SolutionNote:
    db.add(note)
    db.flush()
    return note


def list_solution_notes(db: Session, solution_ids: list[uuid.UUID]) -> list[SolutionNote]:
    """Oldest first, so they read as a conversation."""
    if not solution_ids:
        return []
    return list(
        db.scalars(
            select(SolutionNote)
            .where(SolutionNote.solution_id.in_(solution_ids))
            .order_by(SolutionNote.created_at, SolutionNote.id)
        )
    )


def add_solution_use(db: Session, use: SolutionUse) -> SolutionUse:
    db.add(use)
    db.flush()
    return use


def list_report_solution_uses(db: Session, report_id: uuid.UUID) -> list[SolutionUse]:
    """Newest first: the first one per requirement key is the case's current answer."""
    return list(
        db.scalars(
            select(SolutionUse)
            .where(SolutionUse.report_id == report_id)
            .order_by(SolutionUse.created_at.desc(), SolutionUse.id.desc())
        )
    )


def count_solution_uses(db: Session, solution_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """How many orders' problems each solution was chosen for."""
    if not solution_ids:
        return {}
    rows = db.execute(
        select(SolutionUse.solution_id, func.count(func.distinct(SolutionUse.report_id)))
        .where(SolutionUse.solution_id.in_(solution_ids))
        .group_by(SolutionUse.solution_id)
    ).all()
    return {solution_id: count for solution_id, count in rows}
