"""A take's files, fetched and decrypted at the hospital (M12). Used for doctors' requests and for
the automatic biomarker analysis (decision 060). Only this connector holds the take key."""

from __future__ import annotations

import hashlib
import logging

from fastapi import HTTPException, status

from ncconnector import platform
from ncconnector.keys import take_private_key
from ncconnector.storage import read_object
from ncconnector.takecrypto import decrypt_file, unwrap_data_key

log = logging.getLogger("ncconnector.takes")


def platform_error(exc: platform.PlatformError) -> HTTPException:
    code = exc.status_code if exc.status_code in (403, 404, 409, 422) else 502
    return HTTPException(code, exc.detail or {"code": "platform_error"})


def info(take_id: str) -> dict:
    """The platform's record of the take: NCID, test, wrapped key, where each file is."""
    try:
        return platform.call("GET", f"/connector/v1/takes/{take_id}")
    except platform.PlatformError as exc:
        raise platform_error(exc) from exc


def decrypted(take: dict, kind: str) -> bytes:
    """One file of the take: fetched, checked against its SHA-256 and decrypted."""
    take_id = take["take_id"]
    key = take_private_key(take["key_id"])
    if key is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "no_take_key", "key_id": take["key_id"]}
        )
    f = next((x for x in take["files"] if x["kind"] == kind), None)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not in this take")
    try:
        ciphertext = read_object(f["location"]) if f.get("location") else platform.download(f["url"])
    except platform.PlatformError as exc:
        raise platform_error(exc) from exc
    ok = hashlib.sha256(ciphertext).hexdigest() == f["sha256"]
    if f.get("checksum_verified") is None:
        # Hospital bucket: the platform could not read the file; report the check (M12).
        try:
            platform.call("POST", f"/connector/v1/takes/{take_id}/files/{kind}/verified", {"ok": ok})
        except platform.PlatformError:
            log.warning("could not report checksum result")
    if not ok:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, {"code": "checksum_mismatch"})
    try:
        return decrypt_file(
            unwrap_data_key(take["wrapped_data_key"], key), take["client_take_id"], kind, ciphertext
        )
    except Exception as exc:  # noqa: BLE001 - wrong key or corrupt file
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "cannot_decrypt"}) from exc
