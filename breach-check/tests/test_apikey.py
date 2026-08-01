from pathlib import Path

import pytest

from breach_check import apikey
from breach_check.apikey import API_KEY_ENV, MissingApiKey, parse_key_file, resolve_api_key


class FakeStdin:
    def __init__(self, interactive: bool):
        self.interactive = interactive

    def isatty(self) -> bool:
        return self.interactive


@pytest.fixture(autouse=True)
def no_ambient_key(monkeypatch):
    monkeypatch.delenv(API_KEY_ENV, raising=False)
    monkeypatch.setattr(apikey.sys, "stdin", FakeStdin(interactive=False))


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("secret-key\n", "secret-key"),
        (f"{API_KEY_ENV}=secret-key\n", "secret-key"),
        (f'{API_KEY_ENV}="secret-key"\n', "secret-key"),
        (f"# ключ\n\n  {API_KEY_ENV} = secret-key  \n", "secret-key"),
        (f"OTHER=нет\n{API_KEY_ENV}=secret-key\n", "secret-key"),
    ],
)
def test_parse_key_file(text, expected):
    assert parse_key_file(text) == expected


@pytest.mark.parametrize("text", ["", "# только комментарий\n", "OTHER=нет\n", f"{API_KEY_ENV}=\n"])
def test_parse_key_file_without_key_raises(text):
    with pytest.raises(MissingApiKey):
        parse_key_file(text)


def test_key_file_wins_over_environment(monkeypatch, tmp_path: Path):
    monkeypatch.setenv(API_KEY_ENV, "from-env")
    key_file = tmp_path / "hibp.key"
    key_file.write_text("from-file\n", encoding="utf-8")
    assert resolve_api_key(key_file) == "from-file"


def test_environment_is_used_without_key_file(monkeypatch):
    monkeypatch.setenv(API_KEY_ENV, "  from-env  ")
    assert resolve_api_key() == "from-env"


def test_prompt_is_used_when_terminal_is_interactive(monkeypatch):
    monkeypatch.setattr(apikey.sys, "stdin", FakeStdin(interactive=True))
    monkeypatch.setattr(apikey, "getpass", lambda prompt: "  typed-key  ")
    assert resolve_api_key() == "typed-key"


def test_empty_prompt_raises(monkeypatch):
    monkeypatch.setattr(apikey.sys, "stdin", FakeStdin(interactive=True))
    monkeypatch.setattr(apikey, "getpass", lambda prompt: "")
    with pytest.raises(MissingApiKey):
        resolve_api_key()


def test_no_prompt_without_terminal():
    with pytest.raises(MissingApiKey):
        resolve_api_key()


def test_missing_key_file_raises_oserror(tmp_path: Path):
    with pytest.raises(OSError):
        resolve_api_key(tmp_path / "нет.key")
