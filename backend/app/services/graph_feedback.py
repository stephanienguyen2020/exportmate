"""What people's verdicts say about each chain link.

A News watch suggestion found through a supplier keeps its path (`news_order_reviews.path`), so
each verdict counts for every link on that path. A link that keeps showing up in rejected
suggestions is doubted: at a company once its people rejected it at least
`MIN_COMPANY_REJECTIONS` times and more often than they confirmed it, and for everyone once
`MIN_SHARED_REJECTIONS` rejections across companies say the same. The walk then avoids doubted
links when an equally short path exists, and marks those it still needs, so nobody edits links by
hand and nothing is hidden.

A company's own verdicts count straight away. Every company's are counted by the nightly link
weights job (`app/update_link_weights.py`, `count_link_weights`) into `graph_link_weights`, with
each link's weight, so a walk doesn't read every company's reviews.
"""

import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import pairwise

from sqlalchemy.orm import Session

from app.database.models import NewsVerdict
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import news_reviews as news_queries

MIN_COMPANY_REJECTIONS = 2
MIN_SHARED_REJECTIONS = 5
COMPANY_DOUBT = "Often rejected at your company"
SHARED_DOUBT = "Often rejected across companies"
UNJUDGED_WEIGHT = 0.5

LinkKey = tuple[str, str]  # (from node key, to node key)


@dataclass(frozen=True)
class LinkVerdicts:
    confirmed: int = 0
    rejected: int = 0

    def doubted(self, min_rejections: int) -> bool:
        return self.rejected >= min_rejections and self.rejected > self.confirmed

    @property
    def weight(self) -> float:
        """The share confirmed, smoothed: an unjudged link is 0.5, and one verdict moves it a
        little (one rejection: 0.33; three confirmations: 0.8)."""
        return round((self.confirmed + 1) / (self.confirmed + self.rejected + 2), 4)


@dataclass(frozen=True)
class LinkFeedback:
    company: LinkVerdicts
    everyone: LinkVerdicts  # as of the last link weights job
    weight: float = UNJUDGED_WEIGHT

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


def count_link_weights(db: Session, now: datetime | None = None) -> list[dict]:
    """Every company's verdicts per link with its weight: the nightly job's rows."""
    updated_at = now or datetime.now(UTC)
    return [
        {
            "from_key": from_key,
            "to_key": to_key,
            "confirmed": verdicts.confirmed,
            "rejected": verdicts.rejected,
            "weight": verdicts.weight,
            "updated_at": updated_at,
        }
        for (from_key, to_key), verdicts in sorted(
            _count(news_queries.list_reviews_with_path(db)).items()
        )
    ]


def weights_updated_at(db: Session) -> datetime | None:
    """When the link weights job last counted, or None before its first run."""
    return max((w.updated_at for w in graph_queries.list_link_weights(db)), default=None)


def link_feedback(db: Session, company_id: uuid.UUID) -> dict[LinkKey, LinkFeedback]:
    """Each judged link's verdicts at this company (live) and across every company (as of the
    last link weights job), with its weight."""
    company = _count(news_queries.list_reviews_with_path(db, company_id))
    shared = {(w.from_key, w.to_key): w for w in graph_queries.list_link_weights(db)}
    feedback = {}
    for link in set(company) | set(shared):
        stored = shared.get(link)
        feedback[link] = LinkFeedback(
            company=company.get(link, LinkVerdicts()),
            everyone=LinkVerdicts(stored.confirmed, stored.rejected) if stored else LinkVerdicts(),
            weight=stored.weight if stored else UNJUDGED_WEIGHT,
        )
    return feedback
