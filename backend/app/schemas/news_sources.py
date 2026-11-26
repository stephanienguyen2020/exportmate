from typing import Annotated

from pydantic import Field, StringConstraints

from app.schemas.common import CamelCaseModel


class NewsSourceOut(CamelCaseModel):
    """A feed News watch reads, as the caller sees it: `enabled` is whether it is read for the
    caller's company, `shared` whether every workspace has it (only the company's own can be
    removed). The `last*` fields are from the latest scan that read it."""

    id: str
    name: str
    url: str
    kind: str
    built_in: bool
    shared: bool
    enabled: bool
    added_at: str | None = None
    last_fetched_at: str | None = None
    last_ok: bool | None = None
    last_count: int | None = None
    last_error: str | None = None


class NewsSourceIn(CamelCaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]


class NewsSourceUpdate(CamelCaseModel):
    enabled: bool


class FeedArticleOut(CamelCaseModel):
    title: str
    url: str
    published_at: str | None
    snippet: str
    publisher: str


class NewsSourceAddedOut(CamelCaseModel):
    """The new source and the newest articles read from it, so the person sees it works."""

    source: NewsSourceOut
    sample: list[FeedArticleOut]


class NewsSettingsOut(CamelCaseModel):
    """The age rule as the caller's company has it: scans skip articles published more than
    `max_age_days` before them unless `skip_old` is false (then only it sees what they raise)."""

    max_age_days: int = Field(ge=1)
    skip_old: bool


class NewsSettingsUpdate(CamelCaseModel):
    skip_old: bool
