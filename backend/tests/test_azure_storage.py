"""Azure Blob Storage for recordings (decision 037), against Azurite, Microsoft's local emulator
(CI starts it; locally: npx azurite-blob --location /tmp/azurite --skipApiVersionCheck --loose).
Phones PUT blocks straight to Blob with a create/write SAS for one blob; the platform commits them,
checks SHA-256, and resumes from the staged blocks."""

import hashlib
import os
import uuid

import httpx
import pytest
from test_upload_flow import SESSION, auth, login, register, take_body

AZURITE = os.environ.get("NC_TEST_AZURITE_URL", "http://127.0.0.1:10000/devstoreaccount1")
ACCOUNT = "devstoreaccount1"
#: Azurite's published development key (not a secret).
KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="  # noqa: S105


def _azurite_up() -> bool:
    try:
        httpx.get(f"{AZURITE}?comp=list", timeout=1)
        return True
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(
    not _azurite_up() and not os.environ.get("NC_REQUIRE_AZURITE"), reason="Azurite is not running"
)


@pytest.fixture
def azure(api, monkeypatch):
    from app import storage
    from app.config import get_settings

    s = get_settings()
    container = f"nc-test-{uuid.uuid4().hex[:8]}"
    for k, v in {
        "storage": "azure",
        "azure_storage_account": ACCOUNT,
        "azure_storage_key": KEY,
        "azure_blob_endpoint": AZURITE,
        "azure_container": container,
    }.items():
        monkeypatch.setattr(s, k, v)
    storage.get_storage.cache_clear()
    storage.get_azure_service.cache_clear()
    storage.ensure_azure_container()
    yield container
    storage.get_storage.cache_clear()
    storage.get_azure_service.cache_clear()


def put_parts(plan_file, data, only=None) -> dict[int, str]:
    """What the phone does: PUT each part to its URL, no extra headers. Azure answers 201, no ETag."""
    size, tags = plan_file["part_size"], {}
    for p in plan_file["parts"]:
        if only is not None and p["number"] not in only:
            continue
        r = httpx.put(p["url"], content=data[(p["number"] - 1) * size : p["number"] * size])
        assert r.status_code == 201, r.text
        assert "etag" not in {k.lower() for k in r.headers}
        tags[p["number"]] = f"azure-{p['number']}"
    return tags


def test_phone_uploads_to_blob_with_resume_and_checksum(api, site, azure):
    assert api.get("/health").json()["checks"]["storage"] == "ok"
    tok = login(api, register(api)).json()
    sid = api.post("/sessions", json=SESSION, headers=auth(tok)).json()["id"]
    video = os.urandom(2560)  # 3 parts of 1 KiB
    quality = b'{"captureVerdict":"PASS"}'
    plan = api.post("/takes", json=take_body(sid, {"video": video, "quality": quality}), headers=auth(tok))
    assert plan.status_code == 201, plan.text
    take_id = plan.json()["take_id"]
    vf = next(f for f in plan.json()["files"] if f["kind"] == "video")
    assert vf["parts"][0]["url"].startswith(f"{AZURITE}/{azure}/") and "comp=block" in vf["parts"][0]["url"]

    # The upload URL may write that one blob, never read it.
    blob_url = vf["parts"][0]["url"].split("?", 1)[0]
    sas = vf["parts"][0]["url"].split("&", 2)[2]
    assert httpx.get(f"{blob_url}?{sas}").status_code == 403

    # Network loss after part 1: the platform sees the staged block and asks only for 2 and 3.
    tags = put_parts(vf, video, only={1})
    vf2 = next(
        f
        for f in api.get(f"/takes/{take_id}/upload", headers=auth(tok)).json()["files"]
        if f["kind"] == "video"
    )
    assert [p["number"] for p in vf2["uploaded_parts"]] == [1]
    assert [p["number"] for p in vf2["parts"]] == [2, 3]

    # Part 3 corrupted in transit: SHA-256 mismatch, then a fresh upload of that file.
    tags |= put_parts(vf2, video, only={2})
    assert httpx.put(vf2["parts"][1]["url"], content=b"x" * 512).status_code == 201
    tags[3] = "azure-3"
    body = {"parts": [{"number": n, "etag": e} for n, e in tags.items()]}
    r = api.post(f"/takes/{take_id}/files/video/complete", json=body, headers=auth(tok))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "checksum_mismatch"
    vf3 = next(
        f
        for f in api.get(f"/takes/{take_id}/upload", headers=auth(tok)).json()["files"]
        if f["kind"] == "video"
    )
    assert vf3["uploaded_parts"] == [] and len(vf3["parts"]) == 3
    body = {"parts": [{"number": n, "etag": e} for n, e in put_parts(vf3, video).items()]}
    assert api.post(f"/takes/{take_id}/files/video/complete", json=body, headers=auth(tok)).status_code == 200
    qf = next(f for f in plan.json()["files"] if f["kind"] == "quality")
    body = {"parts": [{"number": n, "etag": e} for n, e in put_parts(qf, quality).items()]}
    r = api.post(f"/takes/{take_id}/files/quality/complete", json=body, headers=auth(tok))
    assert all(f["verified"] for f in r.json()["files"])
    done = api.post(f"/takes/{take_id}/complete", headers=auth(tok))
    assert done.status_code == 200 and done.json()["status"] == "complete"

    # The stored blob is the recording, byte for byte; a read link (for the connector) works.
    from app.storage import get_storage

    st = get_storage()
    key = f"{site['site_id']}/{sid}/{take_id}/video.enc"
    assert st.sha256(key) == hashlib.sha256(video).hexdigest() and st.size(key) == len(video)
    assert httpx.get(st.download_url(key, 60)).content == video


def test_block_ids_are_fixed_length():
    from app.storage.azure import _number, block_id

    up = uuid.uuid4().hex
    ids = {block_id(up, n) for n in (1, 99, 10000)}
    assert len({len(i) for i in ids}) == 1
    assert sorted(_number(up, i) for i in ids) == [1, 99, 10000]
    assert _number(uuid.uuid4().hex, block_id(up, 1)) is None  # another upload's block
    with pytest.raises(ValueError):
        block_id("short", 1)
