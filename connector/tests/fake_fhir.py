"""A small in-process FHIR R4 server for tests (Patient, Condition, MedicationStatement,
Encounter search). Data is synthetic."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MRN_SYSTEM = "urn:test-hospital:mrn"

PATIENTS = [
    {
        "resourceType": "Patient",
        "id": "p1",
        "identifier": [{"system": MRN_SYSTEM, "value": "00012388"}, {"system": "other", "value": "X1"}],
        "name": [{"use": "official", "family": "Testpatient", "given": ["Asha"]}],
        "gender": "female",
        "birthDate": "1958-03-02",
        "telecom": [
            {"system": "email", "value": "asha.t@example.org"},
            {"system": "phone", "value": "+919800000001"},
        ],
    },
    {
        "resourceType": "Patient",
        "id": "p2",
        "identifier": [{"system": MRN_SYSTEM, "value": "00012401"}],
        "name": [{"text": "Ravi Samplename"}],
        "gender": "male",
        "birthDate": "1949-11-20",
        "telecom": [{"system": "phone", "value": "+919800000002"}],
    },
]

CONDITIONS = [
    {
        "resourceType": "Condition",
        "subject": {"reference": "Patient/p1"},
        "code": {"text": "Parkinson's disease"},
        "onsetDateTime": "2022-05-01",
    },
]
MEDS = [
    {
        "resourceType": "MedicationStatement",
        "subject": {"reference": "Patient/p1"},
        "medicationCodeableConcept": {"coding": [{"display": "Levodopa/carbidopa 100/25 mg"}]},
        "dosage": [{"text": "three times daily"}],
        "effectiveDateTime": "2022-06-01",
    },
]
ENCOUNTERS = [
    {
        "resourceType": "Encounter",
        "subject": {"reference": "Patient/p1"},
        "type": [{"text": "Neurology OPD"}],
        "period": {"start": "2026-10-30"},
        "reasonCode": [{"text": "dose review"}],
    },
]

app = FastAPI()


def appointments_now():
    """Two booked appointments, 3 and 5 days from now (computed at request time), and a cancelled one."""
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC).replace(microsecond=0, second=0)

    def appt(i, pid, days, status="booked"):
        return {
            "resourceType": "Appointment",
            "id": f"a{i}",
            "status": status,
            "start": (now + timedelta(days=days)).isoformat(),
            "participant": [
                {"actor": {"reference": f"Patient/{pid}"}},
                {"actor": {"reference": "Practitioner/d1", "display": "Dr. Rao"}},
            ],
        }

    return [appt(1, "p1", 3), appt(2, "p2", 5), appt(3, "p1", 4, "cancelled")]


REQUESTS: list[str] = []
DOWN = {"value": False}


def bundle(resources):
    return {"resourceType": "Bundle", "type": "searchset", "entry": [{"resource": r} for r in resources]}


@app.middleware("http")
async def record(request: Request, call_next):
    REQUESTS.append(f"{request.url.path}?{request.url.query}")
    if DOWN["value"]:
        return JSONResponse({"resourceType": "OperationOutcome"}, status_code=503)
    return await call_next(request)


@app.get("/fhir/Patient")
def patients(identifier: str | None = None, name: str | None = None, _count: int = 20):
    out = PATIENTS
    if identifier:
        system, _, value = identifier.partition("|")
        out = [p for p in out if any(i["system"] == system and i["value"] == value for i in p["identifier"])]
    if name:

        def full(p):
            n = p["name"][0]
            return (n.get("text") or " ".join([*n.get("given", []), n.get("family", "")])).lower()

        out = [p for p in out if name.lower() in full(p)]
    return bundle(out[:_count])


def _for(resources, patient):
    return bundle([r for r in resources if r["subject"]["reference"] == patient])


@app.get("/fhir/Patient/{pid}")
def patient(pid: str):
    return next(p for p in PATIENTS if p["id"] == pid)


@app.get("/fhir/Appointment")
def appointment_search(request: Request):
    from datetime import datetime

    bounds = request.query_params.getlist("date")
    lo = next((datetime.fromisoformat(b[2:]) for b in bounds if b.startswith("ge")), None)
    hi = next((datetime.fromisoformat(b[2:]) for b in bounds if b.startswith("le")), None)
    out = [
        a
        for a in appointments_now()
        if (lo is None or datetime.fromisoformat(a["start"]) >= lo)
        and (hi is None or datetime.fromisoformat(a["start"]) <= hi)
    ]
    return bundle(out)


@app.get("/fhir/Condition")
def conditions(patient: str):
    return _for(CONDITIONS, patient)


@app.get("/fhir/MedicationStatement")
def meds(patient: str):
    return _for(MEDS, patient)


@app.get("/fhir/Encounter")
def encounters(patient: str):
    return _for(ENCOUNTERS, patient)
