"""The daily news scan (moved from the AI service's scan.js): read the enabled sources, ask Gemini
which items each new article could affect, in the demo's sample stock and in each company's own
goods (services/news_goods.py), and store the articles, alerts and scan in Firestore; then make
them searchable by the assistant (core/rag_index.py).

Articles are assessed once: a scan skips any article an earlier scan analysed, so it reads every
article in the feeds it hasn't seen, back to the age rule. Articles Gemini couldn't assess, and
those Model Armor couldn't screen, stay unseen, so the next scan retries them.

It runs as the Cloud Run job exportmate-backend-news-scan (app/run_news_scan.py): Cloud Scheduler
starts it daily, and "Scan now" (POST /news-scans) starts it after taking the lock. One scan runs
at a time: the lock (Firestore `locks/scan`) is claimed in a transaction."""

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from google.api_core.exceptions import NotFound

from app.core import gemini
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.feeds import fetch_feed
from app.core.model_armor import ModelArmor, Screening
from app.core.rag_index import RagEngine, alert_doc, article_doc, index_docs, sync_source_docs
from app.core.untrusted_text import find_injection
from app.database.news_store import NewsStore, get_news_store
from app.services.news_alerts import alert_visible
from app.services.news_scan_rules import (
    SAMPLE_STOCK_PROFILE,
    SCAN_POLICY_VERSION,
    Assessments,
    assessment_prompt,
    clean_mentions,
    collect_candidates,
    company_reading,
    decide,
)
from app.services.news_sources import NewsAccess

MAX_NEW_ARTICLES = 80
BATCH = 16
# Batches sent to Gemini at once, so a first scan's read-back doesn't wait for each in turn.
PARALLEL_BATCHES = 4
# A company's first scan after its goods are known also reads back over this much stored news
# (the articles it can see). The cap fits about two weeks of the default sources.
BACKFILL_DAYS = 14
MAX_BACKFILL_ARTICLES = 160
# Companies whose goods one scan reads news for, most recently refreshed first.
MAX_COMPANIES = 100
MAX_OUTPUT_TOKENS = 16384
FEED_READERS = 16

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def assess(batch: list[dict], items: list[dict], profile: dict) -> list[dict]:
    """Gemini's assessment of each article in a batch against the stock (also run by the scan
    exam, app/news_scan_eval.py)."""
    settings = get_settings()
    today = datetime.now(UTC).date().isoformat()
    answer = gemini.generate_json(
        "news_scan",
        assessment_prompt(batch, items, profile, today),
        Assessments,
        thinking_level=settings.gemini_thinking_scan,
        max_output_tokens=MAX_OUTPUT_TOKENS,
        timeout_seconds=settings.scan_gemini_timeout_seconds,
    )
    return [a.model_dump(exclude_none=True) for a in answer.assessments]


def error_text(error: Exception) -> str:
    """A failed Gemini call as a sentence: the API's own error, not our wrapper's."""
    cause = error.__cause__ or error
    return str(getattr(cause, "message", None) or cause)


def assess_all(articles: list[dict], items: list[dict], profile: dict, scan_id: str, on_verdict):
    """Gemini's verdict on each article, BATCH per call and PARALLEL_BATCHES calls at once;
    `on_verdict(article, assessment, index in its batch)`. A batch that fails is logged and
    skipped. Returns how many articles went unassessed and the first error."""
    batches = [articles[i : i + BATCH] for i in range(0, len(articles), BATCH)]

    def one(batch: list[dict]) -> list[dict] | Exception:
        try:
            return assess(batch, items, profile)
        except AppError as error:
            return error

    failed, first_error = 0, None
    with ThreadPoolExecutor(max_workers=PARALLEL_BATCHES) as pool:
        for batch, result in zip(batches, pool.map(one, batches), strict=True):
            if isinstance(result, Exception):
                failed += len(batch)
                first_error = first_error or error_text(result)
                log.error(
                    "scan.batch_failed",
                    extra={
                        "scan_id": scan_id,
                        "articles": len(batch),
                        "company_id": profile.get("companyId"),
                        "error": error_text(result),
                    },
                )
                continue
            by_index = {r["index"]: r for r in result}
            for n, article in enumerate(batch):
                if n in by_index:
                    on_verdict(article, by_index[n], n)
    return failed, first_error


def alert_of(article: dict, r: dict, affected: list[dict], scan_id: str, company_id=None) -> dict:
    """The alert for an article and Gemini's assessment `r`. A company's alert carries its
    companyId (only that company sees it) and an id of its own; the sample stock's is keyed by
    the article."""
    values = [x["stockValueUsd"] for x in affected if "stockValueUsd" in x]
    alert = {
        "impactId": f"{article['id']}~{company_id}" if company_id else article["id"],
        **({"companyId": company_id} if company_id else {}),
        "articleId": article["id"],
        "title": article.get("title"),
        "url": article.get("url"),
        "publisher": article.get("publisher") or article.get("sourceName"),
        "sourceId": article.get("sourceId"),
        "sourceName": article.get("sourceName"),
        "sourceIds": article.get("sourceIds"),
        "sourceCompanyIds": article.get("sourceCompanyIds"),
        "publishedAt": article.get("publishedAt"),
        "ageDays": article.get("ageDays"),
        "severity": r.get("severity") or "low",
        "direction": r.get("direction") or "watch",
        "headline": r.get("headline") or article.get("title"),
        "why": r.get("why") or "",
        "action": r.get("action") or "",
        "affected": affected,
        "mentions": clean_mentions(r.get("mentions")),
        **({"stockValueUsd": sum(values)} if values else {}),
        "scanId": scan_id,
        "createdAt": _now_iso(),
        "status": "open",
    }
    return alert


def _access(company_id: str, settings: dict) -> NewsAccess:
    disabled = settings.get("disabled")
    return NewsAccess(
        company_id=company_id,
        disabled=list(disabled) if isinstance(disabled, list) else [],
        skip_old_off=settings.get("skipOld") is False,
    )


def scan_companies(
    store: NewsStore, scan_id: str, fresh: list[dict], sources_by_id: dict, settings_of: dict
) -> dict:
    """Each company's own goods against the articles it can see (its sources and age rule):
    this scan's new articles, and on its first scan the recent stored ones too."""
    lists = [g for g in store.list_goods_for_scan(MAX_COMPANIES) if g.get("items")]
    result = {"companies": len(lists), "found": [], "failed": 0, "error": None}
    max_age_days = get_settings().scan_max_age_days
    backlog = None
    for goods in lists:
        access = _access(goods["id"], settings_of.get(goods["id"], {}))
        if not goods.get("backfilledAt") and backlog is None:
            since = datetime.now(UTC) - timedelta(days=BACKFILL_DAYS)
            stored = store.list_recent_articles(
                since.isoformat(timespec="milliseconds").replace("+00:00", "Z"), 400
            )
            backlog = [a for a in stored if not a.get("withheld")]

        def visible(article: dict, access: NewsAccess = access) -> bool:
            return alert_visible(article, sources_by_id, access, max_age_days)

        reading = company_reading(
            fresh, visible, None if goods.get("backfilledAt") else backlog, MAX_BACKFILL_ARTICLES
        )
        profile = {**(goods.get("profile") or {}), "companyId": goods["id"]}
        by_sku = {i["sku"]: i for i in goods["items"]}

        def on_verdict(article, r, n, goods=goods, profile=profile, by_sku=by_sku):
            relevant, affected, _, _ = decide(article, r, n, by_sku, profile)
            if relevant:
                result["found"].append(alert_of(article, r, affected, scan_id, goods["id"]))

        failed, error = assess_all(reading, goods["items"], profile, scan_id, on_verdict)
        result["failed"] += failed
        result["error"] = result["error"] or error
        if not goods.get("backfilledAt"):
            store.save_company_goods(goods["id"], {"backfilledAt": _now_iso()})
    return result


def _read_feeds(sources: list[dict]) -> tuple[list[list[dict] | None], list[dict]]:
    """Every source's articles (None when it failed) and its status, with its owner (None when
    shared), so a caller is only shown the sources it can see."""

    def read(source: dict) -> list[dict] | Exception:
        try:
            return fetch_feed(source["url"])
        except Exception as error:  # noqa: BLE001 (any failure is that source's status)
            return error

    with ThreadPoolExecutor(max_workers=FEED_READERS) as pool:
        results = list(pool.map(read, sources))
    fetched, status = [], []
    for source, result in zip(sources, results, strict=True):
        ok = not isinstance(result, Exception)
        fetched.append(result if ok else None)
        shared = bool(source.get("builtIn")) or not source.get("companyId")
        status.append(
            {
                "id": source["id"],
                "name": source.get("name"),
                "companyId": None if shared else source.get("companyId"),
                "ok": ok,
                "count": len(result) if ok else 0,
                "error": None if ok else str(result),
            }
        )
    return fetched, status


def _screen(articles: list[dict]) -> list[Screening]:
    template = get_settings().model_armor_template
    if not template:
        return [Screening() for _ in articles]
    texts = [
        f"{a.get('title')}\n{a.get('snippet')}\n{a.get('publisher') or ''}\n{a.get('url')}"
        for a in articles
    ]
    return ModelArmor(template).screen_each(texts)


def _index(store: NewsStore, analysed: list[dict], found: list[dict]) -> dict | None:
    """Makes the new articles and alerts searchable, and catches up the sources' records
    (the backend changes sources without indexing them). None when no bucket is set."""
    settings = get_settings()
    if not settings.rag_bucket:
        return None
    engine = RagEngine(
        settings.google_cloud_project,
        settings.rag_location,
        settings.rag_bucket,
        settings.rag_embed_model,
    )
    docs = [article_doc(a) for a in analysed if not a.get("withheld")]
    docs += [alert_doc(f) for f in found]
    indexed = index_docs(docs, store, engine)
    indexed["sources"] = sync_source_docs(store.list_sources(), store, engine)
    return indexed


def run_scan(trigger: str = "manual", scan_id: str | None = None) -> dict:
    """One scan. `scan_id`: the record "Scan now" made; otherwise one is made here."""
    store = get_news_store()
    settings = get_settings()
    max_age_days = settings.scan_max_age_days
    started = datetime.now(UTC)
    record = {
        "startedAt": started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "trigger": trigger,
        "status": "running",
        "model": settings.gemini_model,
        "policyVersion": SCAN_POLICY_VERSION,
    }
    if scan_id:
        store.update_scan(scan_id, record)
    else:
        scan_id = store.start_scan(record)
    try:
        summary = _scan(store, scan_id, started, max_age_days)
    except Exception as error:
        log.exception("scan.failed", extra={"scan_id": scan_id, "trigger": trigger})
        store.update_scan(
            scan_id, {"status": "failed", "finishedAt": _now_iso(), "error": str(error)[:300]}
        )
        raise
    store.update_scan(scan_id, summary)
    level = logging.ERROR if summary["status"] == "failed" else logging.INFO
    if summary["status"] != "failed" and (
        summary["articlesFailed"] or summary["companyArticlesFailed"] or "indexError" in summary
    ):
        level = logging.WARNING
    log.log(
        level,
        "scan.completed",
        extra={"scan_id": scan_id, "trigger": trigger}
        | {k: v for k, v in summary.items() if k not in ("sources", "companyImpacts")},
    )
    return {"id": scan_id, **record, **summary}


def _scan(store: NewsStore, scan_id: str, started: datetime, max_age_days: int) -> dict:
    all_sources = store.list_sources()
    sources = [s for s in all_sources if s.get("enabled") is True]
    items = store.list_sample_stock()
    company_settings = store.list_company_settings()
    # Companies that switched the age rule off read old articles from their sources.
    old_readers = (
        [_access(i, c) for i, c in company_settings.items() if c.get("skipOld") is False]
        if max_age_days > 0
        else []
    )

    # 1. Read every enabled source, and keep the articles the age rule allows.
    fetched, source_status = _read_feeds(sources)
    candidates, too_old = collect_candidates(
        fetched, sources, at=started, max_age_days=max_age_days, old_readers=old_readers
    )

    # 2. Skip articles analysed in earlier scans.
    seen = store.find_analysed_articles(list(candidates))
    newest = sorted(
        (a for a in candidates.values() if a["id"] not in seen),
        key=lambda a: a.get("publishedAt") or "",
        reverse=True,
    )[:MAX_NEW_ARTICLES]

    # 3. Withhold articles that address an assistant (prompt injection) or link to known
    # malicious sites: the patterns first, then Model Armor when it is set up. Withheld
    # articles are recorded as analysed and not relevant, never sent to Gemini or indexed.
    analysed: list[dict] = []
    to_screen: list[dict] = []
    for article in newest:
        text = f"{article.get('title')}\n{article.get('snippet')}\n{article.get('publisher')}"
        match = find_injection(text)
        if match:
            analysed.append({**article, "relevant": False, "withheld": match})
        else:
            to_screen.append(article)
    fresh: list[dict] = []
    unscreened: list[str] = []
    for article, screening in zip(to_screen, _screen(to_screen), strict=True):
        if screening.error:
            unscreened.append(screening.error)
        elif screening.match:
            analysed.append({**article, "relevant": False, "withheld": screening.match})
        else:
            fresh.append(article)
    if unscreened:
        log.error(
            "scan.armor_failed",
            extra={"scan_id": scan_id, "articles": len(unscreened), "error": unscreened[0]},
        )

    # 4. Ask Gemini which sample stock each article touches. Articles of a batch that fails
    # stay unrecorded, so the next scan retries them.
    found: list[dict] = []
    by_sku = {i["sku"]: i for i in items}

    def on_sample(article, r, n):
        relevant, affected, _, other = decide(article, r, n, by_sku, SAMPLE_STOCK_PROFILE)
        analysed.append(
            {
                **article,
                "relevant": relevant,
                **({"filteredOut": "other_commodity"} if other else {}),
            }
        )
        if relevant:
            found.append(alert_of(article, r, affected, scan_id))

    failed, sample_error = assess_all(fresh, items, SAMPLE_STOCK_PROFILE, scan_id, on_sample)
    sample_alerts = len(found)
    # 4b. The same articles (and on a company's first scan, recent ones) for each company.
    sources_by_id = {s["id"]: s for s in all_sources}
    companies = scan_companies(store, scan_id, fresh, sources_by_id, company_settings)
    found += companies["found"]
    company_impacts: dict[str, int] = {}
    for alert in companies["found"]:
        company_impacts[alert["companyId"]] = company_impacts.get(alert["companyId"], 0) + 1

    # 5. Store articles and alerts.
    analysed_at = _now_iso()
    store.save_scan_results(
        {
            a["id"]: {k: v for k, v in a.items() if k != "id"}
            | {"analysedAt": analysed_at, "scanId": scan_id}
            for a in analysed
        },
        {f["impactId"]: {k: v for k, v in f.items() if k != "impactId"} for f in found},
    )

    # 6. Make them searchable by the assistant. A failed import isn't retried by later scans
    # (they skip analysed articles); the AI service's `npm run index` rebuilds the index, and
    # the scan record's indexError is what tells ops to run it.
    indexed, index_error = None, None
    try:
        indexed = _index(store, analysed, found)
    except Exception as error:  # noqa: BLE001 (recorded on the scan)
        index_error = str(error)
        log.error("scan.index_failed", extra={"scan_id": scan_id, "error": index_error})

    now = _now_iso()
    for status in source_status:
        try:
            store.update_source(
                status["id"],
                {
                    "lastFetchedAt": now,
                    "lastOk": status["ok"],
                    "lastError": status["error"],
                    "lastCount": status["count"],
                },
            )
        except NotFound:  # removed during the scan
            log.warning("scan.source_status_skipped", extra={"source_id": status["id"]})

    # A scan that had articles to assess and got no answer for any of them failed; one that
    # lost some batches is done and says how many.
    assessed = len(fresh) - failed
    summary = {
        "status": "failed" if fresh and not assessed else "done",
        "finishedAt": now,
        "maxAgeDays": max_age_days or None,
        "sources": source_status,
        "articlesFetched": len(candidates),
        "articlesTooOld": too_old,
        "articlesAnalysed": len(analysed),
        "articlesFailed": failed,
        "articlesWithheld": sum(1 for a in analysed if a.get("withheld")),
        "articlesUnscreened": len(unscreened),
        "modelArmor": bool(get_settings().model_armor_template),
        # Sample-stock alerts; each company's own are counted in companyImpacts.
        "impactsFound": sample_alerts,
        "companiesScanned": companies["companies"],
        "companyImpacts": company_impacts,
        "companyArticlesFailed": companies["failed"],
        # Records sent to RAG Engine (new or changed); None when the import failed or is off.
        "indexed": indexed["imported"] if indexed else None,
    }
    if sample_error:
        summary["error"] = (
            f"Gemini couldn't assess {failed} of {len(fresh)} articles: {sample_error[:300]}"
        )
    if companies["error"]:
        summary["companyError"] = companies["error"][:300]
    if index_error:
        summary["indexError"] = index_error[:300]
    return summary
