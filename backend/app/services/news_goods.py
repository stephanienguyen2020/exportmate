"""What News watch reads the news against (moved from the AI service's GET /api/inventory and
goods.js / goods-store.js).

A signed-in company's goods are what its profile (Account › About company) names and what its
orders ship: one item per product and HS code, with every market and supplier and the newest
orders, without quantities or values. They are kept in Firestore `companyGoods/{companyId}`,
where the daily news scan (ai/server/scan.js) reads them with no one's token, and rebuilt from
Postgres on a read when older than GOODS_TTL. The scan sets `backfilledAt` once it has read
back over recent news for them. Signed out (the browser demo) gets the sample stock.

Item IDs must stay the same as goods.js made them: stored alerts name items by them."""

import hashlib
import json
import logging
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.database.models import Order
from app.database.news_store import get_news_store
from app.database.queries import orders as order_queries
from app.schemas.account import CompanyOut
from app.schemas.news_alerts import NewsGoodsOut, StockOwnerOut
from app.services.trade_map import load_gazetteer, locate_destination

# Items per company, so a scan's prompt stays a reasonable size.
MAX_GOODS = 60
# Order ids kept on an item, for the assistant and the stock list.
MAX_ORDER_IDS = 10
MAX_ABOUT = 600
GOODS_TTL = timedelta(minutes=15)
# Whose the sample stock is. ai/server/seed/inventory.js STOCK_PROFILE says the same until the
# news scan moves here.
SAMPLE_STOCK_OWNER = StockOwnerOut(
    company="Binh Duong Wood Co.",
    about="a fictional Vietnamese wood-products and furniture manufacturer and exporter",
)

log = logging.getLogger(__name__)


def _clean(text: object) -> str:
    return re.sub(r"\s+", " ", "" if text is None else str(text)).strip()


def _digits(hs_code: object) -> str:
    return re.sub(r"\D", "", "" if hs_code is None else str(hs_code))


def goods_id(name: str, hs_code: str = "") -> str:
    """A stable id for a product and its HS code, so alerts keep naming the same item."""
    key = f"{_clean(name).lower()}|{_digits(hs_code)}"
    return "G-" + hashlib.sha1(key.encode()).hexdigest()[:6].upper()


def profile_products(text: str | None) -> list[str]:
    """ "Cotton T-shirts, roasted coffee; LED lamps" as separate products."""
    products = (_clean(p) for p in re.split(r"[,;\n]+", text or ""))
    return list(dict.fromkeys(p for p in products if len(p) >= 2))


def about_company(company: CompanyOut) -> str:
    """One line about the company, from its profile, for the scan's prompt."""
    origin = _clean(company.origin)
    route = [r for r in map(_clean, [company.origin, *company.transit, company.destination]) if r]
    role = _clean(company.business_role).lower() or "company"
    first = (
        f"a {role}"
        + (f" based in {origin}" if origin else "")
        + (f" shipping {' → '.join(route)}" if len(route) > 1 else "")
    )
    parts = [
        first,
        re.sub(r"[.\s]+$", "", _clean(company.description)),
        company.materials and f"main materials: {_clean(company.materials)}",
        company.certifications and f"certifications: {_clean(company.certifications)}",
    ]
    return "; ".join(p for p in parts if p)[:MAX_ABOUT]


def company_goods(company: CompanyOut, orders: list[tuple[Order, str | None]]) -> dict:
    """{profile, items} from the company profile and its orders, each with its market.
    Products the profile names come first; then orders with the same product and HS code make
    one item, with every market and supplier, newest ship dates first."""
    items: dict[str, dict] = {}
    for name in profile_products(company.products):
        items[goods_id(name)] = _item(goods_id(name), name, "", "profile")
    named = {i["name"].lower() for i in items.values()}
    shipping = sorted(
        (o for o in orders if _clean(o[0].product)), key=lambda o: o[0].ship_date, reverse=True
    )
    for order, market in shipping:
        name = _clean(order.product)
        # A product the profile names and an order ships with no HS code is the same item.
        same_as_profile = not _digits(order.hs_code) and name.lower() in named
        item_id = goods_id(name) if same_as_profile else goods_id(name, order.hs_code or "")
        item = items.get(item_id) or _item(item_id, name, _clean(order.hs_code), "orders")
        if market and market not in item["markets"]:
            item["markets"].append(market)
        supplier = _clean(order.supplier)
        if supplier and supplier not in item["suppliers"]:
            item["suppliers"].append(supplier)
        if len(item["orders"]) < MAX_ORDER_IDS:
            item["orders"].append(order.external_id)
        items[item_id] = item
    listed = []
    for item in list(items.values())[:MAX_GOODS]:
        suppliers = item.pop("suppliers")
        listed.append({**item, "supplier": ", ".join(suppliers)})
    return {
        "profile": {"company": _clean(company.name), "about": about_company(company)},
        "items": listed,
    }


def _item(item_id: str, name: str, hs_code: str, source: str) -> dict:
    # Keys in goods.js's order, so the fingerprint of the same goods stays the same.
    return {
        "sku": item_id,
        "name": name,
        "hsCode": hs_code,
        "markets": [],
        "suppliers": [],
        "orders": [],
        "source": source,
    }


def goods_fingerprint(goods: dict) -> str:
    """The same goods give the same fingerprint, so a refresh that changed nothing is noticed."""
    text = json.dumps(goods, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(text.encode()).hexdigest()[:16]


def company_stock(db: Session, ctx: CompanyContext, now: datetime | None = None) -> dict:
    """The company's goods ({profile, items, updatedAt, backfilledAt}), rebuilt when older
    than GOODS_TTL."""
    now = now or datetime.now(UTC)
    company_id = str(ctx.company_id)
    store = get_news_store()
    stored = store.get_company_goods(company_id)
    if stored and _fresh(stored.get("updatedAt"), now):
        return stored
    gazetteer = load_gazetteer(db)
    orders = [
        (o, locate_destination(o.destination, gazetteer).market)
        for o in order_queries.list_company_orders(db, ctx.company_id)
    ]
    goods = company_goods(CompanyOut.model_validate(ctx.company), orders)
    fingerprint = goods_fingerprint(goods)
    updated_at = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    fields = {**goods, "fingerprint": fingerprint, "updatedAt": updated_at}
    store.save_company_goods(company_id, fields)
    if fingerprint != (stored or {}).get("fingerprint"):
        log.info("goods.updated", extra={"company_id": company_id, "items": len(goods["items"])})
    return {**(stored or {}), **fields}


def _fresh(updated_at: object, now: datetime) -> bool:
    try:
        stamp = datetime.fromisoformat(str(updated_at))
    except ValueError:
        return False
    return stamp.tzinfo is not None and now - stamp < GOODS_TTL


def list_stock_items(db: Session, ctx: CompanyContext | None) -> list[dict]:
    """The items alerts name: the company's goods, or the sample stock signed out."""
    if ctx is None:
        return get_news_store().list_sample_stock()
    return company_stock(db, ctx).get("items") or []


def list_news_goods(db: Session, ctx: CompanyContext | None) -> NewsGoodsOut:
    if ctx is None:
        return NewsGoodsOut(
            kind="sample", items=get_news_store().list_sample_stock(), owner=SAMPLE_STOCK_OWNER
        )
    goods = company_stock(db, ctx)
    profile = goods.get("profile") or {}
    return NewsGoodsOut(
        kind="company",
        items=goods.get("items") or [],
        owner=StockOwnerOut(company=profile.get("company", ""), about=profile.get("about", "")),
        updated_at=goods.get("updatedAt"),
        watched_since=goods.get("backfilledAt"),
    )
