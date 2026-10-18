"""What people's verdicts say about each chain link.

A News watch suggestion found through a supplier keeps its path (`news_order_reviews.path`), so
each verdict counts for every link on that path. A link that keeps showing up in rejected
suggestions is doubted: at a company once its people rejected it at least
`MIN_COMPANY_REJECTIONS` times and more often than they confirmed it, and for everyone once
`MIN_SHARED_REJECTIONS` rejections across companies say the same. The walk then avoids doubted
links when an equally short path exists, and marks those it still needs, so nobody edits links by
hand and nothing is hidden.
"""

import uuid
from collections import Counter
from dataclasses import dataclass
from itertools import pairwise

from sqlalchemy.orm import Session

from app.database.models import NewsVerdict
from app.database.queries import news_reviews as news_queries

MIN_COMPANY_REJECTIONS = 2
MIN_SHARED_REJECTIONS = 5
COMPANY_DOUBT = "Often rejected at your company"
SHARED_DOUBT = "Often rejected across companies"

LinkKey = tuple[str, str]  # (from node key, to node key)


@dataclass(frozen=True)
class LinkVerdicts:
    confirmed: int = 0
    rejected: int = 0

    def doubted(self, min_rejections: int) -> bool:
        return self.rejected >= min_rejections and self.rejected > self.confirmed


@dataclass(frozen=True)
class LinkFeedback:
    company: LinkVerdicts
    everyone: LinkVerdicts

    @property
    def doubt(self) -> str | None:
        if self.company.doubted(MIN_COMPANY_REJECTIONS):
            return COMPANY_DOUBT
        if self.everyone.doubted(MIN_SHARED_REJECTIONS):
            return SHARED_DOUBT
        return None


def path_links(path: list[dict] | None) -> list[LinkKey]:
    """The chain links on a stored path: consecutive product steps with node keys (paths stored
    before steps had keys give none)."""
    steps = path or []
    return [
        (before["key"], step["key"])
        for before, step in pairwise(steps)
        if before.get("kind") == step.get("kind") == "product"
        and before.get("key")
        and step.get("key")
    ]


def _count(reviews) -> dict[LinkKey, LinkVerdicts]:
    counts: Counter = Counter()
    for review in reviews:
        verdict = "confirmed" if review.verdict == NewsVerdict.relevant else "rejected"
        for link in path_links(review.path):
            counts[(link, verdict)] += 1
    links = {link for link, _ in counts}
    return {
        link: LinkVerdicts(counts[(link, "confirmed")], counts[(link, "rejected")])
        for link in links
    }


def link_feedback(db: Session, company_id: uuid.UUID) -> dict[LinkKey, LinkFeedback]:
    """Each judged link's verdicts at this company and across every company."""
    reviews = news_queries.list_reviews_with_path(db)
    company = _count(r for r in reviews if r.company_id == company_id)
    everyone = _count(reviews)
    return {
        link: LinkFeedback(company.get(link, LinkVerdicts()), verdicts)
        for link, verdicts in everyone.items()
    }
