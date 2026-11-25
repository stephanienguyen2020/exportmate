from datetime import datetime

from app.schemas.common import CamelCaseModel


class RateOut(CamelCaseModel):
    right: int
    of: int
    rate: float | None
    low: float | None  # 95% Wilson interval
    high: float | None


class HsBenchmarkMetricsOut(CamelCaseModel):
    top1: RateOut  # the first suggestion is the ruled 6-digit code
    top3: RateOut  # the ruled code is among the suggestions
    heading: RateOut  # the first suggestion is in the ruled 4-digit heading
    retrieval: RateOut  # the tariff search showed the ruled code to the AI
    nearest_line: RateOut  # baseline: the closest tariff line by embedding, no AI
    no_suggestion: int
    errors: int


class HsBenchmarkOut(CamelCaseModel):
    """The latest full scoring of HS code suggestions on held-out customs rulings."""

    created_at: datetime
    model: str
    embedding_model: str
    dataset: dict  # source, sourceUrl, licence, licenceUrl, downloadedOn, rulingsListed, sampled
    case_count: int
    metrics: HsBenchmarkMetricsOut
