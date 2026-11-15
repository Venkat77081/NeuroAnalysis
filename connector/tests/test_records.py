"""Records adapters: FHIR R4 (fake server) and SQL views (sql/sample_views.sql on SQLite)."""

from datetime import date
from pathlib import Path

import fake_fhir
import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from ncconnector.records import RecordsUnavailableError
from ncconnector.records.fhir import FhirRecords
from ncconnector.records.sql import SqlRecords

SQL = Path(__file__).resolve().parents[1] / "sql" / "sample_views.sql"


@pytest.fixture
def fhir():
    fake_fhir.DOWN["value"] = False
    client = TestClient(fake_fhir.app, base_url="http://fhir.test")
    return FhirRecords("http://fhir.test/fhir", fake_fhir.MRN_SYSTEM, "tok", 5, client=client)


def test_fhir_search_get_history(fhir):
    [r] = fhir.search("00012388", 10)
    assert (r.mrn, r.name, r.birth_date, r.sex, r.email, r.phone) == (
        "00012388",
        "Asha Testpatient",
        date(1958, 3, 2),
        "F",
        "asha.t@example.org",
        "+919800000001",
    )
    assert [p.mrn for p in fhir.search("ravi", 10)] == ["00012401"]
    assert fhir.get("00012401").email is None and fhir.get("00012401").name == "Ravi Samplename"
    assert fhir.get("nope") is None
    h = fhir.history("00012388")
    assert h.conditions[0].text == "Parkinson's disease" and h.medications[0].detail == "three times daily"
    assert h.encounters[0].date == "2026-10-30" and h.encounters[0].detail == "dose review"
    assert fhir.history("00012401").conditions == []


def test_fhir_unreachable(fhir):
    fake_fhir.DOWN["value"] = True
    with pytest.raises(RecordsUnavailableError):
        fhir.search("asha", 5)
    fake_fhir.DOWN["value"] = False

    def boom(request):
        raise httpx.ConnectError("down")

    dead = FhirRecords(
        "http://x/fhir", "s", None, 1, client=httpx.Client(transport=httpx.MockTransport(boom))
    )
    with pytest.raises(RecordsUnavailableError):
        dead.get("1")


@pytest.fixture
def sql():
    eng = create_engine(
        "sqlite+pysqlite:///:memory:", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )
    with eng.begin() as c:
        for stmt in SQL.read_text().split(";"):
            body = "\n".join(line for line in stmt.splitlines() if not line.strip().startswith("--")).strip()
            if body:
                c.execute(text(body))
        c.execute(
            text(
                "INSERT INTO his_patient VALUES ('M-1','Meera','Sampleperson','1950-01-02','female',"
                "'meera@example.org','+919811111111'), ('M-2','Arun','Other','1961-05-06','male',NULL,NULL)"
            )
        )
        c.execute(text("INSERT INTO his_diagnosis VALUES ('M-1','Parkinson''s disease','2021-04-01')"))
        c.execute(
            text(
                "INSERT INTO his_prescription VALUES ('M-1','Pramipexole 0.25 mg','twice daily','2021-05-01')"
            )
        )
        c.execute(text("INSERT INTO his_visit VALUES ('M-1','2026-11-01','Neurology OPD','follow-up')"))
    return SqlRecords("unused", engine=eng)


def test_sql_views(sql):
    [r] = sql.search("M-1", 5)
    assert (r.name, r.sex, r.birth_date, r.email) == (
        "Meera Sampleperson",
        "F",
        date(1950, 1, 2),
        "meera@example.org",
    )
    assert [p.mrn for p in sql.search("arun", 5)] == ["M-2"]
    assert sql.get("M-2").phone is None and sql.get("M-9") is None
    h = sql.history("M-1")
    assert h.conditions[0].text == "Parkinson's disease"
    assert (h.medications[0].text, h.medications[0].detail) == ("Pramipexole 0.25 mg", "twice daily")
    assert h.encounters[0].text == "Neurology OPD"


def test_sql_injection_is_inert(sql):
    assert sql.search("x' OR '1'='1", 5) == []
    assert sql.get("M-1' --") is None


def test_sql_unreachable():
    eng = create_engine("sqlite+pysqlite:////nonexistent-dir/x.db")
    with pytest.raises(RecordsUnavailableError):
        SqlRecords("unused", engine=eng).get("1")


def test_sql_appointments(sql):
    from datetime import UTC, datetime, timedelta

    with sql.engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO his_appointment VALUES ('A1','M-1','2026-11-20 10:30:00','Dr. Rao'),"
                "('A2','M-2','2027-01-20 10:30:00','Dr. Rao')"
            )
        )
    start = datetime(2026, 11, 15, tzinfo=UTC)
    found = sql.appointments(start, start + timedelta(days=7))
    assert [(a.external_id, a.mrn, a.practitioner) for a in found] == [("sql:A1", "M-1", "Dr. Rao")]
    assert found[0].at.tzinfo is not None
