from datetime import datetime, timezone

import pytest

from certcheck.checks import classify, days_left, issuer_name, parse_not_after

CERT = {
    "notAfter": "Oct 26 12:00:00 2026 GMT",
    "issuer": ((("countryName", "US"),), (("organizationName", "Let's Encrypt"),), (("commonName", "R11"),)),
}


def test_parse_not_after_is_utc():
    assert parse_not_after(CERT) == datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)


def test_parse_not_after_without_field():
    with pytest.raises(ValueError):
        parse_not_after({})


def test_issuer_prefers_common_name():
    assert issuer_name(CERT) == "R11"


def test_issuer_falls_back_to_organization():
    cert = {"issuer": ((("organizationName", "Internal CA"),),)}
    assert issuer_name(cert) == "Internal CA"


def test_issuer_missing():
    assert issuer_name({}) is None


def test_days_left_rounds_down():
    now = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc)
    assert days_left(parse_not_after(CERT), now) == 1


def test_days_left_negative_when_expired():
    now = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)
    assert days_left(parse_not_after(CERT), now) == -2


@pytest.mark.parametrize(
    ("days", "expected"),
    [(-1, "expired"), (0, "expiring"), (30, "expiring"), (31, "ok")],
)
def test_classify(days, expected):
    assert classify(days, warn_days=30) == expected
