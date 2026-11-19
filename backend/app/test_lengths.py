"""v31 (decision 054): how long each test's take records.

config/tests/<code>.json gives the default length (`task.durationS`) and the lengths that may be
chosen instead (`task.durationOptionsS`, never below the biomarker registry's minimum). A hospital
admin picks one per test (Settings, `test_durations`); a doctor may pick another per request. The
phone's native timer still stops each take at the chosen length.
"""

import json
from functools import lru_cache
from pathlib import Path

from app.config import get_settings


@lru_cache
def _tests() -> dict[str, dict]:
    d = Path(get_settings().config_dir) / "tests"
    out = {}
    for f in sorted(d.glob("*.json")):
        t = json.loads(f.read_text())
        out[t["code"]] = t["task"]
    return out


def default_lengths() -> dict[str, float]:
    """The config's lengths, by test code."""
    return {code: float(t["durationS"]) for code, t in _tests().items()}


def length_options() -> dict[str, list[float]]:
    """The lengths that may be chosen, by test code: the default and longer ones only (never
    shorter than the default, even if the config lists one; user, 19 Nov 2026)."""
    out = {}
    for code, t in _tests().items():
        default = float(t["durationS"])
        opts = {float(x) for x in t.get("durationOptionsS") or [] if float(x) >= default}
        out[code] = sorted(opts | {default})
    return out


def offered(lengths: dict[str, float]) -> str | None:
    """The first test whose length is not one of its options (None when all are fine)."""
    opts = length_options()
    base = default_lengths()
    for code, s in lengths.items():
        if code not in opts or float(s) not in opts[code] or float(s) < base[code]:
            return code
    return None
