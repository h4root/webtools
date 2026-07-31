import json
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from certcheck import probe
from certcheck.cli import main


def cert_expiring_in(days: int) -> dict:
    not_after = datetime.now(timezone.utc) + timedelta(days=days, hours=1)
    return {
        "notAfter": not_after.strftime("%b %d %H:%M:%S %Y GMT"),
        "issuer": ((("commonName", "R11"),),),
    }


@pytest.fixture
def certs(monkeypatch):
    by_host: dict[str, object] = {}

    def fetch(target, timeout):
        result = by_host[target.host]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(probe, "fetch_certificate", fetch)
    return by_host


def test_fresh_certificate_exits_zero(certs, capsys):
    certs["example.com"] = cert_expiring_in(200)
    assert main(["example.com"]) == 0
    assert "ok" in capsys.readouterr().out


def test_expiring_certificate_exits_one(certs):
    certs["example.com"] = cert_expiring_in(10)
    assert main(["example.com"]) == 1


def test_days_threshold_is_configurable(certs):
    certs["example.com"] = cert_expiring_in(45)
    assert main(["example.com"]) == 0
    assert main(["example.com", "--days", "60"]) == 1


def test_unreachable_host_exits_one(certs, capsys):
    certs["nope.invalid"] = socket.gaierror("Name or service not known")
    assert main(["nope.invalid"]) == 1
    assert "недоступен" in capsys.readouterr().out


def test_file_list_is_checked(certs, tmp_path: Path, capsys):
    certs["a.example"] = cert_expiring_in(200)
    certs["b.example"] = cert_expiring_in(200)
    listing = tmp_path / "domains.txt"
    listing.write_text("# прод\na.example\nb.example:8443\n", encoding="utf-8")
    assert main(["--file", str(listing)]) == 0
    out = capsys.readouterr().out
    assert "a.example" in out and "b.example:8443" in out


def test_missing_file_exits_two(tmp_path: Path):
    assert main(["--file", str(tmp_path / "nope.txt")]) == 2


def test_no_arguments_exits_two():
    assert main([]) == 2


def test_bad_domain_exits_two():
    assert main(["example.com:99999"]) == 2


def test_json_output_is_parseable(certs, capsys):
    certs["example.com"] = cert_expiring_in(200)
    main(["example.com", "--format", "json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["target"] == "example.com"
    assert payload[0]["status"] == "ok"
    assert payload[0]["issuer"] == "R11"
