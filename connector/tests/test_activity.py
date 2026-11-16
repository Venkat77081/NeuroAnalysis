"""Activity log: database sink, and the http sink with a spool while the log server is down."""

import httpx
import pytest

from ncconnector import activity
from ncconnector import db as ncdb
from ncconnector.config import get_settings


@pytest.fixture
def db(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "database_url", "sqlite+pysqlite:///:memory:")
    ncdb.get_engine.cache_clear()
    ncdb.factory.cache_clear()
    ncdb.init_db()
    with ncdb.factory()() as session:
        yield session
    ncdb.get_engine.cache_clear()
    ncdb.factory.cache_clear()


def test_db_sink(db):
    activity.write(db, "doctor", "u1", "history_viewed", "nc_" + "a" * 32)
    [row] = db.query(ncdb.ActivityLog).all()
    assert (row.actor_id, row.action, row.ncid) == ("u1", "history_viewed", "nc_" + "a" * 32)


def test_http_sink_spools_and_flushes_in_order(db, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "activity_sink", "http")
    monkeypatch.setattr(s, "activity_http_url", "http://logs.test/ingest")
    received, up = [], {"value": False}

    def handler(request):
        if not up["value"]:
            return httpx.Response(503)
        import json

        received.append(json.loads(request.content)["action"])
        return httpx.Response(204)

    monkeypatch.setattr(activity, "HTTP_CLIENT", httpx.Client(transport=httpx.MockTransport(handler)))
    activity.write(db, "doctor", "u1", "a1")
    activity.write(db, "doctor", "u1", "a2")
    assert db.query(ncdb.LogSpool).count() == 2 and received == []
    up["value"] = True
    activity.write(db, "doctor", "u1", "a3")  # flushes the spool first, then sends
    assert received == ["a1", "a2", "a3"] and db.query(ncdb.LogSpool).count() == 0
    assert db.query(ncdb.ActivityLog).count() == 0  # http sink: nothing kept locally once sent
