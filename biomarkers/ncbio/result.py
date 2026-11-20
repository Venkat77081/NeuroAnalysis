"""One biomarker value in the result (contracts/biomarker-result.schema.json)."""

from __future__ import annotations

from typing import TypedDict


class Value(TypedDict, total=False):
    id: str
    status: str  # COMPUTED | NOT_COMPUTABLE | NOT_IMPLEMENTED
    value: float | None
    unit: str
    cycles: int
    reason: str


def computed(bid: str, value: float, unit: str, cycles: int | None = None) -> Value:
    v: Value = {"id": bid, "status": "COMPUTED", "value": round(float(value), 6), "unit": unit}
    if cycles is not None:
        v["cycles"] = cycles
    return v


def not_computable(bid: str, reason: str) -> Value:
    return {"id": bid, "status": "NOT_COMPUTABLE", "value": None, "reason": reason}


def not_implemented(bid: str) -> Value:
    return {"id": bid, "status": "NOT_IMPLEMENTED", "value": None, "reason": "not built yet"}
