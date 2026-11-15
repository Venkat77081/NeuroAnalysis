"""python -m ncconnector keygen --out /secrets/connector-signing.pem
    Writes the connector's Ed25519 key and prints the public key to paste into the hospital
    dashboard (Data connections).
python -m ncconnector flush-log
    Re-sends spooled activity entries to the hospital log server.
python -m ncconnector openapi
    Prints the connector API as JSON.
"""

import argparse
import json


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m ncconnector")
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen")
    k.add_argument("--out", required=True)
    sub.add_parser("flush-log")
    sub.add_parser("openapi")
    a = ap.parse_args(argv)
    if a.cmd == "keygen":
        from ncconnector.keys import generate_signing_key

        print(generate_signing_key(a.out))  # noqa: T201
    elif a.cmd == "flush-log":
        from ncconnector import activity
        from ncconnector.db import factory, init_db

        init_db()
        with factory()() as db:
            print(activity.flush(db))  # noqa: T201
    else:
        from ncconnector.main import app

        print(json.dumps(app.openapi(), indent=2))  # noqa: T201


if __name__ == "__main__":
    main()
