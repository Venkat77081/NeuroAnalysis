"""Hospital connector (decision 023). The real one runs at the hospital (FHIR or read-only SQL
views, M11) and keeps the NCID <-> MRN link and patient contact details in the hospital's own
database. Until it is configured, this dummy keeps the link in process memory only — never in
NeuroCapture's database — so invite flows can be built and tested end to end.
"""

from dataclasses import dataclass


@dataclass
class PatientLink:
    site_id: str
    ncid: str
    mrn: str


class DummyConnector:
    def __init__(self) -> None:
        self._links: dict[tuple[str, str], PatientLink] = {}

    def link_patient(self, site_id: str, ncid: str, mrn: str) -> None:
        self._links[(site_id, ncid)] = PatientLink(site_id, ncid, mrn)

    def ncid_for_mrn(self, site_id: str, mrn: str) -> str | None:
        for link in self._links.values():
            if link.site_id == site_id and link.mrn == mrn:
                return link.ncid
        return None

    def clear(self) -> None:
        self._links.clear()


#: Process-wide dummy connector (dev, tests). Replaced per hospital in M11.
CONNECTOR = DummyConnector()
