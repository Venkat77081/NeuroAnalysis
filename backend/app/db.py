from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session as DbSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import get_settings


@lru_cache
def get_engine() -> Engine:
    url = get_settings().database_url
    if url.startswith("sqlite") and ":memory:" in url:
        # One shared in-memory database for the whole process (tests, quick local runs).
        return create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    return create_engine(url, pool_pre_ping=True)


@lru_cache
def _factory() -> sessionmaker[DbSession]:
    return sessionmaker(bind=get_engine(), expire_on_commit=False)


def get_db() -> Iterator[DbSession]:
    db = _factory()()
    try:
        yield db
    finally:
        db.close()


def ping_database() -> None:
    with get_engine().connect() as conn:
        conn.execute(text("SELECT 1"))
