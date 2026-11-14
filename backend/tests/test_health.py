from fastapi.testclient import TestClient

from app.main import app


def test_health_ok_with_database_and_no_storage(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "storage", "s3")
    monkeypatch.setattr("app.api.health.ping_database", lambda: None)
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["checks"] == {"database": "ok", "storage": "not_configured"}


def test_health_503_when_database_down(monkeypatch):
    def boom():
        raise ConnectionError("down")

    monkeypatch.setattr("app.api.health.ping_database", boom)
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["checks"]["database"] == "error"


def test_health_reports_storage(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr("app.api.health.ping_database", lambda: None)
    monkeypatch.setattr(get_settings(), "storage", "s3")
    monkeypatch.setattr(get_settings(), "s3_endpoint", "http://minio:9000")
    monkeypatch.setattr("app.api.health.ping_storage", lambda: None)
    monkeypatch.setattr("app.main.ensure_bucket", lambda: None)
    with TestClient(app) as client:
        assert client.get("/health").json()["checks"]["storage"] == "ok"

    def boom():
        raise TimeoutError

    monkeypatch.setattr("app.api.health.ping_storage", boom)
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 503
    assert r.json()["checks"]["storage"] == "error"


def test_sqlite_ping_works_in_memory():
    from app.db import ping_database

    ping_database()  # default NC_DATABASE_URL is in-memory SQLite


def test_health_local_storage(monkeypatch, tmp_path):
    from app.config import get_settings

    monkeypatch.setattr("app.api.health.ping_database", lambda: None)
    monkeypatch.setattr(get_settings(), "storage", "local")
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path / "s"))
    with TestClient(app) as client:
        assert client.get("/health").json()["checks"]["storage"] == "ok"
    monkeypatch.setattr(get_settings(), "storage_dir", "/proc/forbidden")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 503
