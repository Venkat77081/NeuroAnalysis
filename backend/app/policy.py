"""Account and invite policy (config/platform.json) and server message text
(config/messages/<lang>.json). Values are never hard-coded in the API."""

import json
from functools import lru_cache
from pathlib import Path

from app.config import get_settings


@lru_cache
def policy() -> dict:
    return json.loads((Path(get_settings().config_dir) / "platform.json").read_text())


@lru_cache
def messages(lang: str = "en") -> dict:
    return json.loads((Path(get_settings().config_dir) / "messages" / f"{lang}.json").read_text())


def message(key: str, field: str, lang: str = "en", **values: object) -> str:
    return messages(lang)[key][field].format(**values)
