from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

DataT = TypeVar("DataT")


class CamelCaseModel(BaseModel):
    """snake_case in Python, camelCase in JSON."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class SuccessResponse(BaseModel, Generic[DataT]):
    """Shape of every 2xx body: {"data": ..., "meta": {...}}."""

    data: DataT
    meta: dict[str, Any] = Field(default_factory=dict)


def success_response(data: Any, **meta: Any) -> dict:
    return {"data": data, "meta": meta}
