import socket
import ssl
from datetime import datetime, timezone

import pytest

from certcheck import probe
from certcheck.probe import Target, check_target, parse_target, read_targets

NOW = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
CERT = {
    "notAfter": "Oct 26 12:00:00 2026 GMT",
    "issuer": ((("commonName", "R11"),),),
}


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("example.com", Target("example.com", 443)),
        ("example.com:8443", Target("example.com", 8443)),
        ("https://example.com/path?q=1", Target("example.com", 443)),
        ("  EXAMPLE.com  ", Target("example.com", 443)),
        ("[::1]:8443", Target("::1", 8443)),
    ],
)
def test_parse_target(raw, expected):
    assert parse_target(raw) == expected


def test_parse_target_uses_default_port():
    assert parse_target("example.com", default_port=8443).port == 8443


@pytest.mark.parametrize("raw", ["", "https://", "example.com:99999"])
def test_parse_target_rejects_garbage(raw):
    with pytest.raises(ValueError):
        parse_target(raw)


def test_read_targets_skips_comments_and_blanks():
    text = "# список\nexample.com\n\n  internal:8443  # прод\n"
    assert read_targets(text) == [Target("example.com", 443), Target("internal", 8443)]


def test_target_str_hides_default_port():
    assert str(Target("example.com", 443)) == "example.com"
    assert str(Target("example.com", 8443)) == "example.com:8443"


def _stub_fetch(monkeypatch, result):
    def fetch(target, timeout):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(probe, "fetch_certificate", fetch)


def test_valid_certificate(monkeypatch):
    _stub_fetch(monkeypatch, CERT)
    result = check_target(Target("example.com"), warn_days=30, now=NOW)
    assert (result.status, result.days_left, result.issuer) == ("ok", 87, "R11")


def test_expiring_certificate(monkeypatch):
    _stub_fetch(monkeypatch, CERT)
    result = check_target(Target("example.com"), warn_days=90, now=NOW)
    assert result.status == "expiring"


def test_verification_failure_is_invalid(monkeypatch):
    _stub_fetch(monkeypatch, ssl.SSLCertVerificationError(1, "certificate has expired"))
    result = check_target(Target("example.com"), warn_days=30, now=NOW)
    assert result.status == "invalid"
    assert "expired" in result.detail


def test_connection_failure_is_unreachable(monkeypatch):
    _stub_fetch(monkeypatch, socket.gaierror("Name or service not known"))
    result = check_target(Target("nope.invalid"), warn_days=30, now=NOW)
    assert result.status == "unreachable"


def test_timeout_is_unreachable(monkeypatch):
    _stub_fetch(monkeypatch, TimeoutError("timed out"))
    result = check_target(Target("example.com"), warn_days=30, now=NOW)
    assert result.status == "unreachable"


def test_certificate_without_dates_is_invalid(monkeypatch):
    _stub_fetch(monkeypatch, {})
    result = check_target(Target("example.com"), warn_days=30, now=NOW)
    assert result.status == "invalid"
