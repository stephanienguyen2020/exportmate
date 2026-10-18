"""Parse and validate an orders CSV. Pure: no database, so it is easy to test.

Columns: id, product, supplier, destination, value, shipDate, hsCode (+ optional currency).
Example row: PO-2291,Cotton T-shirt,Saigon Knit Co.,"Rotterdam, NL",24000,2026-10-27,6109.10
"""

import csv
import hashlib
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation

from app.core.currencies import is_currency

REQUIRED_COLUMNS = ["id", "product", "supplier", "destination", "value", "shipDate", "hsCode"]
# The hsCode column must be there, but a cell may be empty: analysis then asks for the code (the
# order's next step) and AI can suggest one.
OPTIONAL_VALUES = {"hsCode"}
MAX_LENGTHS = {"id": 100, "product": 300, "supplier": 300, "destination": 200}
MAX_VALUE = Decimal(1000000000000)  # 1 trillion; anything above is a typo

DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# 1234 / 1234.56 / 123456 / 1234.56.00 — kept as text so "0401.10" keeps its zero.
HS_CODE_PATTERN = re.compile(r"^\d{4}(\.?\d{2}){0,3}$")


@dataclass
class CsvError:
    row: int | None
    field: str | None
    message: str

    def as_dict(self) -> dict:
        return {"row": self.row, "field": self.field, "message": self.message}


@dataclass
class ParsedOrderRow:
    row_number: int  # line in the file: header is line 1
    raw: dict[str, str]
    row_hash: str
    order: dict | None  # normalized fields, or None if the row has errors


@dataclass
class ParsedOrderCsv:
    rows: list[ParsedOrderRow] = field(default_factory=list)
    errors: list[CsvError] = field(default_factory=list)

    @property
    def valid_rows(self) -> list[ParsedOrderRow]:
        return [r for r in self.rows if r.order is not None]


def hash_row(raw: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()


def _parse_value_minor(text: str) -> int | None:
    """'24000' → 2400000; '19.99' → 1999. None if not a positive amount with ≤ 2 decimals.

    Hundredths of the currency unit for every currency, also JPY and VND (which have no
    minor unit), so readers always divide by 100.
    """
    try:
        amount = Decimal(text.replace(",", ""))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount <= 0 or amount >= MAX_VALUE:
        return None
    if amount.as_tuple().exponent < -2:
        return None
    return int(amount * 100)


def _parse_date(text: str) -> date | None:
    if not DATE_PATTERN.match(text):
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _validate_row(
    row_number: int, cells: dict[str, str], default_currency: str
) -> tuple[dict | None, list[CsvError]]:
    errors: list[CsvError] = []

    def fail(column: str, message: str) -> None:
        errors.append(CsvError(row_number, column, f"Row {row_number}: {message}"))

    for column in REQUIRED_COLUMNS:
        if column not in OPTIONAL_VALUES and not cells.get(column):
            fail(column, f"{column} is required.")
    for column, limit in MAX_LENGTHS.items():
        if len(cells.get(column, "")) > limit:
            fail(column, f"{column} is longer than {limit} characters.")

    value_minor = _parse_value_minor(cells["value"]) if cells.get("value") else None
    if cells.get("value") and value_minor is None:
        fail("value", "value must be a positive number with at most 2 decimals.")

    ship_date = _parse_date(cells["shipDate"]) if cells.get("shipDate") else None
    if cells.get("shipDate") and ship_date is None:
        fail("shipDate", "use a valid YYYY-MM-DD ship date.")

    hs_code = cells.get("hsCode", "")
    if hs_code and not HS_CODE_PATTERN.match(hs_code):
        fail("hsCode", "hsCode must look like 1234.56 (digits, optional dots).")

    currency = (cells.get("currency") or default_currency).upper()
    if not is_currency(currency):
        fail("currency", "currency must be a 3-letter code like USD.")

    if errors:
        return None, errors
    return {
        "external_id": cells["id"],
        "product": cells["product"],
        "supplier": cells["supplier"],
        "destination": cells["destination"],
        "value_minor": value_minor,
        "currency": currency,
        "ship_date": ship_date,
        "hs_code": hs_code,
    }, []


def parse_order_csv(
    content: bytes,
    *,
    default_currency: str,
    max_rows: int,
) -> ParsedOrderCsv:
    result = ParsedOrderCsv()
    try:
        text = content.decode("utf-8-sig")  # strips the Excel BOM
    except UnicodeDecodeError:
        result.errors.append(CsvError(None, None, "The file must be UTF-8 text."))
        return result

    reader = csv.DictReader(io.StringIO(text, newline=""))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    missing = [c for c in REQUIRED_COLUMNS if c not in headers]
    if missing:
        result.errors.append(
            CsvError(None, None, f"Missing columns: {', '.join(missing)}. Download the template.")
        )
        return result
    reader.fieldnames = headers

    seen_ids: set[str] = set()
    try:
        for record in reader:
            # Line in the file (header = 1). The reader skips blank lines, so a counter would drift.
            row_number = reader.line_num
            if None in record:  # more cells than headers
                result.errors.append(
                    CsvError(row_number, None, f"Row {row_number}: has more cells than the header.")
                )
                continue
            cells = {k: (v or "").strip() for k, v in record.items()}
            if not any(cells.values()):
                continue  # blank line
            if len(result.rows) >= max_rows:
                result.errors.append(CsvError(None, None, f"Too many rows. Limit is {max_rows}."))
                break

            order, row_errors = _validate_row(row_number, cells, default_currency)
            order_id = cells.get("id", "")
            if order_id and order_id in seen_ids:
                order = None
                row_errors.append(_duplicate_error(row_number, order_id))
            seen_ids.add(order_id)
            result.errors.extend(row_errors)
            result.rows.append(ParsedOrderRow(row_number, cells, hash_row(cells), order))
    except csv.Error as exc:
        result.errors.append(CsvError(None, None, f"CSV could not be read: {exc}."))

    if not result.rows and not result.errors:
        result.errors.append(CsvError(None, None, "The file has no order rows."))
    return result


def _duplicate_error(row_number: int, order_id: str) -> CsvError:
    return CsvError(row_number, "id", f"Row {row_number}: order {order_id} already exists.")


def reject_existing_order_ids(parsed: ParsedOrderCsv, existing_ids: set[str]) -> None:
    """Mark rows whose order id is already saved for this company."""
    for row in parsed.rows:
        if row.order and row.order["external_id"] in existing_ids:
            row.order = None
            parsed.errors.append(_duplicate_error(row.row_number, row.raw["id"]))
    parsed.errors.sort(key=lambda e: (e.row is not None, e.row or 0))
