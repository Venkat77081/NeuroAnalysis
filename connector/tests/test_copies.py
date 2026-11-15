"""Files the connector image carries as copies must stay identical to their sources."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parents[1] / "ncconnector"


def _after_docstring(p: Path) -> str:
    s = p.read_text()
    return s[s.index('"""', 3) + 3 :]


def test_takecrypto_matches_backend():
    assert _after_docstring(HERE / "takecrypto.py") == _after_docstring(
        ROOT / "backend/analysis/takecrypto.py"
    )


def test_messages_match_config():
    assert (HERE / "messages/en.json").read_text() == (ROOT / "config/messages/en.json").read_text()


def test_signing_matches_backend():
    """Same canonical form and checks on both sides (functions after the module docstring)."""
    import inspect

    from app import signing as platform_side

    from ncconnector import signing as connector_side

    for name in ("b64u", "unb64u", "canonical", "sign_headers", "verify_signed"):
        assert inspect.getsource(getattr(platform_side, name)) == inspect.getsource(
            getattr(connector_side, name)
        )
