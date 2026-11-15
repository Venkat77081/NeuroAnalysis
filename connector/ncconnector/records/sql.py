"""SQL adapter over read-only views that hospital IT defines (sql/sample_views.sql).

Views: nc_patients(mrn, full_name, birth_date, sex, email, phone),
nc_conditions(mrn, description, onset_date), nc_medications(mrn, description, dosage, start_date),
nc_encounters(mrn, encounter_date, kind, reason) and (v3, optional) nc_appointments(appointment_id,
mrn, start_at, practitioner). The connector only ever runs SELECTs with bound parameters.
"""

from datetime import UTC, date, datetime

from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError, OperationalError

from ncconnector.records import (
    AppointmentRecord,
    History,
    HistoryItem,
    PatientRecord,
    RecordsUnavailableError,
)


def _date(v) -> date | None:
    if v is None:
        return None
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def _s(v) -> str | None:
    return None if v is None else str(v)


class SqlRecords:
    def __init__(self, url: str, engine=None):
        self.engine = engine or create_engine(url, pool_pre_ping=True)

    def _rows(self, sql: str, **params):
        try:
            with self.engine.connect() as c:
                return c.execute(text(sql), params).mappings().all()
        except (OperationalError, DBAPIError) as exc:
            raise RecordsUnavailableError("records database unreachable") from exc

    @staticmethod
    def _rec(r) -> PatientRecord:
        return PatientRecord(
            mrn=str(r["mrn"]),
            name=r["full_name"] or "",
            birth_date=_date(r["birth_date"]),
            sex=r["sex"],
            email=r["email"],
            phone=r["phone"],
        )

    def search(self, query: str, limit: int) -> list[PatientRecord]:
        q = query.strip()
        rows = self._rows(
            "SELECT mrn, full_name, birth_date, sex, email, phone FROM nc_patients "
            "WHERE mrn = :q OR lower(full_name) LIKE :like ORDER BY full_name LIMIT :lim",
            q=q,
            like=f"%{q.lower()}%",
            lim=limit,
        )
        return [self._rec(r) for r in rows]

    def get(self, mrn: str) -> PatientRecord | None:
        rows = self._rows(
            "SELECT mrn, full_name, birth_date, sex, email, phone FROM nc_patients WHERE mrn = :m", m=mrn
        )
        return self._rec(rows[0]) if len(rows) == 1 else None

    def history(self, mrn: str) -> History:
        cond = self._rows(
            "SELECT description, onset_date FROM nc_conditions WHERE mrn = :m ORDER BY onset_date DESC", m=mrn
        )
        meds = self._rows(
            "SELECT description, dosage, start_date FROM nc_medications "
            "WHERE mrn = :m ORDER BY start_date DESC",
            m=mrn,
        )
        enc = self._rows(
            "SELECT encounter_date, kind, reason FROM nc_encounters WHERE mrn = :m "
            "ORDER BY encounter_date DESC LIMIT 20",
            m=mrn,
        )
        return History(
            [HistoryItem(r["description"], _s(r["onset_date"])) for r in cond],
            [HistoryItem(r["description"], _s(r["start_date"]), r["dosage"]) for r in meds],
            [HistoryItem(r["kind"], _s(r["encounter_date"]), r["reason"]) for r in enc],
        )

    def appointments(self, start: datetime, end: datetime) -> list[AppointmentRecord]:
        rows = self._rows(
            "SELECT appointment_id, mrn, start_at, practitioner FROM nc_appointments "
            "WHERE start_at >= :a AND start_at <= :b ORDER BY start_at",
            a=start.replace(tzinfo=None).isoformat(sep=" "),
            b=end.replace(tzinfo=None).isoformat(sep=" "),
        )

        def at(v) -> datetime:
            d = v if isinstance(v, datetime) else datetime.fromisoformat(str(v))
            return d if d.tzinfo else d.replace(tzinfo=UTC)

        return [
            AppointmentRecord(
                external_id=f"sql:{r['appointment_id']}",
                at=at(r["start_at"]),
                mrn=str(r["mrn"]),
                practitioner=r["practitioner"],
            )
            for r in rows
        ]
