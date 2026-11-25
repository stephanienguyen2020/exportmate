"""Amounts of money: how they are stored and how they are written.

Every amount is kept as an integer number of hundredths of its currency unit, for every
currency, JPY and VND too (which have no minor unit). So 19.99 USD is 1999 and 24,000 JPY is
2400000. Code outside this module never multiplies or divides by 100 itself.
"""

from decimal import ROUND_HALF_UP, Decimal

MINOR_PER_UNIT = 100
DECIMALS = 2  # the most decimals an amount may have, for every currency


def to_minor(amount: Decimal | float) -> int:
    """Currency units to hundredths, rounded half up: Decimal("19.99") → 1999."""
    return int((Decimal(str(amount)) * MINOR_PER_UNIT).quantize(Decimal(1), ROUND_HALF_UP))


def to_units(amount_minor: int) -> Decimal:
    """Hundredths to currency units: 1999 → Decimal("19.99")."""
    return Decimal(amount_minor) / MINOR_PER_UNIT


def has_valid_decimals(amount: Decimal) -> bool:
    """At most `DECIMALS` decimals: 19.99 yes, 19.999 no."""
    return amount.as_tuple().exponent >= -DECIMALS


def format_money(amount_minor: int, currency: str) -> str:
    """The one way an amount is written for people: 'USD 24,000.00'."""
    return f"{currency} {to_units(amount_minor):,.{DECIMALS}f}"


def format_totals(totals_minor: dict[str, int], separator: str = ", ") -> str:
    """Amounts in several currencies, by currency code: 'EUR 10.00, USD 5.00'. Empty gives ''."""
    return separator.join(format_money(v, c) for c, v in sorted(totals_minor.items()))
