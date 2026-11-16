"""contracts/connector-api.yaml is generated from both apps (scripts/gen_contract.py) and must be current."""

from pathlib import Path

import yaml

from scripts.gen_contract import build

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "connector-api.yaml"


def test_contract_is_current():
    assert yaml.safe_load(CONTRACT.read_text()) == build(), "run: python -m scripts.gen_contract"
