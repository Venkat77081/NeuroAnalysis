"""Signed calls from this connector to the NeuroCapture platform. Never sends patient identity:
only NCIDs, invite channels and take IDs."""

import json

import httpx

from ncconnector.config import get_settings
from ncconnector.keys import signing_key
from ncconnector.signing import sign_headers

#: Tests inject an httpx.Client (a TestClient of the platform app).
CLIENT: httpx.Client | None = None


class PlatformError(RuntimeError):
    def __init__(self, status_code: int, detail):
        super().__init__(f"platform answered {status_code}")
        self.status_code = status_code
        self.detail = detail


def _client() -> httpx.Client:
    return CLIENT if CLIENT is not None else httpx.Client(timeout=15)


def call(method: str, path: str, payload: dict | None = None):
    s = get_settings()
    body = b"" if payload is None else json.dumps(payload).encode()
    headers = sign_headers(signing_key(), s.site_id, method, path, body)
    if payload is not None:
        headers["Content-Type"] = "application/json"
    try:
        r = _client().request(method, s.platform_url.rstrip("/") + path, content=body, headers=headers)
    except httpx.HTTPError as exc:
        raise PlatformError(503, {"code": "platform_unreachable"}) from exc
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = None
        raise PlatformError(r.status_code, detail)
    return r.json() if r.content else None


def download(url: str) -> bytes:
    """Encrypted object from a short-lived link (S3 presigned or the platform's local storage)."""
    try:
        r = _client().get(url) if CLIENT is not None else httpx.get(url, timeout=60)
    except httpx.HTTPError as exc:
        raise PlatformError(503, {"code": "storage_unreachable"}) from exc
    if r.status_code != 200:
        raise PlatformError(r.status_code, {"code": "download_failed"})
    return r.content
