"""NeuroCapture hospital connector (PLATFORM_PLAN §3, M11).

Runs in the hospital's network (or per clinic, managed by NeuroCapture). Patient identity —
names, MRNs, contact details, records — is read live from the hospital's systems and is only
written to the connector's own database (the NCID <-> MRN map). It is never sent to the platform.
"""

__version__ = "0.1.0"
