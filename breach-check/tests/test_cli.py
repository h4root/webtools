import io
import json
from pathlib import Path

import pytest

from breach_check import accounts, cli, passwords
from breach_check.accounts import API_KEY_ENV
from breach_check.cli import main
from breach_check.hibp import Response

BREACH_BODY = json.dumps([{"Name": "Adobe", "BreachDate": "2013-10-04"}])
PASSWORD_SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8"


@pytest.fixture
def api_key(monkeypatch):
    monkeypatch.setenv(API_KEY_ENV, "test-key")


@pytest.fixture
def hibp(monkeypatch):
    by_account: dict[str, object] = {}

    def get(url, headers=None, timeout=None):
        for account, result in by_account.items():
            if account.replace("@", "%40") in url:
                if isinstance(result, Exception):
                    raise result
                return result
        return Response(404, "")

    monkeypatch.setattr(accounts, "http_get", get)
    return by_account


@pytest.fixture
def pwned(monkeypatch):
    body = {"text": ""}
    monkeypatch.setattr(passwords, "fetch_range", lambda prefix, timeout=None: body["text"])
    return body


def test_clean_email_exits_zero(api_key, hibp, capsys):
    assert main(["email", "user@example.com", "--delay", "0"]) == 0
    assert "чисто" in capsys.readouterr().out


def test_breached_email_exits_one(api_key, hibp, capsys):
    hibp["user@example.com"] = Response(200, BREACH_BODY)
    assert main(["email", "user@example.com", "--delay", "0"]) == 1
    out = capsys.readouterr().out
    assert "1 утечка" in out and "Adobe (2013-10-04)" in out


def test_missing_api_key_exits_two(monkeypatch, capsys):
    monkeypatch.delenv(API_KEY_ENV, raising=False)
    assert main(["email", "user@example.com"]) == 2
    assert API_KEY_ENV in capsys.readouterr().err


def test_bad_email_exits_two(api_key):
    assert main(["email", "not-an-email", "--delay", "0"]) == 2


def test_no_targets_exits_two(api_key):
    assert main(["email", "--delay", "0"]) == 2


def test_email_file_is_checked(api_key, hibp, tmp_path: Path, capsys):
    hibp["b@example.com"] = Response(200, BREACH_BODY)
    listing = tmp_path / "emails.txt"
    listing.write_text("# люди\na@example.com\nb@example.com\n", encoding="utf-8")
    assert main(["email", "--file", str(listing), "--delay", "0"]) == 1
    out = capsys.readouterr().out
    assert "a@example.com" in out and "b@example.com" in out


def test_missing_email_file_exits_two(api_key, tmp_path: Path):
    assert main(["email", "--file", str(tmp_path / "nope.txt"), "--delay", "0"]) == 2


def test_email_network_error_exits_one(api_key, hibp, capsys):
    hibp["user@example.com"] = OSError("connection reset")
    assert main(["email", "user@example.com", "--delay", "0"]) == 1
    assert "ошибка" in capsys.readouterr().out


def test_email_json_output_is_parseable(api_key, hibp, capsys):
    hibp["user@example.com"] = Response(200, BREACH_BODY)
    main(["email", "user@example.com", "--delay", "0", "--format", "json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["account"] == "user@example.com"
    assert payload[0]["breaches"][0]["name"] == "Adobe"
    assert payload[0]["error"] is None


def test_pwned_password_from_stdin_exits_one(pwned, monkeypatch, capsys):
    pwned["text"] = f"{PASSWORD_SUFFIX}:9659365\n"
    monkeypatch.setattr("sys.stdin", io.StringIO("password\n"))
    assert main(["password", "--stdin"]) == 1
    assert "совпадений: 9659365" in capsys.readouterr().out


def test_unknown_password_exits_zero(pwned, monkeypatch, capsys):
    pwned["text"] = "0000000000000000000000000000000000A:7\n"
    monkeypatch.setattr("sys.stdin", io.StringIO("password\n"))
    assert main(["password", "--stdin"]) == 0
    assert "не найден" in capsys.readouterr().out


def test_password_is_never_printed(pwned, monkeypatch, capsys):
    pwned["text"] = f"{PASSWORD_SUFFIX}:9659365\n"
    monkeypatch.setattr("sys.stdin", io.StringIO("password\n"))
    main(["password", "--stdin", "--format", "json"])
    captured = capsys.readouterr()
    assert "password" not in captured.out + captured.err


def test_prompted_password_is_checked(pwned, monkeypatch, capsys):
    pwned["text"] = f"{PASSWORD_SUFFIX}:9659365\n"
    monkeypatch.setattr(cli, "getpass", lambda prompt: "password")
    assert main(["password"]) == 1


def test_empty_password_exits_two(monkeypatch):
    monkeypatch.setattr(cli, "getpass", lambda prompt: "")
    assert main(["password"]) == 2


def test_password_json_output_is_parseable(pwned, monkeypatch, capsys):
    pwned["text"] = f"{PASSWORD_SUFFIX}:9659365\n"
    monkeypatch.setattr("sys.stdin", io.StringIO("password\nsecond\n"))
    main(["password", "--stdin", "--format", "json"])
    payload = json.loads(capsys.readouterr().out)
    assert [item["label"] for item in payload] == ["строка 1", "строка 2"]
    assert payload[0]["count"] == 9659365
