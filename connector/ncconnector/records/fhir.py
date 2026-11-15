"""FHIR R4 adapter: Patient, Condition, MedicationStatement, Encounter (PLATFORM_PLAN §3).

The MRN is the Patient identifier whose system is NCC_FHIR_MRN_SYSTEM.
"""

from datetime import date

import httpx

from ncconnector.records import History, HistoryItem, PatientRecord, RecordsUnavailableError


def _name(p: dict) -> str:
    names = p.get("name") or []
    official = next((n for n in names if n.get("use") == "official"), names[0] if names else None)
    if not official:
        return ""
    if official.get("text"):
        return official["text"]
    return " ".join([*(official.get("given") or []), official.get("family") or ""]).strip()


def _telecom(p: dict, system: str) -> str | None:
    for t in p.get("telecom") or []:
        if t.get("system") == system and t.get("value"):
            return t["value"]
    return None


def _code_text(c: dict | None) -> str:
    if not c:
        return ""
    if c.get("text"):
        return c["text"]
    coding = (c.get("coding") or [{}])[0]
    return coding.get("display") or coding.get("code") or ""


class FhirRecords:
    def __init__(self, base_url: str, mrn_system: str, token: str | None, timeout_s: float, client=None):
        self.base = base_url.rstrip("/")
        self.system = mrn_system
        headers = {"Accept": "application/fhir+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.headers = headers
        self.client = client or httpx.Client(timeout=timeout_s)

    def _get(self, path: str, params: dict) -> dict:
        try:
            r = self.client.get(f"{self.base}/{path}", params=params, headers=self.headers)
        except httpx.HTTPError as exc:
            raise RecordsUnavailableError("FHIR server unreachable") from exc
        if r.status_code >= 500:
            raise RecordsUnavailableError(f"FHIR server error {r.status_code}")
        r.raise_for_status()
        return r.json()

    def _entries(self, path: str, params: dict) -> list[dict]:
        return [e["resource"] for e in self._get(path, params).get("entry") or [] if "resource" in e]

    def _mrn(self, p: dict) -> str | None:
        for ident in p.get("identifier") or []:
            if ident.get("system") == self.system and ident.get("value"):
                return ident["value"]
        return None

    def _record(self, p: dict) -> PatientRecord | None:
        mrn = self._mrn(p)
        if not mrn:
            return None
        bd = p.get("birthDate")
        return PatientRecord(
            mrn=mrn,
            name=_name(p),
            birth_date=date.fromisoformat(bd) if bd and len(bd) == 10 else None,
            sex={"male": "M", "female": "F"}.get(p.get("gender") or "", "X" if p.get("gender") else None),
            email=_telecom(p, "email"),
            phone=_telecom(p, "phone") or _telecom(p, "sms"),
        )

    def search(self, query: str, limit: int) -> list[PatientRecord]:
        q = query.strip()
        params = {"_count": str(limit)}
        if q.replace("-", "").isalnum() and any(c.isdigit() for c in q):
            params["identifier"] = f"{self.system}|{q}"
        else:
            params["name"] = q
        out = [r for r in (self._record(p) for p in self._entries("Patient", params)) if r]
        return out[:limit]

    def _patient(self, mrn: str) -> dict | None:
        found = self._entries("Patient", {"identifier": f"{self.system}|{mrn}", "_count": "2"})
        return found[0] if len(found) == 1 else None

    def get(self, mrn: str) -> PatientRecord | None:
        p = self._patient(mrn)
        return self._record(p) if p else None

    def history(self, mrn: str) -> History:
        p = self._patient(mrn)
        if not p:
            return History()
        ref = f"Patient/{p['id']}"
        conditions = [
            HistoryItem(_code_text(c.get("code")), c.get("onsetDateTime") or c.get("recordedDate"))
            for c in self._entries("Condition", {"patient": ref, "_count": "50"})
        ]
        meds = [
            HistoryItem(
                _code_text(m.get("medicationCodeableConcept")),
                m.get("effectiveDateTime"),
                ((m.get("dosage") or [{}])[0]).get("text"),
            )
            for m in self._entries("MedicationStatement", {"patient": ref, "_count": "50"})
        ]
        encounters = [
            HistoryItem(
                _code_text((e.get("type") or [None])[0]) or _code_text(e.get("serviceType")),
                (e.get("period") or {}).get("start"),
                _code_text((e.get("reasonCode") or [None])[0]) or None,
            )
            for e in self._entries("Encounter", {"patient": ref, "_sort": "-date", "_count": "20"})
        ]
        return History(conditions, meds, encounters)
