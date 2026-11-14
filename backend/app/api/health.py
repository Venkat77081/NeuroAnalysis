import logging

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from app import __version__
from app.config import get_settings
from app.db import ping_database
from app.storage import ping_local_storage, ping_storage

router = APIRouter()
log = logging.getLogger("neurocapture.health")


class Health(BaseModel):
    status: str
    version: str
    checks: dict[str, str]


@router.get("/health", response_model=Health)
def health(response: Response) -> Health:
    """200 when the API, database and (if configured) object storage are reachable; 503 otherwise."""
    checks: dict[str, str] = {}
    try:
        ping_database()
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001 - report any failure, never crash the probe
        log.warning("database check failed: %s", type(exc).__name__)
        checks["database"] = "error"
    settings = get_settings()
    if settings.storage == "local":
        try:
            ping_local_storage()
            checks["storage"] = "ok"
        except Exception as exc:  # noqa: BLE001
            log.warning("local storage check failed: %s", type(exc).__name__)
            checks["storage"] = "error"
    elif settings.s3_endpoint:
        try:
            ping_storage()
            checks["storage"] = "ok"
        except Exception as exc:  # noqa: BLE001
            log.warning("storage check failed: %s", type(exc).__name__)
            checks["storage"] = "error"
    else:
        checks["storage"] = "not_configured"
    ok = all(v != "error" for v in checks.values())
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return Health(status="ok" if ok else "degraded", version=__version__, checks=checks)
