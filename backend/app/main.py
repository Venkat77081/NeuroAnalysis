import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.api.health import router as health_router
from app.config import get_settings
from app.storage import ensure_bucket

log = logging.getLogger("neurocapture")


@asynccontextmanager
async def lifespan(_: FastAPI):
    if get_settings().s3_endpoint:
        try:
            ensure_bucket()
        except Exception as exc:  # noqa: BLE001 - /health reports storage problems
            log.warning("could not ensure bucket: %s", type(exc).__name__)
    yield


app = FastAPI(title="NeuroCapture API", version=__version__, lifespan=lifespan)
app.include_router(health_router)
