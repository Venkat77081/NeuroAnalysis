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


@app.get("/fhir/Condition")
def conditions(patient: str):
    return _for(CONDITIONS, patient)


@app.get("/fhir/MedicationStatement")
def meds(patient: str):
    return _for(MEDS, patient)


@app.get("/fhir/Encounter")
def encounters(patient: str):
    return _for(ENCOUNTERS, patient)
