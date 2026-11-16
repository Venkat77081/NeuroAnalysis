"""M14 acceptance check: NeuroCapture's database, logs and stored files hold no patient name or
MRN. Prints the matches (if any) as JSON; exit status 1 when something is found."""

import json
import sqlite3
import sys
from pathlib import Path

stack = json.loads(Path(sys.argv[1]).read_text())
needles = [stack["patient_mrn"], *sys.argv[2:]]
found = []
con = sqlite3.connect(stack["platform_db"])
for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'"):
    for row in con.execute(f'SELECT * FROM "{table}"'):  # noqa: S608 - table names from sqlite_master
        text = json.dumps([str(v) for v in row])
        found += [f"db:{table}:{n}" for n in needles if n.lower() in text.lower()]
log = Path(stack["platform_log"]).read_text(errors="replace")
found += [f"log:{n}" for n in needles if n.lower() in log.lower()]
for f in Path(stack["store"]).rglob("*"):
    if f.is_file():
        data = f.read_bytes()
        found += [f"store:{f.name}:{n}" for n in needles if n.encode() in data]
rows = sum(1 for _ in con.execute("SELECT 1 FROM audit_events"))
print(json.dumps({"found": found, "audit_rows": rows, "log_bytes": len(log)}))  # noqa: T201
sys.exit(1 if found else 0)
