"""Decrypt one uploaded take into a plaintext folder for tools/replay (DEV KEYS ONLY).

    python -m analysis.export_take <server take id> <out dir>

Needs the server private key on this machine (NC_SERVER_PRIVATE_KEY_PATH, or the ephemeral dev
key of a running process — i.e. tests). Never point this at real patient data outside the secure
analysis environment: the output is unencrypted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from sqlalchemy import select

from analysis.takecrypto import FILE_NAMES, decrypt_file, unwrap_data_key
from app.db import _factory
from app.keys import server_private_key
from app.models import Take, TakeFile
from app.storage import get_storage


def export_take(take_id: str, out: Path) -> list[str]:
    with _factory()() as db:
        take = db.get(Take, take_id)
        if take is None:
            raise SystemExit(f"take {take_id} not found")
        key = server_private_key(take.key_id)
        if key is None:
            raise SystemExit(f"no private key for {take.key_id} on this machine")
        keyset = unwrap_data_key(take.wrapped_data_key, key)
        out.mkdir(parents=True, exist_ok=True)
        written = []
        files = db.scalars(select(TakeFile).where(TakeFile.take_id == take.id)).all()
        for f in files:
            if f.uploaded_at is None or f.kind == "video":
                continue  # replay needs evidence, not the video
            plain = decrypt_file(keyset, take.client_take_id, f.kind, get_storage().read(f.object_key))
            (out / FILE_NAMES[f.kind]).write_bytes(plain)
            written.append(FILE_NAMES[f.kind])
        if "quality.json" not in written:
            (out / "quality.json").write_text(json.dumps(take.quality))
            written.append("quality.json")
        return sorted(written)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    print("\n".join(export_take(sys.argv[1], Path(sys.argv[2]))))
