"""Command line (runs at the hospital, on decrypted takes only):

    python -m ncbio models                         # download the keypoint models (once)
    python -m ncbio analyse VIDEO --test FT [--out result.json] [--keypoints kp.npz]
    python -m ncbio analyse KP.npz --test FT --report report.html [--ncid NC-…]
    python -m ncbio demo-report report.html       # the report on a synthetic take (no patient)
    python -m ncbio analyse VIDEO --test FT --overlay check.mp4   # points drawn on the video, R / L

The result holds biomarker values only: no names, no frames, no landmark streams.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

from .config import analysis_config
from .demo import demo_take
from .keypoints import TEST_KINDS, Keypoints, keypoints_from_video, model_path
from .overlay import write_overlay
from .report import render
from .run import analyse_keypoints


def download_models() -> None:
    for kind, m in analysis_config()["models"].items():
        dest = model_path(kind)
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not m["url"].startswith("https://"):
                raise SystemExit(f"refusing a non-https model URL for {kind}")
            urllib.request.urlretrieve(m["url"], dest)  # noqa: S310 (https only, checked above)
        digest = hashlib.sha256(dest.read_bytes()).hexdigest()
        print(f"{kind:5} {dest.name}  sha256 {digest}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ncbio", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("models", help="download the keypoint models")
    a = sub.add_parser("analyse", help="biomarkers of one take")
    a.add_argument("input", type=Path, help="video (.mp4) or saved keypoints (.npz)")
    a.add_argument("--test", required=True, choices=sorted(TEST_KINDS))
    a.add_argument("--out", type=Path)
    a.add_argument("--keypoints", type=Path, help="also save the keypoints here (.npz)")
    a.add_argument("--report", type=Path, help="also write the report with the working (.html, FT only)")
    a.add_argument("--ncid", help="patient code to print on the report (never a name or MRN)")
    a.add_argument("--recorded", help="when the take was recorded, as printed on the report")
    a.add_argument(
        "--overlay", type=Path, help="also write a copy of the video with the points and R / L drawn (.mp4)"
    )
    d = sub.add_parser("demo-report", help="the report on a synthetic take, to see how it looks")
    d.add_argument("out", type=Path)
    args = ap.parse_args(argv)
    if args.cmd == "models":
        download_models()
        return 0
    details: dict = {}
    if args.cmd == "demo-report":
        result = analyse_keypoints(demo_take(), "FT", details=details)
        args.out.write_text(render(result, details, ncid="NC-DEMO-0000", demo=True), encoding="utf-8")
        print(args.out)
        return 0
    if not args.input.is_file():
        raise SystemExit(f"No file at {args.input.resolve()}. Check the name, or give the full path.")
    if args.input.suffix != ".npz":
        missing = [str(model_path(k)) for k in sorted(TEST_KINDS[args.test]) if not model_path(k).is_file()]
        if missing:
            raise SystemExit(
                "The keypoint models are not downloaded yet. Run: python -m ncbio models\n"
                + "Missing: "
                + ", ".join(missing)
            )
    if args.input.suffix == ".npz":
        if args.overlay:
            raise SystemExit("--overlay needs the video, not saved keypoints")
        result = analyse_keypoints(Keypoints.load(args.input), args.test, details=details)
    else:
        kp = keypoints_from_video(args.input, args.test)
        if args.keypoints:
            kp.save(args.keypoints)
        result = analyse_keypoints(kp, args.test, details=details)
        if args.overlay:
            n = write_overlay(args.input, kp, args.overlay)
            print(f"{args.overlay} ({n} frames)")
    if args.report:
        if args.test != "FT":
            raise SystemExit("the report is built for FT so far")
        args.report.write_text(
            render(result, details, ncid=args.ncid, recorded=args.recorded), encoding="utf-8"
        )
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
