from datetime import date

from app.services.order_csv import parse_order_csv, reject_existing_order_ids

HEADER = "id,product,supplier,destination,value,shipDate,hsCode\n"


def parse(text: str, encoding: str = "utf-8"):
    return parse_order_csv(text.encode(encoding), default_currency="USD", max_rows=100)


def messages(parsed) -> list[str]:
    return [e.message for e in parsed.errors]


def test_valid_row_is_normalized():
    parsed = parse(HEADER + 'PO-1,Plywood,Binh Phu,"Rotterdam, NL",24000,2026-10-27,4412.33\n')
    assert parsed.errors == []
    assert parsed.rows[0].row_number == 2
    assert parsed.rows[0].order == {
        "external_id": "PO-1",
        "product": "Plywood",
        "supplier": "Binh Phu",
        "destination": "Rotterdam, NL",
        "value_minor": 2400000,
        "currency": "USD",
        "ship_date": date(2026, 10, 27),
        "hs_code": "4412.33",
    }


def test_hs_code_keeps_leading_zero_and_bom_is_ignored():
    parsed = parse("﻿" + HEADER + "PO-1,Milk,Dairy,SG,19.99,2026-11-02,0401.10\n")
    assert parsed.errors == []
    assert parsed.rows[0].order["hs_code"] == "0401.10"
    assert parsed.rows[0].order["value_minor"] == 1999


def test_missing_columns_stop_parsing():
    parsed = parse("id,product\nPO-1,Plywood\n")
    assert messages(parsed) == [
        "Missing columns: supplier, destination, value, shipDate, hsCode. Download the template."
    ]
    assert parsed.rows == []


def test_row_errors_name_the_row_and_field():
    parsed = parse(
        HEADER
        + "PO-1,Plywood,Binh Phu,NL,-5,2026-10-27,4412.33\n"
        + "PO-2,Plywood,Binh Phu,NL,10.123,2026-10-27,4412.33\n"
        + "PO-3,Plywood,Binh Phu,NL,100,27/10/2026,4412.33\n"
        + "PO-4,Plywood,Binh Phu,NL,100,2026-02-30,4412.33\n"
        + "PO-5,Plywood,Binh Phu,NL,100,2026-10-27,44-12\n"
        + "PO-6,,Binh Phu,NL,100,2026-10-27,4412.33\n"
    )
    assert messages(parsed) == [
        "Row 2: value must be a positive number with at most 2 decimals.",
        "Row 3: value must be a positive number with at most 2 decimals.",
        "Row 4: use a valid YYYY-MM-DD ship date.",
        "Row 5: use a valid YYYY-MM-DD ship date.",
        "Row 6: hsCode must look like 4412.33 (digits, optional dots).",
        "Row 7: product is required.",
    ]
    assert parsed.valid_rows == []


def test_duplicate_id_in_same_file():
    row = "PO-1,Plywood,Binh Phu,NL,100,2026-10-27,4412.33\n"
    parsed = parse(HEADER + row + row)
    assert messages(parsed) == ["Row 3: order PO-1 already exists."]
    assert len(parsed.valid_rows) == 1


def test_existing_ids_are_rejected():
    parsed = parse(HEADER + "PO-1,Plywood,Binh Phu,NL,100,2026-10-27,4412.33\n")
    reject_existing_order_ids(parsed, {"PO-1"})
    assert messages(parsed) == ["Row 2: order PO-1 already exists."]
    assert parsed.valid_rows == []


def test_blank_lines_skipped_and_extra_cells_reported():
    parsed = parse(HEADER + "\n,,,,,,\nPO-1,Plywood,Binh Phu,NL,100,2026-10-27,4412.33,extra\n")
    assert messages(parsed) == ["Row 4: has more cells than the header."]


def test_empty_file_and_non_utf8():
    assert messages(parse(HEADER)) == ["The file has no order rows."]
    latin1 = parse(HEADER + "PO-1,Café,Binh Phu,NL,100,2026-10-27,4412.33\n", "latin-1")
    assert messages(latin1) == ["The file must be UTF-8 text."]


def test_optional_currency_column():
    parsed = parse(
        "id,product,supplier,destination,value,shipDate,hsCode,currency\n"
        "PO-1,Plywood,Binh Phu,SG,100,2026-10-27,4412.33,sgd\n"
        "PO-2,Plywood,Binh Phu,SG,100,2026-10-27,4412.33,dollars\n"
    )
    assert parsed.rows[0].order["currency"] == "SGD"
    assert messages(parsed) == ["Row 3: currency must be a 3-letter code like USD."]


def test_row_limit():
    rows = "".join(f"PO-{i},P,S,NL,1,2026-10-27,4412\n" for i in range(3))
    parsed = parse_order_csv((HEADER + rows).encode(), default_currency="USD", max_rows=2)
    assert messages(parsed) == ["Too many rows. Limit is 2."]
