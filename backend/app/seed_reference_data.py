"""Load the shared trade-map reference data into Postgres.

Markets, countries, ports, document kinds, per-market requirement checklists and sample
satellite observations, from the JSON files in app/seed_data/.

Usage:  uv run python -m app.seed_reference_data
On Cloud Run it runs after migrations (backend/deploy.sh). Running it again updates rows in
place; checklist lines removed from the file are removed from the database.
"""

import argparse
import logging
import math
import re
from datetime import date

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.queries import trade_map as map_queries
from app.database.session import open_session
from app.seed_data import load_seed_file

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


def seed_reference_data(db: Session) -> dict[str, int]:
    reference = load_seed_file("reference.json")
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
                "sort_order": i,
            }
            for i, r in enumerate(items)
        ]
        map_queries.replace_market_requirements(db, market_code, rows)
        requirement_count += len(rows)

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
    db.commit()
    counts = {
        "document_kinds": len(reference["documentKinds"]),
        "markets": len(reference["markets"]),
        "countries": len(reference["countries"]),
        "ports": len(reference["ports"]),
        "requirements": requirement_count,
        "observations": len(observations),
    }
    log.info("seed.reference_loaded", extra=counts)
    return counts


def main() -> None:
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    with open_session() as db:
        counts = seed_reference_data(db)
    print("Reference data loaded: " + ", ".join(f"{v} {k}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
