"""python -m ncconnector keygen --out /secrets/connector-signing.pem
    Writes the connector's Ed25519 key and prints the public key to paste into the hospital
    dashboard (Data connections).
python -m ncconnector rotate-take-key
    (M12) New RSA-3072 take key: registers the public key with the platform, keeps the private key
    in NCC_TAKE_KEYS_DIR. New sessions use it at once; earlier recordings keep their key.
python -m ncconnector take-keys
    Lists the keys on this connector and on the platform (compare fingerprints in the dashboard).
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
    sub.add_parser("rotate-take-key")
    sub.add_parser("take-keys")
    sub.add_parser("send-reminders")
    sub.add_parser("openapi")
    a = ap.parse_args(argv)
    if a.cmd == "keygen":
        from ncconnector.keys import generate_signing_key

        print(generate_signing_key(a.out))  # noqa: T201
    elif a.cmd == "rotate-take-key":
        from ncconnector.keys import rotate_take_key

        print(json.dumps(rotate_take_key(), default=str))  # noqa: T201
    elif a.cmd == "take-keys":
        from ncconnector import platform
        from ncconnector.keys import keyring_ids

        local = set(keyring_ids())
        for k in platform.call("GET", "/connector/v1/keys"):
            here = "here" if k["key_id"] in local else "MISSING"
            print(k["key_id"], k["status"], k["fingerprint"], here)  # noqa: T201
    elif a.cmd == "send-reminders":
        from ncconnector.db import factory, init_db
        from ncconnector.reminders import send_due

        init_db()
        with factory()() as db:
            print(send_due(db))  # noqa: T201
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
