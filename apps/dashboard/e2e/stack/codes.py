"""Prints the current two-step sign-in code of every test-stack account (instead of an
authenticator app):  python codes.py <work dir>/stack.json"""

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))
from app.security import totp_code  # noqa: E402

s = json.loads(Path(sys.argv[1]).read_text())
left = 30 - int(time.time()) % 30
for label, key in (
    ("platform admin", "root"),
    ("hospital admin", "admin"),
    ("receptionist", "desk"),
    ("Dr. Rao", "doctor"),
    ("Dr. Iyer", "doctor2"),
):
    print(f"{label:<16} {s[f'{key}_email']:<30} {totp_code(s[f'{key}_totp'])}")  # noqa: T201
print(f"(valid for about {left} s more)")  # noqa: T201
