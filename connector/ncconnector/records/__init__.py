"""Live patient records (PLATFORM_PLAN §3): read on each request, never cached or copied."""

from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Protocol


class RecordsUnavailableError(RuntimeError):
    """The hospital system did not answer (the doctor view says so; recordings still open)."""


@dataclass
class PatientRecord:
    mrn: str
    name: str
    birth_date: date | None = None
    sex: str | None = None
    email: str | None = None
    phone: str | None = None


@dataclass
class HistoryItem:
    text: str
    date: str | None = None
    detail: str | None = None


@dataclass
class History:
    conditions: list[HistoryItem] = field(default_factory=list)
    medications: list[HistoryItem] = field(default_factory=list)
    encounters: list[HistoryItem] = field(default_factory=list)


class Records(Protocol):
    def search(self, query: str, limit: int) -> list[PatientRecord]: ...
    def get(self, mrn: str) -> PatientRecord | None: ...
    def history(self, mrn: str) -> History: ...


#: Tests inject a records instance (or an httpx client for FHIR).
OVERRIDE: Records | None = None


@lru_cache
def _configured() -> Records:
    from ncconnector.config import get_settings

    s = get_settings()
    if s.records == "sql":
        from ncconnector.records.sql import SqlRecords

        if not s.records_sql_url:
            raise RuntimeError("NCC_RECORDS_SQL_URL is required for records=sql")
        return SqlRecords(s.records_sql_url)
    from ncconnector.records.fhir import FhirRecords

    return FhirRecords(s.fhir_base_url, s.fhir_mrn_system, s.fhir_bearer_token, s.records_timeout_s)


def records() -> Records:
    return OVERRIDE if OVERRIDE is not None else _configured()
