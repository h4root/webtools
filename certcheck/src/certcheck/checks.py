from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

NOT_AFTER_FORMAT = "%b %d %H:%M:%S %Y %Z"
FAILING_STATUSES = frozenset({"expiring", "expired", "invalid", "unreachable"})
STATUS_LABEL = {
    "ok": "ok",
    "expiring": "истекает",
    "expired": "истёк",
    "invalid": "невалиден",
    "unreachable": "недоступен",
}


@dataclass(frozen=True)
class Result:
    target: str
    status: str
    days_left: int | None = None
    not_after: datetime | None = None
    issuer: str | None = None
    detail: str | None = None


def parse_not_after(cert: dict[str, Any]) -> datetime:
    raw = cert.get("notAfter")
    if not raw:
        raise ValueError("сертификат без поля notAfter")
    return datetime.strptime(raw, NOT_AFTER_FORMAT).replace(tzinfo=timezone.utc)


def _rdn_field(rdns: Any, name: str) -> str | None:
    for rdn in rdns or ():
        for key, value in rdn:
            if key == name:
                return value
    return None


def issuer_name(cert: dict[str, Any]) -> str | None:
    issuer = cert.get("issuer")
    return _rdn_field(issuer, "commonName") or _rdn_field(issuer, "organizationName")


def days_left(not_after: datetime, now: datetime) -> int:
    return (not_after - now).days


def classify(days: int, warn_days: int) -> str:
    if days < 0:
        return "expired"
    if days <= warn_days:
        return "expiring"
    return "ok"
