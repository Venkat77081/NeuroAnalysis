"""Runs the platform (backend) and the connector in one process, wired to each other through
TestClients, with a fake FHIR server as the hospital's records."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_TESTS = Path(__file__).resolve().parents[2] / "backend" / "tests"
sys.path.insert(0, str(BACKEND_TESTS))

import fake_fhir  # noqa: E402


@pytest.fixture
def platform_api(tmp_path, monkeypatch):
    from app import db as dbmod
    from app import keys, storage
    from app.config import get_settings
    from app.models import Base

    s = get_settings()
    monkeypatch.setattr(s, "database_url", "sqlite+pysqlite:///:memory:")
    monkeypatch.setattr(s, "storage", "local")
    monkeypatch.setattr(s, "storage_dir", str(tmp_path / "store"))
    monkeypatch.setattr(s, "public_base_url", "http://testserver")
    monkeypatch.setattr(s, "part_size", 1024)
    # Pre-M12 tests record without a hospital take key (the platform key); M12 tests turn it on.
    monkeypatch.setattr(s, "require_hospital_key", False)
    monkeypatch.setattr(s, "allow_legacy_ref_hash", True)
    for f in (dbmod.get_engine, dbmod._factory, storage.get_storage, keys.server_public_key):
        f.cache_clear()
    Base.metadata.create_all(dbmod.get_engine())
    from app.main import app

    with TestClient(app) as client:
        yield client
    for f in (dbmod.get_engine, dbmod._factory, storage.get_storage):
        f.cache_clear()


@pytest.fixture
def connector(platform_api, monkeypatch):
    """A connector for a freshly onboarded hospital, registered with the platform."""
    from app.api import connector_link
    from app.keys import _ephemeral
    from app.providers import OUTBOX as PLATFORM_OUTBOX
    from app.signing import platform_key
    from test_tenancy import hdr, onboard, sign_up

    import ncconnector.platform as ncplatform
    from ncconnector import activity, keys, records
    from ncconnector import db as ncdb
    from ncconnector.config import get_settings
    from ncconnector.keys import public_pem, signing_key
    from ncconnector.main import app as connector_app
    from ncconnector.providers import OUTBOX
    from ncconnector.records.fhir import FhirRecords

    PLATFORM_OUTBOX.clear()
    OUTBOX.clear()
    fake_fhir.REQUESTS.clear()
    fake_fhir.DOWN["value"] = False
    from app.admin import create_platform_admin
    from app.db import _factory

    with _factory()() as db:
        _, link = create_platform_admin(db, "root@example.org")
    tok = link.split("t=", 1)[1]
    platform_api.post("/staff/invite/accept", json={"token": tok, "password": "correct-horse-42"})
    root_tok, _ = _two_step(platform_api, "root@example.org")
    site_id = onboard(platform_api, root_tok, "Sunrise Neuro Clinic", "admin@sunrise.example")
    admin_tok, admin_secret = sign_up(platform_api, "admin@sunrise.example")

    cs = get_settings()
    monkeypatch.setattr(cs, "site_id", site_id)
    monkeypatch.setattr(cs, "platform_url", "http://testserver")
    monkeypatch.setattr(cs, "database_url", "sqlite+pysqlite:///:memory:")
    monkeypatch.setattr(cs, "hospital_name", "Sunrise Neuro Clinic")
    monkeypatch.setattr(cs, "activity_sink", "db")
    monkeypatch.setattr(cs, "reminder_interval_s", 0)
    for f in (ncdb.get_engine, ncdb.factory, signing_key):
        f.cache_clear()
    ncdb.init_db()
    monkeypatch.setattr(keys, "PLATFORM_KEY_OVERRIDE", platform_key().public_key())
    monkeypatch.setattr(keys, "TAKE_KEY_OVERRIDE", _ephemeral())
    monkeypatch.setattr(ncplatform, "CLIENT", platform_api)
    fhir_client = TestClient(fake_fhir.app, base_url="http://fhir.test")
    monkeypatch.setattr(
        records,
        "OVERRIDE",
        FhirRecords("http://fhir.test/fhir", fake_fhir.MRN_SYSTEM, None, 5, client=fhir_client),
    )
    monkeypatch.setattr(activity, "HTTP_CLIENT", None)
    conn = TestClient(connector_app, base_url="http://connector.test")
    monkeypatch.setattr(connector_link, "CONNECTOR_CLIENT", conn)

    r = platform_api.put(
        "/hospital/connector",
        headers=hdr(admin_tok),
        json={"url": "http://connector.test", "public_key_pem": public_pem(signing_key().public_key())},
    )
    assert r.status_code == 200, r.text
    yield {
        "platform": platform_api,
        "client": conn,
        "site_id": site_id,
        "root_tok": root_tok,
        "admin_tok": admin_tok,
        "admin_secret": admin_secret,
    }
    for f in (ncdb.get_engine, ncdb.factory):
        f.cache_clear()


def _two_step(api, email, password="correct-horse-42"):  # noqa: S107 - test password
    from app.security import totp_code

    t = api.post("/staff/login", json={"email": email, "password": password}).json()["tokens"]["access_token"]
    secret = api.post("/staff/two-step/setup", headers={"Authorization": f"Bearer {t}"}).json()["secret"]
    r = api.post(
        "/staff/two-step/confirm", json={"code": totp_code(secret)}, headers={"Authorization": f"Bearer {t}"}
    )
    return r.json()["access_token"], secret
