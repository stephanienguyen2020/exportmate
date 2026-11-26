"""The news scan's relevance exam (moved from the AI service's eval/scan-golden.js and
scan-score.js): labeled articles and how the scan's judgment of them is scored. Pure, so the
scoring is unit-tested; app/news_scan_eval.py runs it against live Gemini.

The articles are written for the exam, not real news: each one isolates a link the scan should
find (HS code, market, material origin, missing origin trace) or a trap it should ignore (other
commodities, exchange rates, fuel, measures on other goods from Vietnam). Expected SKUs are
worked out from the stock the scan will see and dates from today, so the set stays right when
the seed or the calendar changes.

Ratchet: when the scan raises a false alarm or misses an article, add it here first, then fix
the scan's RULES or decide() until it passes.

expect: `relevant`; `skus` the alert must name and `allowed` it may also name; acceptable
`severity` and `direction`; `mentions` (materials as words to find, origins and markets as codes,
headings as 4-digit HS), scored on their own, not part of a case's pass. Cases sharing an
`event` report the same news: exactly one of them should be kept."""

from datetime import date, timedelta


def _rate(n: int, d: int) -> float | None:
    return round(n / d, 3) if d else None


def scan_cases(items: list[dict], today: date) -> list[dict]:
    def day(offset: int) -> str:
        return (today + timedelta(days=offset)).isoformat()

    def skus(pred) -> list[str]:
        return [i["sku"] for i in items if pred(i)]

    def sells(market: str):
        return lambda i: market in i["markets"]

    published = day(-1)

    def article(title: str, snippet: str) -> dict:
        return {
            "title": title,
            "snippet": snippet,
            "publisher": "Eval fixture",
            "publishedAt": published,
        }

    us_plywood = skus(lambda i: i["hsCode"].startswith("4412") and sells("US")(i))
    us_cabinets = skus(lambda i: i["category"] == "Kitchen cabinets & vanities" and sells("US")(i))
    eu_no_geo = skus(lambda i: sells("EU")(i) and not i["originTraced"])
    from_russia = skus(lambda i: i["materialOrigin"] == "Russia")
    us_seating = skus(lambda i: i["category"] == "Upholstered seating" and sells("US")(i))
    jp_pellets = skus(lambda i: i["category"] == "Wood pellets" and sells("JP")(i))
    kr_pellets = skus(lambda i: i["category"] == "Wood pellets" and sells("KR")(i))
    from_cameroon = skus(lambda i: i["materialOrigin"] == "Cameroon")

    return [
        # Duplicate reports of one event come first so they share a batch, as in a scan.
        {
            "id": "eudr-date",
            "category": "trade-measure",
            "event": "eudr-date",
            "article": article(
                "EU confirms deforestation regulation start date; plot geolocation required for timber and furniture",
                f"Operators placing wood products, plywood and wooden furniture on the EU market must file due diligence statements with plot geolocation from {day(75)}. Goods without geolocation will be refused at customs.",
            ),
            "expect": {"relevant": True, "skus": eu_no_geo, "allowed": skus(sells("EU")), "severity": ["high", "medium"], "direction": ["risk"], "mentions": {"markets": ["EU"]}},
        },
        {
            "id": "eudr-date-repeat",
            "category": "duplicate",
            "event": "eudr-date",
            "article": article(
                "EUDR deadline set: what furniture exporters to Europe need before customs checks begin",
                f"The European Commission has confirmed that the EU Deforestation Regulation applies from {day(75)}. Exporters of wood furniture and timber must provide geolocation of the forest plots their wood came from.",
            ),
            "expect": {"relevant": True, "skus": eu_no_geo, "allowed": skus(sells("EU")), "severity": ["high", "medium"], "direction": ["risk"]},
        },
        {
            "id": "us-plywood-antidumping",
            "category": "trade-measure",
            "article": article(
                "US sets preliminary anti-dumping duties on hardwood and decorative plywood from Vietnam",
                f"The Commerce Department announced preliminary duties of 12% to 110% on hardwood and decorative plywood (HS 4412) imported from Vietnam. Cash deposits will be collected from {day(30)}.",
            ),
            "expect": {"relevant": True, "skus": us_plywood, "allowed": us_plywood + skus(lambda i: "plywood" in i["material"].lower() and sells("US")(i)), "severity": ["high"], "direction": ["risk"], "mentions": {"origins": ["VN"], "markets": ["US"], "headings": ["4412"]}},
        },
        {
            "id": "copper-232",
            "category": "off-topic",
            "article": article(
                "US raises Section 232 tariffs on copper imports to 50%",
                "The new rate applies to refined copper and semi-finished copper products from all countries, including Vietnam, starting next month.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "us-232-cabinets",
            "category": "trade-measure",
            "article": article(
                "US raises Section 232 tariff on kitchen cabinets and vanities to 50%",
                f"Imports of wooden kitchen cabinets and bathroom vanities will face a 50% tariff from {day(60)}, up from 25%. No exemptions were announced for Vietnam.",
            ),
            "expect": {"relevant": True, "skus": us_cabinets, "allowed": us_cabinets, "severity": ["high"], "direction": ["risk"], "mentions": {"markets": ["US"]}},
        },
        {
            "id": "cocoa-eudr",
            "category": "off-topic",
            "article": article(
                "Ghana's cocoa farmers race to map farms before EU deforestation rules",
                "Cooperatives say they need help collecting geolocation data for smallholder cocoa plots to keep supplying European chocolate makers.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "jp-pellet-certification",
            "category": "trade-measure",
            "article": article(
                "Japan tightens sustainability proof for imported wood pellets used in biomass power",
                f"Power plants claiming feed-in tariff support must show third-party sustainability certification for every pellet shipment from {day(170)}.",
            ),
            "expect": {"relevant": True, "skus": jp_pellets, "allowed": jp_pellets, "severity": ["medium", "low"], "mentions": {"markets": ["JP"], "headings": ["4401"]}},
        },
        {
            "id": "vnd-exchange-rate",
            "category": "off-topic",
            "article": article(
                "Vietnam dong slides to record low against the US dollar",
                "The State Bank of Vietnam widened the trading band as exporters converted fewer dollar receipts.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "kr-pellet-opportunity",
            "category": "market",
            "article": article(
                "South Korea raises renewable credit weighting for imported wood pellets",
                "Utilities will earn more renewable energy certificates per tonne of certified wood pellets burned, which traders expect to lift Korean demand next year.",
            ),
            "expect": {"relevant": True, "skus": kr_pellets, "allowed": kr_pellets, "direction": ["opportunity"], "mentions": {"markets": ["KR"], "headings": ["4401"]}},
        },
        {
            "id": "bunker-fuel",
            "category": "off-topic",
            "article": article(
                "Bunker fuel prices rise 8% as Red Sea diversions continue",
                "Shipping lines on Asia-Europe routes are adding fuel surcharges to cover longer voyages around the Cape of Good Hope.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "russia-birch-sanctions",
            "category": "supply",
            "article": article(
                "US and EU widen sanctions to Russian birch veneer routed through third countries",
                "Products made with Russian-origin birch veneer or birch plywood will be barred even when finished in another country, including Vietnam.",
            ),
            "expect": {"relevant": True, "skus": from_russia, "allowed": from_russia, "severity": ["high", "medium"], "direction": ["risk"], "mentions": {"materials": ["birch"], "origins": ["RU"], "markets": ["US", "EU"]}},
        },
        {
            "id": "rubber-tyres",
            "category": "off-topic",
            "article": article(
                "Vietnam's natural rubber exports hit record as tyre demand rises",
                "Shipments of natural rubber to China rose 18% in the first nine months as tyre makers rebuilt stocks.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "cameroon-sapele-suspension",
            "category": "supply",
            "article": article(
                "Cameroon suspends sawn sapele exports pending legality audit",
                "The forestry ministry halted export permits for sawn sapele for at least three months while it audits concession records.",
            ),
            "expect": {"relevant": True, "skus": from_cameroon, "allowed": from_cameroon, "severity": ["high", "medium"], "direction": ["risk"], "mentions": {"materials": ["sapele"], "origins": ["CM"], "headings": ["4407"]}},
        },
        {
            "id": "shrimp-antidumping",
            "category": "off-topic",
            "article": article(
                "US sets anti-dumping duties on frozen shrimp from Vietnam",
                "Seafood exporters face duties of up to 25% after the Commerce Department's final review.",
            ),
            "expect": {"relevant": False},
            "note": "A trade measure on Vietnam and the US, but on goods the company doesn't sell.",
        },
        {
            "id": "upholstered-tariff-talk",
            "category": "vague",
            "article": article(
                "US officials weigh tariffs on upholstered furniture imports, people familiar say",
                "No decision is expected before next year, and the scope and rate have not been set.",
            ),
            "expect": {"relevant": True, "skus": us_seating, "allowed": skus(lambda i: i["hsCode"].startswith("94") and sells("US")(i)), "severity": ["medium", "low"], "direction": ["watch"]},
        },
        {
            "id": "vn-gdp",
            "category": "off-topic",
            "article": article(
                "Vietnam's economy grows 7.1% in third quarter on manufacturing exports",
                "Electronics and textiles led export growth, the statistics office said.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "uk-laos-due-diligence",
            "category": "trade-measure",
            "article": article(
                "UK adds extra due-diligence checks for timber products from Laos",
                "Importers must provide concession-level legality evidence for any wood product containing Laotian timber, including outdoor furniture.",
            ),
            "expect": {"relevant": True, "skus": skus(lambda i: i["materialOrigin"] == "Laos" and sells("UK")(i)), "allowed": skus(sells("UK")), "direction": ["risk"], "mentions": {"origins": ["LA"], "markets": ["UK"]}},
        },
        {
            "id": "industrial-land",
            "category": "off-topic",
            "article": article(
                "Binh Duong industrial land rents climb 12% as factories relocate from China",
                "Developers report occupancy above 90% across the province's main industrial parks.",
            ),
            "expect": {"relevant": False},
        },
        {
            "id": "china-us-hardwood-retaliation",
            "category": "supply",
            "article": article(
                "China's tariffs on US hardwood lumber push oak and ash prices down for other Asian buyers",
                "US sawmills are discounting white oak and ash lumber to buyers in Vietnam and Malaysia after losing Chinese orders.",
            ),
            "expect": {
                "relevant": True,
                "skus": skus(lambda i: i["category"] == "Imported sawn timber" and i["materialOrigin"] == "United States"),
                "allowed": skus(lambda i: i["materialOrigin"] == "United States"),
                "direction": ["opportunity", "watch"],
                "mentions": {"materials": ["oak", "ash"], "origins": ["US"]},
            },
        },
    ]  # fmt: skip


def in_batches(cases: list[dict], size: int) -> list[list[dict]]:
    """Splits cases into batches of `size`, keeping the reports of one event together."""
    units: list[list[dict]] = []
    by_event: dict[str, list[dict]] = {}
    for case in cases:
        event = case.get("event")
        if not event:
            units.append([case])
        elif event in by_event:
            by_event[event].append(case)
        else:
            by_event[event] = [case]
            units.append(by_event[event])
    batches: list[list[dict]] = []
    for unit in units:
        if batches and len(batches[-1]) + len(unit) <= size:
            batches[-1] += unit
        else:
            batches.append(list(unit))
    return batches


def _dropped_because(o: dict) -> str | None:
    """Why an article the model called relevant was not kept."""
    if not o.get("modelRelevant") or o.get("relevant"):
        return None
    if o.get("otherCommodity"):
        return "other commodity"
    if o.get("duplicate"):
        return "repeat of another article"
    return "no SKU in stock"


def _market_code(m: str) -> str:
    """Markets are compared as our codes: "GB" is the UK market."""
    return "UK" if m == "GB" else m


def score_mentions(expected: dict, named: dict | None) -> dict:
    """What an article's expected mentions the scan missed, and origins it named beyond them."""
    named = named or {}
    materials = [m.lower() for m in named.get("materials") or []]
    headings = ["".join(ch for ch in c if ch.isdigit())[:4] for c in named.get("hsCodes") or []]
    origins = named.get("originCountries") or []
    markets = [_market_code(m) for m in named.get("markets") or []]
    missing = (
        [
            f"material {w}"
            for w in expected.get("materials", [])
            if not any(w in m for m in materials)
        ]
        + [f"origin {c}" for c in expected.get("origins", []) if c not in origins]
        + [f"market {c}" for c in expected.get("markets", []) if c not in markets]
        + [f"HS {h}" for h in expected.get("headings", []) if h not in headings]
    )
    total = sum(len(expected.get(k, [])) for k in ("materials", "origins", "markets", "headings"))
    extra = [c for c in origins if c not in expected["origins"]] if "origins" in expected else []
    return {
        "total": total,
        "found": total - len(missing),
        "missing": missing,
        "extraOrigins": extra,
    }


def score_scan_cases(cases: list[dict], outcomes: dict[str, dict]) -> list[dict]:
    """Scores each case from `outcomes` (case id -> {relevant, modelRelevant, affected: [sku],
    severity, direction, duplicate, otherCommodity, error})."""
    scored = []
    for case in cases:
        e = case["expect"]
        o = outcomes.get(case["id"]) or {"error": "no assessment returned"}
        checks: list[dict] = []

        def check(name: str, ok: object, detail: str, checks=checks) -> None:
            checks.append({"name": name, "ok": bool(ok), "detail": detail})

        check("Assessed", not o.get("error"), o.get("error") or "ok")
        if case.get("event"):
            kept = [
                x["id"]
                for x in cases
                if x.get("event") == case["event"] and (outcomes.get(x["id"]) or {}).get("relevant")
            ]
            check(
                "Event kept once",
                len(kept) == 1,
                f"kept {', '.join(kept)}" if kept else "no report kept",
            )
        else:
            why = _dropped_because(o)
            got = "relevant" if o.get("relevant") else "not relevant"
            expected = "relevant" if e["relevant"] else "not relevant"
            suffix = f" (model said relevant; dropped: {why})" if why else ""
            check(
                "Relevance",
                bool(o.get("relevant")) == e["relevant"],
                f"expected {expected}, got {got}{suffix}",
            )
        if e["relevant"] and o.get("relevant"):
            named = o.get("affected") or []
            missing = [s for s in e.get("skus", []) if s not in named]
            allowed = {*e.get("skus", []), *e.get("allowed", [])}
            extra = [s for s in named if s not in allowed]
            check(
                "Names the affected SKUs",
                not missing,
                f"missing {', '.join(missing)}" if missing else ", ".join(named),
            )
            check(
                "Names no unrelated SKUs",
                not extra,
                f"also named {', '.join(extra)}" if extra else "ok",
            )
            for key, name in (("severity", "Severity"), ("direction", "Direction")):
                if e.get(key):
                    check(
                        name,
                        o.get(key) in e[key],
                        f"{o.get(key)} (expected {' or '.join(e[key])})",
                    )
        mentions = (
            score_mentions(e["mentions"], o.get("mentions"))
            if e.get("mentions") and o.get("relevant")
            else None
        )
        scored.append(
            {
                "id": case["id"],
                "category": case["category"],
                "pass": all(c["ok"] for c in checks),
                "checks": checks,
                "outcome": o,
                "mentions": mentions,
            }
        )
    return scored


def summarize_scan_run(cases: list[dict], scored: list[dict]) -> dict:
    """Pass rates plus the scan's quality figures: relevance precision/recall (an event's
    reports count once), SKU precision/recall over alerts that should exist and do, severity
    and direction agreement, and how often the code checks overrode the model."""
    by_id = {s["id"]: s["outcome"] for s in scored}
    by_category: dict[str, dict] = {}
    for s in scored:
        c = by_category.setdefault(s["category"], {"cases": 0, "passed": 0})
        c["cases"] += 1
        c["passed"] += 1 if s["pass"] else 0

    units: dict[str, list[dict]] = {}
    for case in cases:
        units.setdefault(case.get("event") or case["id"], []).append(case)
    tp = fp = fn = tn = 0
    for members in units.values():
        expected = members[0]["expect"]["relevant"]
        got = any((by_id.get(c["id"]) or {}).get("relevant") for c in members)
        if expected and got:
            tp += 1
        elif got:
            fp += 1
        elif expected:
            fn += 1
        else:
            tn += 1
    precision, recall = _rate(tp, tp + fp), _rate(tp, tp + fn)

    named = named_allowed = required = required_named = 0
    agree = {"severity": [0, 0], "direction": [0, 0]}
    for case in cases:
        o = by_id.get(case["id"]) or {}
        e = case["expect"]
        if not e["relevant"] or not o.get("relevant"):
            continue
        allowed = {*e.get("skus", []), *e.get("allowed", [])}
        named += len(o["affected"])
        named_allowed += sum(1 for s in o["affected"] if s in allowed)
        required += len(e.get("skus", []))
        required_named += sum(1 for s in e.get("skus", []) if s in o["affected"])
        for key in ("severity", "direction"):
            if e.get(key):
                agree[key][1] += 1
                agree[key][0] += 1 if o.get(key) in e[key] else 0
    mentioned = [s["mentions"] for s in scored if s["mentions"]]
    mention_total = sum(m["total"] for m in mentioned)
    outcomes = list(by_id.values())
    passed = sum(1 for s in scored if s["pass"])
    f1 = (
        round(2 * precision * recall / (precision + recall), 3)
        if precision is not None and recall is not None and precision + recall
        else None
    )
    return {
        "cases": len(scored),
        "passed": passed,
        "passRate": _rate(passed, len(scored)) or 0,
        "relevance": {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": precision, "recall": recall, "f1": f1},
        "skus": {"precision": _rate(named_allowed, named), "recall": _rate(required_named, required)},
        "severityAgreement": _rate(*agree["severity"]),
        "directionAgreement": _rate(*agree["direction"]),
        # What articles name, for the knowledge graph: over alerts that should exist and do.
        "mentions": {
            "recall": _rate(sum(m["found"] for m in mentioned), mention_total),
            "extraOrigins": sum(len(m["extraOrigins"]) for m in mentioned),
        },
        "overridden": {
            "otherCommodity": sum(1 for o in outcomes if o.get("modelRelevant") and o.get("otherCommodity")),
            "noSkuInStock": sum(
                1
                for o in outcomes
                if o.get("modelRelevant")
                and not o.get("relevant")
                and not o.get("otherCommodity")
                and not o.get("duplicate")
            ),
        },
        "errors": sum(1 for o in outcomes if o.get("error")),
        "byCategory": by_category,
    }  # fmt: skip


def merge_repeats(runs: list[list[dict]]) -> list[dict]:
    """Over repeated runs of the same cases: a case passes only if it passed every time."""
    merged = []
    for n, first in enumerate(runs[0]):
        reps = [r[n] for r in runs]
        failed = next((r for r in reps if not r["pass"]), None)
        merged.append(
            {
                **(failed or first),
                "pass": failed is None,
                "passes": sum(1 for r in reps if r["pass"]),
                "runs": len(reps),
                "stable": all(
                    bool(r["outcome"].get("relevant")) == bool(first["outcome"].get("relevant"))
                    for r in reps
                ),
            }
        )
    return merged


def compare_runs(previous: dict | None, current: list[dict]) -> dict:
    """Cases that passed before and fail now (regressions), and the other way (fixed)."""
    before = {c["id"]: c["pass"] for c in (previous or {}).get("cases", [])}
    return {
        "regressions": [c["id"] for c in current if before.get(c["id"]) is True and not c["pass"]],
        "fixed": [c["id"] for c in current if before.get(c["id"]) is False and c["pass"]],
    }
