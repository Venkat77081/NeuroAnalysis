import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.api.auth import router as auth_router
from app.api.devices import router as devices_router
from app.api.health import router as health_router
from app.api.readiness import router as readiness_router
from app.api.sessions import router as sessions_router
from app.api.storage_local import router as storage_router
from app.api.takes import router as takes_router
from app.config import get_settings
from app.storage import ensure_bucket

log = logging.getLogger("neurocapture")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if get_settings().storage == "s3" and get_settings().s3_endpoint:
        try:
            ensure_bucket()
        except Exception as exc:  # noqa: BLE001 - /health reports storage problems
            log.warning("could not ensure bucket: %s", type(exc).__name__)
    yield


app = FastAPI(title="NeuroCapture API", version=__version__, lifespan=lifespan)
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(devices_router)
app.include_router(sessions_router)
app.include_router(takes_router)
app.include_router(readiness_router)
app.include_router(storage_router)
