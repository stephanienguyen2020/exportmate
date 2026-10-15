from typing import Literal

from pydantic import Field

from app.schemas.common import CamelCaseModel


class CostSettingOut(CamelCaseModel):
    key: str  # delay_per_day, missing_document, new_test, supplier_lead_days
    label: str
    # "days", or an ISO 4217 currency with `value` in hundredths (20000 = USD 200.00).
    unit: str
    value: int
    source: Literal["default", "company_setting"]
    default_unit: str
    default_value: int


class CostSettingIn(CamelCaseModel):
    key: str = Field(max_length=40)
    value: int | None = Field(default=None, ge=0, le=10**13)  # None: back to the default
    unit: str | None = Field(default=None, max_length=4)  # money settings may change currency


class CostSettingsUpdate(CamelCaseModel):
    settings: list[CostSettingIn] = Field(min_length=1, max_length=20)
