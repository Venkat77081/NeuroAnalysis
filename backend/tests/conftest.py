import pytest
from fastapi.testclient import TestClient

from app.config import get_settings


@pytest.fixture
def api(tmp_path, monkeypatch):
    """App on a fresh in-memory database and temporary local storage, with 1 KiB upload parts."""
    from app import db as dbmod
    from app import keys, storage
    from app.models import Base

    s = get_settings()
    monkeypatch.setattr(s, "database_url", "sqlite+pysqlite:///:memory:")
    monkeypatch.setattr(s, "storage", "local")
    monkeypatch.setattr(s, "storage_dir", str(tmp_path / "store"))
    monkeypatch.setattr(s, "public_base_url", "http://testserver")
    monkeypatch.setattr(s, "part_size", 1024)
    for f in (dbmod.get_engine, dbmod._factory, storage.get_storage, keys.server_public_key):
        f.cache_clear()
    Base.metadata.create_all(dbmod.get_engine())
    from app.main import app

    with TestClient(app) as client:
        yield client
    for f in (dbmod.get_engine, dbmod._factory, storage.get_storage):
        f.cache_clear()


@pytest.fixture
def site(api):
    from app.admin import create_operator, create_site
    from app.db import _factory

    with _factory()() as db:
        st = create_site(db, "Clinic A", "IN", "ENROL-123456")
        op = create_operator(db, st.id, "OP-07", "2468")
        rv = create_operator(db, st.id, "RV-01", "1357", role="reviewer")
        ad = create_operator(db, st.id, "AD-01", "9999", role="admin")
        return {"site_id": st.id, "salt": st.patient_ref_salt, "op": op.id, "rv": rv.id, "ad": ad.id}
