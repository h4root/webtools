import pytest

from breach_check import passwords
from breach_check.hibp import HibpError, Response
from breach_check.passwords import (
    check_password,
    fetch_range,
    parse_range,
    sha1_hex,
    split_hash,
)

PASSWORD_HASH = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"


def test_sha1_hex_is_uppercase_hex():
    assert sha1_hex("password") == PASSWORD_HASH


def test_sha1_hex_handles_non_ascii():
    assert len(sha1_hex("пароль")) == 40


def test_split_hash_sends_only_five_characters():
    prefix, suffix = split_hash(PASSWORD_HASH)
    assert prefix == "5BAA6"
    assert len(suffix) == 35
    assert prefix + suffix == PASSWORD_HASH


def test_parse_range_reads_counts():
    body = "1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365\r\nAAAAA:12\r\n"
    counts = parse_range(body)
    assert counts["1E4C9B93F3F0682250B6CF8331B7EE68FD8"] == 9659365
    assert counts["AAAAA"] == 12


def test_parse_range_drops_padding_entries():
    assert parse_range("ABC:0\nDEF:3\n") == {"DEF": 3}


def test_parse_range_ignores_malformed_lines():
    assert parse_range("\nне-строка\nDEF:3\nGHI:\n") == {"DEF": 3}


def test_parse_range_lowercase_suffix_is_normalised():
    assert parse_range("abc:5") == {"ABC": 5}


def _stub_range(monkeypatch, body: str) -> list[str]:
    requested: list[str] = []

    def fetch(prefix, timeout=None):
        requested.append(prefix)
        return body

    monkeypatch.setattr(passwords, "fetch_range", fetch)
    return requested


def test_check_password_reports_count(monkeypatch):
    requested = _stub_range(monkeypatch, f"{PASSWORD_HASH[5:]}:9659365\n")
    result = check_password("password", "пароль")
    assert (result.label, result.count) == ("пароль", 9659365)
    assert requested == ["5BAA6"]


def test_check_password_not_found(monkeypatch):
    _stub_range(monkeypatch, "0000000000000000000000000000000000A:7\n")
    assert check_password("password", "пароль").count == 0


def test_fetch_range_requests_padding(monkeypatch):
    seen: dict[str, object] = {}

    def get(url, headers=None, timeout=None):
        seen["url"] = url
        seen["headers"] = headers
        return Response(200, "ABC:1")

    monkeypatch.setattr(passwords, "http_get", get)
    assert fetch_range("5BAA6") == "ABC:1"
    assert seen["url"].endswith("/range/5BAA6")
    assert seen["headers"]["Add-Padding"] == "true"


def test_fetch_range_raises_on_error_status(monkeypatch):
    monkeypatch.setattr(
        passwords, "http_get", lambda url, headers=None, timeout=None: Response(503, "")
    )
    with pytest.raises(HibpError):
        fetch_range("5BAA6")
