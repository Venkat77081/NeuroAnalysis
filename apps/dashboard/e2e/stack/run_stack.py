# ruff: noqa: S603 - test harness: fixed commands run with this interpreter
"""M14 end-to-end stack: the real platform API, the real hospital connector and a stand-in FHIR
server, each in its own process, seeded with one hospital, its staff, a patient and an encrypted
home recording. Writes stack.json for the Playwright tests; stays up until killed.

    python run_stack.py --dir <work dir>                 (needs backend and connector installed)
    python run_stack.py --dir <work dir> --lan 192.168.1.20
        listen on the network too, so a phone on the same Wi-Fi can use it (debug APK, http).

Seeding goes through the database only for accounts (passwords and two-step secrets are set
directly so tests can sign in); the patient, invite, session and recording go through the APIs
exactly as phones and the connector use them.
"""

import argparse
import atexit
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[4]
P_PORT, C_PORT, F_PORT = 8001, 8101, 8180
ORIGIN = "http://localhost:5174"
PW = "correct-horse-42"  # noqa: S105 - e2e only
PATIENT_MRN = "00012388"
OTHER_MRN = "00012401"  # Ravi Samplename (no e-mail on file)


def wait(url: str, timeout: float = 30, log: Path | None = None) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if httpx.get(url, timeout=1).status_code < 500:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    tail = ""
    if log and log.exists():
        lines = log.read_text(errors="replace").splitlines()[-25:]
        tail = f"\n\nLast lines of {log}:\n" + "\n".join(lines)
        if "ModuleNotFoundError" in tail or "ImportError" in tail:
            tail += (
                '\n\nA Python package is missing: run  pip install -e "backend[dev]" -e "connector[dev]"'
                "  (with the .venv activated), then try again."
            )
    raise SystemExit(f"{url} did not start.{tail}")


def _in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sk:
        return sk.connect_ex(("127.0.0.1", port)) == 0


def summary(o: dict) -> str:
    """Who can sign in where (all accounts use the same password)."""
    rows = [
        ("Platform admin", o["root_email"], o["root_totp"]),
        ("Hospital admin", o["admin_email"], o["admin_totp"]),
        ("Receptionist", o["desk_email"], o["desk_totp"]),
        ("Doctor (Dr. Rao)", o["doctor_email"], o["doctor_totp"]),
        ("Doctor (Dr. Iyer)", o["doctor2_email"], o["doctor2_totp"]),
        ("Doctor, first sign-in", o["new_doctor_email"], "(set up on first sign-in)"),
    ]
    lines = [
        "",
        "NeuroCapture test stack",
        f"  Platform API : {o['platform_url']}    Connector: {o['connector_url']}",
        "  Dashboard    : in another terminal run `pnpm dev:dashboard`, then open http://localhost:5174",
        f"  Password for every account: {o['password']}",
        "  Two-step codes (change every 30 s): "
        f"python {Path('apps/dashboard/e2e/stack/codes.py')} {Path(o['store']).parent / 'stack.json'}",
        "    or add a key below to an authenticator app (Enter a set-up key, time-based)",
        "",
    ]
    lines += [f"  {r:<22} {e:<30} key {k}" for r, e, k in rows]
    lines += [
        "",
        f"  Patient in the records: Asha Testpatient, MRN {o['patient_mrn']} "
        f"({len(o['takes'])} home recording{'s' if len(o['takes']) > 1 else ''} uploaded)",
        "  Other record: Ravi Samplename, MRN 00012401 (no e-mail on file)",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--lan", help="this computer's address on the Wi-Fi (for a phone)")
    ap.add_argument(
        "--video",
        action="append",
        default=[],
        metavar="[TEST=]PATH",
        help="a real recording to upload as Asha's take instead of the sample, e.g. take.mp4 or "
        "SAW=walk.mp4 (test FT, FTF, FR, SAW or FA; default --test). Repeat for more takes. "
        "The connector analyses each one; the video stays on this computer.",
    )
    ap.add_argument(
        "--test",
        default="FT",
        help="test of a --video given without TEST= (default FT)",
    )
    args = ap.parse_args()
    videos = videos_to_upload(args.video, args.test)
    work = Path(args.dir).resolve()
    host = args.lan or "127.0.0.1"
    bind = "0.0.0.0" if args.lan else "127.0.0.1"  # noqa: S104 - opt-in, for a phone on the LAN
    # The dashboard (localhost:5174) and the phone app's WebView (https://localhost) call from a browser.
    origins = f"{ORIGIN},https://localhost,http://localhost"
    busy = [port for port in (P_PORT, C_PORT, F_PORT) if _in_use(port)]
    if busy:
        raise SystemExit(
            f"Port(s) {', '.join(map(str, busy))} already in use: an earlier test stack is still "
            "running. Stop it (Ctrl+C in its window; on Windows also `taskkill /F /IM python.exe`), "
            "then run this again."
        )
    work.mkdir(parents=True, exist_ok=True)
    for f in work.glob("*"):
        if f.is_file():
            try:
                f.unlink()
            except PermissionError:
                raise SystemExit(
                    f"{f} is in use by another program (an earlier test stack?). Stop it "
                    "(on Windows: `taskkill /F /IM python.exe`), or use another --dir."
                ) from None
    (work / "store").mkdir(exist_ok=True)
    (work / "take-keys").mkdir(exist_ok=True)

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    def pem_private(k) -> bytes:
        return k.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )

    def pem_public(k) -> str:
        return (
            k.public_key()
            .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
            .decode()
        )

    platform_key = Ed25519PrivateKey.generate()
    (work / "platform-signing.pem").write_bytes(pem_private(platform_key))
    (work / "platform-public.pem").write_text(pem_public(platform_key))
    connector_key = Ed25519PrivateKey.generate()
    (work / "connector-signing.pem").write_bytes(pem_private(connector_key))

    platform_env = {
        **os.environ,
        "NC_DATABASE_URL": f"sqlite+pysqlite:///{work / 'platform.db'}",
        "NC_DEV_STORAGE": "true",  # decision 044: test stack only
        "NC_STORAGE": "local",
        "NC_STORAGE_DIR": str(work / "store"),
        "NC_PUBLIC_BASE_URL": f"http://{host}:{P_PORT}",
        "NC_CORS_ORIGINS": origins,
        "NC_DASHBOARD_URL": ORIGIN,
        "NC_PLATFORM_SIGNING_KEY_PATH": str(work / "platform-signing.pem"),
        "NC_JWT_SECRET": "e2e-only-jwt-secret",
        "NC_CONFIG_DIR": str(ROOT / "config"),
    }
    # --- Accounts (direct to the database, like `python -m app.admin`) ---
    seed = subprocess.run(
        [sys.executable, str(Path(__file__).with_name("seed_accounts.py"))],
        env={
            **platform_env,
            "E2E_CONNECTOR_URL": f"http://{host}:{C_PORT}",
            "E2E_CONNECTOR_PUBLIC": pem_public(connector_key),
            "E2E_PASSWORD": PW,
        },
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT / "backend",
    )
    accounts = json.loads(seed.stdout.strip().splitlines()[-1])

    logs = {name: open(work / f"{name}.log", "w") for name in ("platform", "connector", "fhir")}  # noqa: SIM115
    procs = [
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", bind, "--port", str(P_PORT)],
            cwd=ROOT / "backend",
            env=platform_env,
            stdout=logs["platform"],
            stderr=subprocess.STDOUT,
        ),
        subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "fake_fhir:app", "--host", "127.0.0.1", "--port", str(F_PORT)],
            cwd=ROOT / "connector" / "tests",
            env=os.environ.copy(),
            stdout=logs["fhir"],
            stderr=subprocess.STDOUT,
        ),
        subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "ncconnector.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(C_PORT),
            ],
            cwd=work,
            env={
                **os.environ,
                "NCC_SITE_ID": accounts["site_id"],
                "NCC_PLATFORM_URL": f"http://127.0.0.1:{P_PORT}",
                "NCC_PLATFORM_PUBLIC_KEY_PATH": str(work / "platform-public.pem"),
                "NCC_SIGNING_KEY_PATH": str(work / "connector-signing.pem"),
                "NCC_TAKE_KEYS_DIR": str(work / "take-keys"),
                "NCC_DATABASE_URL": f"sqlite+pysqlite:///{work / 'connector.db'}",
                "NCC_RECORDS": "fhir",
                "NCC_FHIR_BASE_URL": f"http://127.0.0.1:{F_PORT}/fhir",
                "NCC_FHIR_MRN_SYSTEM": "urn:test-hospital:mrn",
                "NCC_HOSPITAL_NAME": "Sunrise Neuro Clinic",
                "NCC_CORS_ORIGINS": origins,
                # Decision 060: look for newly uploaded takes often, so the e2e sees the automatic analysis.
                "NCC_ANALYSIS_INTERVAL_S": "3",
            },
            stdout=logs["connector"],
            stderr=subprocess.STDOUT,
        ),
    ]

    def end_servers() -> None:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()

    # Servers stop with this script however it ends (Ctrl+C, an error, the window closing).
    atexit.register(end_servers)

    def stop(*_):
        end_servers()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGBREAK"):  # Windows: closing the console window, Ctrl+Break
        signal.signal(signal.SIGBREAK, stop)
    wait(f"http://127.0.0.1:{P_PORT}/health", log=work / "platform.log")
    wait(f"http://127.0.0.1:{F_PORT}/fhir/Patient", log=work / "fhir.log")
    wait(f"http://127.0.0.1:{C_PORT}/health", log=work / "connector.log")

    # --- The hospital's take key: created on the connector, registered through a signed call ---
    sys.path.insert(0, str(ROOT / "connector"))
    os.environ.update(
        {
            "NCC_SITE_ID": accounts["site_id"],
            "NCC_PLATFORM_URL": f"http://127.0.0.1:{P_PORT}",
            "NCC_SIGNING_KEY_PATH": str(work / "connector-signing.pem"),
            "NCC_TAKE_KEYS_DIR": str(work / "take-keys"),
            "NCC_PLATFORM_PUBLIC_KEY_PATH": str(work / "platform-public.pem"),
        }
    )
    from ncconnector.keys import rotate_take_key

    rotate_take_key()

    # --- Patient: invited by the front desk through the connector, accepts, records at home ---
    from app.security import totp_code

    api = httpx.Client(base_url=f"http://127.0.0.1:{P_PORT}", timeout=30)
    ch = api.post("/staff/login", json={"email": accounts["desk_email"], "password": PW}).json()[
        "challenge_token"
    ]
    at = api.post(
        "/staff/login/two-step", json={"challenge_token": ch, "code": totp_code(accounts["desk_totp"])}
    ).json()
    ct = api.post(
        "/hospital/connector-token", headers={"Authorization": f"Bearer {at['access_token']}"}
    ).json()
    inv = httpx.post(
        f"{ct['connector_url']}/v1/invites",
        headers={"Authorization": f"Bearer {ct['token']}"},
        json={"mrns": [PATIENT_MRN], "channel": "print"},
        timeout=30,
    ).json()[0]
    tok = inv["invite_link"].split("t=", 1)[1]
    acc = api.post(
        "/patient/invite/accept",
        json={
            "token": tok,
            "pin": "2580",
            "consent_version": "home-consent@1",
            "model": "e2e",
            "os_version": "15",
            # Decision 062: the phone check's numbers (a "6 GB" phone with 18 GB free).
            "camera_check": {
                "effective_fps": 60,
                "brand": "samsung",
                "video_width": 1920,
                "video_height": 1080,
                "video_bytes_per_s": 3600000,
                "ram_total_bytes": int(5.6 * (1 << 30)),
                "ram_free_bytes": 2900000000,
                "storage_free_bytes": 18400000000,
                "storage_total_bytes": 128000000000,
                "start_sign": "works",
                "tracking_hz": 24.0,
            },
        },
    ).json()
    # Ravi's phone fails the camera check (decision 035); he tells the hospital, so reception and
    # the doctor see "Phone not suitable". His invite stays valid.
    ravi = httpx.post(
        f"{ct['connector_url']}/v1/invites",
        headers={"Authorization": f"Bearer {ct['token']}"},
        json={"mrns": [OTHER_MRN], "channel": "print"},
        timeout=30,
    ).json()[0]
    told = api.post(
        "/patient/invite/phone-not-suitable",
        json={
            "token": ravi["invite_link"].split("t=", 1)[1],
            "model": "e2e old phone",
            "camera_check": {"effective_fps": 41},
        },
    )
    assert told.status_code == 204, told.text
    ph = {"Authorization": f"Bearer {acc['tokens']['access_token']}"}
    sess = api.post(
        "/sessions",
        headers=ph,
        json={
            "client_session_id": "e2e-home-1",
            "med_state": "OFF",
            "started_at": "2026-11-15T04:00:00Z",
            "consent_version": "home-consent@1",
            "consent_at": "2026-11-15T03:59:00Z",
            "app_version": "0.5.0",
            "config_versions": {"session": "SESSION@2.5.0"},
        },
    ).json()
    key = sess["encryption_key"]
    assert key["owner"] == "hospital", key

    pub = serialization.load_pem_public_key(key["public_key_pem"].encode())
    assert isinstance(pub, rsa.RSAPublicKey)
    uploaded = []
    for n, (test_code, path) in enumerate(videos):
        video = path.read_bytes()
        cid = "e2e-take-ft" if not args.video else f"local-take-{n + 1}"
        take_id = upload_take(api, ph, sess, key, pub, cid, test_code, n + 1, video)
        uploaded.append((test_code, path.name, take_id, video))
        if args.video:
            print(
                f"  uploaded {path.name} as {test_code} ({len(video) / 1e6:.1f} MB)",
                flush=True,
            )  # noqa: T201
    _, _, first_take, video = uploaded[0]

    out = {
        **accounts,
        "password": PW,
        "platform_url": f"http://{host}:{P_PORT}",
        "connector_url": f"http://{host}:{C_PORT}",
        "patient_ncid": inv["ncid"],
        "patient_mrn": PATIENT_MRN,
        # v13: the patient's phone, so tests can ask for an appointment change as the app does.
        "patient_device_id": acc["device_id"],
        "patient_device_secret": acc["device_secret"],
        "patient_pin": "2580",
        "take_id": first_take,
        "video_sha256": hashlib.sha256(video).hexdigest(),
        "takes": [{"test_code": t, "file": f, "take_id": i} for t, f, i, _ in uploaded],
        "platform_db": str(work / "platform.db"),
        "platform_log": str(work / "platform.log"),
        "store": str(work / "store"),
    }
    (work / "stack.json").write_text(json.dumps(out, indent=2))
    print(summary(out), flush=True)  # noqa: T201
    if args.video:
        print(  # noqa: T201
            "  Your videos are analysed by the connector in the background (about a minute each for "
            "a 15 s take, longer for Stand and Walk); then sign in as Dr. Rao and open Asha's "
            "Biomarker report.\n",
            flush=True,
        )
    print("ready", flush=True)  # noqa: T201
    while all(p.poll() is None for p in procs):
        time.sleep(0.5)
    stop()


def upload_take(
    api,
    ph: dict,
    sess: dict,
    key: dict,
    pub,
    cid: str,
    test_code: str,
    take_no: int,
    video: bytes,
) -> str:
    """Uploads one take as the patient's phone does: encrypted with a fresh data key for the hospital."""
    from analysis.takecrypto import encrypt_file, new_data_keyset, wrap_data_key

    keyset = new_data_keyset()
    files = {"video": encrypt_file(keyset, cid, "video", video)}
    plan = api.post(
        "/takes",
        headers=ph,
        json={
            "session_id": sess["id"],
            "client_take_id": cid,
            "test_code": test_code,
            "side": None,
            "take_no": take_no,
            "capture_verdict": "PASS",
            "quality": {"captureVerdict": "PASS"},
            "meta": {},
            "wrapped_data_key": wrap_data_key(keyset, pub),
            "key_id": key["key_id"],
            "files": [
                {
                    "kind": k,
                    "size_bytes": len(v),
                    "sha256": hashlib.sha256(v).hexdigest(),
                }
                for k, v in files.items()
            ],
        },
    ).json()
    for f in plan["files"]:
        data, size, etags = files[f["kind"]], f["part_size"], []
        for p in f["parts"]:
            chunk = data[(p["number"] - 1) * size : p["number"] * size]
            r = httpx.put(p["url"], content=chunk, timeout=30)
            etags.append({"number": p["number"], "etag": r.headers["ETag"]})
        api.post(
            f"/takes/{plan['take_id']}/files/{f['kind']}/complete",
            headers=ph,
            json={"parts": etags},
        )
    api.post(f"/takes/{plan['take_id']}/complete", headers=ph)
    return plan["take_id"]


def videos_to_upload(given: list[str], default_test: str) -> list[tuple[str, Path]]:
    """(test, path) per --video, checked before anything starts; the sample take without any."""
    if not given:
        return [("FT", ROOT / "apps" / "dashboard" / "e2e" / "stack" / "sample.mp4")]
    tests = {"FT", "FTF", "FR", "SAW", "FA"}
    out = []
    for g in given:
        code, sep, rest = g.partition("=")
        test, path = (
            (code.strip().upper(), Path(rest))
            if sep and code.strip().isalpha() and len(code.strip()) <= 4  # "SAW=walk.mp4", not a path
            else (default_test.upper(), Path(g))
        )
        if test not in tests:
            raise SystemExit(f"Unknown test {test!r}: use one of {', '.join(sorted(tests))}.")
        if not path.is_file():
            raise SystemExit(f"Video not found: {path}")
        out.append((test, path.resolve()))
    try:
        from ncbio.keypoints import TEST_KINDS, model_path
        from ncbio.run import REPORT_TESTS
    except ImportError:
        raise SystemExit(
            "The biomarker analysis (ncbio) is not installed for this Python, so the connector would not "
            f"analyse the video. Install it: {sys.executable} -m pip install -e biomarkers"
        ) from None
    kinds = sorted({k for test, _ in out for k in TEST_KINDS[test]})
    missing = [k for k in kinds if not model_path(k).is_file()]
    if missing:
        raise SystemExit(
            f"Models missing ({', '.join(missing)}). Download them once: "
            f"cd biomarkers && {sys.executable} -m ncbio models"
        )
    for test, _ in out:
        if test not in REPORT_TESTS:
            raise SystemExit(f"{test} is not analysed yet.")
    return out


if __name__ == "__main__":
    main()
