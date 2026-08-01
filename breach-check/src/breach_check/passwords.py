from __future__ import annotations

import hashlib
from dataclasses import dataclass

from breach_check.hibp import DEFAULT_TIMEOUT, HibpError, http_get

RANGE_URL = "https://api.pwnedpasswords.com/range/"
PREFIX_LENGTH = 5


@dataclass(frozen=True)
class PasswordResult:
    label: str
    count: int


def sha1_hex(password: str) -> str:
    return hashlib.sha1(password.encode("utf-8")).hexdigest().upper()


def split_hash(digest: str) -> tuple[str, str]:
    return digest[:PREFIX_LENGTH], digest[PREFIX_LENGTH:]


def parse_range(body: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for line in body.splitlines():
        suffix, _, raw_count = line.strip().partition(":")
        try:
            count = int(raw_count.replace(",", ""))
        except ValueError:
            continue
        if count > 0:  # ответы с Add-Padding содержат фиктивные хеши с count == 0
            counts[suffix.upper()] = count
    return counts


def fetch_range(prefix: str, timeout: float = DEFAULT_TIMEOUT) -> str:
    response = http_get(RANGE_URL + prefix, {"Add-Padding": "true"}, timeout)
    if response.status != 200:
        raise HibpError(f"Pwned Passwords вернул HTTP {response.status}")
    return response.body


def check_password(
    password: str,
    label: str,
    timeout: float = DEFAULT_TIMEOUT,
) -> PasswordResult:
    prefix, suffix = split_hash(sha1_hex(password))
    counts = parse_range(fetch_range(prefix, timeout))
    return PasswordResult(label, counts.get(suffix, 0))
