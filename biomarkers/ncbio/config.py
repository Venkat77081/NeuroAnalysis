"""Analysis config (config/analysis.json) and the biomarker registry, read from the repo config dir."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

_REPO_CONFIG = Path(__file__).resolve().parents[2] / "config"


def config_dir() -> Path:
    return Path(os.environ.get("NCBIO_CONFIG_DIR", _REPO_CONFIG))


@lru_cache
def analysis_config() -> dict:
    return json.loads((config_dir() / "analysis.json").read_text())


@lru_cache
def registry() -> dict:
    return json.loads((config_dir() / "biomarker-registry.json").read_text())


def registry_ids(test_code: str) -> list[str]:
    """The registry's biomarker IDs for one test, in registry order."""
    return [b["id"] for b in registry()["biomarkers"] if b["testCode"] == test_code]
