import json
import socket

import pytest

from breach_check import accounts
from breach_check.accounts import (
    check_account,
    parse_breaches,
    read_accounts,
    validate_account,
)
from breach_check.hibp import HibpError, Response

BREACH_BODY = json.dumps(
    [
        {
            "Name": "Adobe",
            "BreachDate": "2013-10-04",
            "DataClasses": ["Email addresses", "Passwords"],
        },
        {"Name": "LinkedIn", "BreachDate": "2012-05-05", "DataClasses": []},
    ]
)


def test_validate_account_trims():
    assert validate_account("  user@example.com  ") == "user@example.com"


@pytest.mark.parametrize("raw", ["", "user", "@example.com", "user@"])
def test_validate_account_rejects_non_email(raw):
    with pytest.raises(ValueError):
        validate_account(raw)


def test_read_accounts_skips_comments_and_blanks():
    text = "# список\nuser@example.com\n\n  admin@example.com  # прод\n"
    assert read_accounts(text) == ["user@example.com", "admin@example.com"]


def test_parse_breaches_extracts_fields():
    breaches = parse_breaches(BREACH_BODY)
    assert [b.name for b in breaches] == ["Adobe", "LinkedIn"]
    assert breaches[0].date == "2013-10-04"
    assert breaches[0].data_classes == ("Email addresses", "Passwords")


def test_parse_breaches_rejects_garbage():
    with pytest.raises(HibpError):
        parse_breaches("<html>502</html>")


def _stub_responses(monkeypatch, *responses):
    calls: list[str] = []
    queue = list(responses)

    def get(url, headers=None, timeout=None):
        calls.append(url)
        result = queue.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(accounts, "http_get", get)
    monkeypatch.setattr(accounts.time, "sleep", lambda seconds: None)
    return calls


def test_breached_account_lists_breaches(monkeypatch):
    calls = _stub_responses(monkeypatch, Response(200, BREACH_BODY))
    result = check_account("user@example.com", "key")
    assert [b.name for b in result.breaches] == ["Adobe", "LinkedIn"]
    assert result.error is None
    assert "user%40example.com" in calls[0]


def test_clean_account_has_no_breaches(monkeypatch):
    _stub_responses(monkeypatch, Response(404, ""))
    result = check_account("user@example.com", "key")
    assert result.breaches == ()
    assert result.error is None


def test_rate_limit_is_retried_once(monkeypatch):
    calls = _stub_responses(
        monkeypatch, Response(429, "", retry_after=2.0), Response(404, "")
    )
    assert check_account("user@example.com", "key").error is None
    assert len(calls) == 2


def test_repeated_rate_limit_becomes_error(monkeypatch):
    _stub_responses(monkeypatch, Response(429, ""), Response(429, ""))
    assert check_account("user@example.com", "key").error == "HTTP 429"


@pytest.mark.parametrize("status", [401, 403])
def test_bad_api_key_raises(monkeypatch, status):
    _stub_responses(monkeypatch, Response(status, ""))
    with pytest.raises(HibpError):
        check_account("user@example.com", "key")


def test_server_error_becomes_error_field(monkeypatch):
    _stub_responses(monkeypatch, Response(503, ""))
    assert check_account("user@example.com", "key").error == "HTTP 503"


def test_network_failure_becomes_error_field(monkeypatch):
    _stub_responses(monkeypatch, socket.gaierror("Name or service not known"))
    result = check_account("user@example.com", "key")
    assert result.breaches == ()
    assert "Name or service not known" in result.error
