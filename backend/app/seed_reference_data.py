"""Load the shared trade-map reference data into Postgres.

Markets, countries, ports, document kinds, order statuses, per-market requirement checklists,
cost defaults and sample satellite observations, from the JSON files in app/seed_data/. Each market requirement cites
an official text (regulation_sources.json): the seed downloads each text once into a shared
regulation document. A market requirement whose text can't be downloaded is left out until
the next run.

Usage:  uv run python -m app.seed_reference_data
On Cloud Run it runs after migrations (backend/deploy.sh). Running it again updates rows in
place; checklist lines removed from the file are removed from the database.
"""

import argparse
import hashlib
import logging
import math
import re
import urllib.request
import uuid
from datetime import date

from sqlalchemy.orm import Session

from app.core import gemini
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging
from app.database.queries import hs_codes as hs_queries
from app.database.queries import orders as order_queries
from app.database.queries import regulations as regulation_queries
from app.database.queries import trade_map as map_queries
from app.database.session import open_session
from app.seed_data import load_seed_file
from app.services import regulations as regulation_service

log = logging.getLogger(__name__)


def sample_flood_extent(lon: float, lat: float, radius_km: float, seed: int) -> dict:
    """An irregular outline around a sample observation, so it doesn't read as a precise
    circle. GeoJSON Polygon, exterior ring counter-clockwise (RFC 7946)."""
    ring = []
    for i in range(65):
        t = i / 64 * 2 * math.pi
        km = radius_km * (1 + 0.22 * math.sin(3 * t + seed) + 0.1 * math.sin(7 * t + seed * 2))
        ring.append(
            [
                round(lon + km * math.cos(t) / (111.32 * math.cos(math.radians(lat))), 5),
                round(lat + km * math.sin(t) / 110.57, 5),
            ]
        )
    ring[-1] = ring[0]
    return {"type": "Polygon", "coordinates": [ring]}


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


def fetch_official_text(url: str, accept: str | None) -> bytes:
    headers = {"User-Agent": "ExportMate-seed/1.0"}
    if accept:
        headers["Accept"] = accept
        headers["Accept-Language"] = "eng"  # the EU Publications Office picks the language
    with urllib.request.urlopen(
        urllib.request.Request(url, headers=headers), timeout=60
    ) as r:  # per network read, not per file
        return r.read()


def seed_shared_regulations(db: Session) -> tuple[dict[str, uuid.UUID], list[str]]:
    """Store each official text once.

    Returns {document key: regulation document id} and the storage paths of files saved in
    this run (deleted again if the seed's commit fails)."""
    document_ids: dict[str, uuid.UUID] = {}
    saved_paths: list[str] = []
    for source in load_seed_file("regulation_sources.json")["regulations"]:
        regulation = regulation_queries.get_shared_regulation_by_official_id(
            db, source["officialId"]
        )
        for doc in source["documents"]:
            stored = regulation and regulation_queries.get_regulation_document_by_source_url(
                db, regulation.id, doc["sourceUrl"]
            )
            if not stored:
                try:
                    content = fetch_official_text(doc["download"], doc.get("accept"))
                    stored, saved = regulation_service.add_shared_regulation_document(
                        db,
                        official_id=source["officialId"],
                        regulation_title=source["title"],
                        title=doc["title"],
                        filename=doc["filename"],
                        content=content,
                        source_url=doc["sourceUrl"],
                    )
                except (OSError, AppError) as error:  # network errors are OSErrors
                    log.warning(
                        "seed.official_text_failed",
                        extra={"document_key": doc["key"], "error": str(error)},
                    )
                    continue
                if saved:
                    saved_paths.append(stored.storage_path)
                regulation = regulation_queries.get_shared_regulation_by_official_id(
                    db, source["officialId"]
                )
            document_ids[doc["key"]] = stored.id
    return document_ids, saved_paths


def seed_order_statuses(db: Session) -> int:
    """How each order status is named and shown, and which ones a person may set by hand."""
    statuses = load_seed_file("reference.json")["orderStatuses"]
    order_queries.upsert_order_statuses(
        db,
        [
            {
                "code": s["code"],
                "label": s["label"],
                "description": s["description"],
                "tone": s["tone"],
                "manual": s["manual"],
                "retired": s.get("retired", False),
                "sort_order": i,
            }
            for i, s in enumerate(statuses)
        ],
    )
    return len(statuses)


def seed_reference_data(db: Session) -> dict[str, int]:
    reference = load_seed_file("reference.json")
    document_ids, saved_paths = seed_shared_regulations(db)
    order_status_count = seed_order_statuses(db)
    map_queries.upsert_document_kinds(
        db,
        [
            {"kind": k["kind"], "label": k["label"], "sort_order": i}
            for i, k in enumerate(reference["documentKinds"])
        ],
    )
    map_queries.upsert_markets(
        db,
        [
            {
                "code": m["code"],
                "name": m["name"],
                "short_name": m["shortName"],
                "hub_longitude": m["hub"][0],
                "hub_latitude": m["hub"][1],
                "search_terms": m["searchTerms"],
                "sort_order": i,
            }
            for i, m in enumerate(reference["markets"])
        ],
    )
    map_queries.upsert_countries(
        db,
        [
            {
                "alpha2": c["alpha2"],
                "numeric_code": c["numeric"],
                "name": c["name"],
                "market_code": c.get("market"),
                "center_longitude": c["center"][0] if c.get("center") else None,
                "center_latitude": c["center"][1] if c.get("center") else None,
            }
            for c in reference["countries"]
        ],
    )
    map_queries.upsert_ports(
        db,
        [
            {
                "name": p["name"],
                "name_key": p["name"].lower(),
                "country_alpha2": p["country"],
                "longitude": p["at"][0],
                "latitude": p["at"][1],
            }
            for p in reference["ports"]
        ],
    )
    requirement_count = 0
    for market_code, items in reference["requirements"].items():
        unsourced = [r["key"] for r in items if r["source"] not in document_ids]
        if unsourced:
            log.warning(
                "seed.requirements_skipped", extra={"market": market_code, "keys": unsourced}
            )
        rows = [
            {
                "market_code": market_code,
                "requirement_key": r["key"],
                "title": r["title"],
                "level": r["level"],
                "document_kind": r.get("documentKind"),
                "accepted_standards": r.get("acceptedStandards", []),
                "form": r.get("form"),
                "hs_prefixes": [_digits(p) for p in r.get("hsPrefixes", [])],
                "why": r["why"],
                "effective_on": date.fromisoformat(r["effectiveOn"])
                if r.get("effectiveOn")
                else None,
                "changes_on": date.fromisoformat(r["changesOn"]) if r.get("changesOn") else None,
                "change_note": r.get("changeNote", ""),
                "route_sensitive": r.get("routeSensitive", False),
                "regulation_document_id": document_ids[r["source"]],
                "source_quote": r["quote"],
                "duty_rate_percent": r.get("dutyRatePercent"),
                "sort_order": i,
            }
            for i, r in enumerate(items)
            if r["source"] in document_ids
        ]
        map_queries.replace_shared_market_requirements(db, market_code, rows)
        requirement_count += len(rows)

    map_queries.upsert_cost_defaults(
        db,
        [
            {
                "key": c["key"],
                "label": c["label"],
                "unit": c["unit"],
                "value": c["value"],
                "sort_order": i,
            }
            for i, c in enumerate(reference["costDefaults"])
        ],
    )

    observations = load_seed_file("satellite_observations.json")["observations"]
    map_queries.upsert_satellite_observations(
        db,
        [
            {
                "source_ref": o["sourceRef"],
                "kind": o["kind"],
                "title": o["title"],
                "place": o["place"],
                "center_longitude": o["center"][0],
                "center_latitude": o["center"][1],
                "radius_km": o["radiusKm"],
                "area_km2": o["areaKm2"],
                "observed_on": date.fromisoformat(o["observedOn"]),
                "sensor": o["sensor"],
                "confidence": o["confidence"],
                "confidence_note": o["confidenceNote"],
                "extent": o.get("extent")
                or sample_flood_extent(*o["center"], o["radiusKm"], seed=len(o["sourceRef"])),
                "is_sample": o.get("isSample", True),
                "source_url": o.get("sourceUrl"),
            }
            for o in observations
        ],
    )
    regulation_service.commit_or_delete_saved_files(db, saved_paths)
    counts = {
        "official_texts": len(document_ids),
        "order_statuses": order_status_count,
        "document_kinds": len(reference["documentKinds"]),
        "markets": len(reference["markets"]),
        "countries": len(reference["countries"]),
        "ports": len(reference["ports"]),
        "requirements": requirement_count,
        "cost_defaults": len(reference["costDefaults"]),
        "observations": len(observations),
    }
    log.info("seed.reference_loaded", extra=counts)
    return counts


def seed_hs_headings(db: Session) -> dict[str, int]:
    """Load the official tariff lines (seed_data/hs_headings.json) and embed the new or changed
    ones. If embedding fails (no AI access), the lines still load: HS suggestions then search
    them by words, and the next run embeds them."""
    headings = load_seed_file("hs_headings.json")["headings"]
    hs_queries.upsert_hs_headings(
        db,
        [
            {
                "code": h["code"],
                "digits": h["code"].replace(".", ""),
                "level": len(h["code"].replace(".", "")),
                "description": h["description"],
                "text_hash": hashlib.sha256(h["description"].encode()).hexdigest(),
            }
            for h in headings
        ],
    )
    missing = hs_queries.list_headings_without_embedding(db)
    embedded = 0
    if missing:
        try:
            vectors = gemini.embed_texts([h.description for h in missing], "RETRIEVAL_DOCUMENT")
            hs_queries.set_heading_embeddings(
                db, {h.code: v for h, v in zip(missing, vectors, strict=True)}
            )
            embedded = len(missing)
        except AppError as error:
            log.warning(
                "seed.hs_embedding_failed", extra={"missing": len(missing), "error": error.code}
            )
    db.commit()
    total, with_embedding = hs_queries.count_hs_headings(db)
    counts = {"hs_headings": total, "hs_embedded_now": embedded, "hs_embedded": with_embedding}
    log.info("seed.hs_headings_loaded", extra=counts)
    return counts


def main() -> None:
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    with open_session() as db:
        counts = seed_reference_data(db)
        counts |= seed_hs_headings(db)
    print("Reference data loaded: " + ", ".join(f"{v} {k}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
