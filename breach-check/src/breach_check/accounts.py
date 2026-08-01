from __future__ import annotations

import json
import time
from dataclasses import dataclass
from urllib.parse import quote

from breach_check.hibp import DEFAULT_TIMEOUT, HibpError, http_get

ACCOUNT_URL = "https://haveibeenpwned.com/api/v3/breachedaccount/"
API_KEY_ENV = "HIBP_API_KEY"
DEFAULT_DELAY = 1.6
MAX_RETRY_WAIT = 60.0


@dataclass(frozen=True)
class Breach:
    name: str
    date: str | None = None
    data_classes: tuple[str, ...] = ()


@dataclass(frozen=True)
class AccountResult:
    account: str
    breaches: tuple[Breach, ...] = ()
    error: str | None = None


def validate_account(raw: str) -> str:
    account = raw.strip()
    local, _, domain = account.partition("@")
    if not local or not domain:
        raise ValueError(f"не похоже на email: {raw!r}")
    return account


def read_accounts(text: str) -> list[str]:
    lines = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [validate_account(line) for line in lines if line]


def parse_breaches(body: str) -> tuple[Breach, ...]:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise HibpError(f"HIBP вернул не JSON: {error}") from error
    return tuple(
        Breach(
            item.get("Name") or item.get("Title") or "?",
            item.get("BreachDate"),
            tuple(item.get("DataClasses") or ()),
        )
        for item in payload
    )


def check_account(
    account: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
) -> AccountResult:
    url = f"{ACCOUNT_URL}{quote(account, safe='')}?truncateResponse=false"
    headers = {"hibp-api-key": api_key}
    try:
        response = http_get(url, headers, timeout)
        if response.status == 429:
            time.sleep(min(response.retry_after or DEFAULT_DELAY, MAX_RETRY_WAIT))
            response = http_get(url, headers, timeout)
    except OSError as error:
        return AccountResult(account, error=str(error))

    if response.status == 404:
        return AccountResult(account)
    if response.status == 200:
        return AccountResult(account, parse_breaches(response.body))
    if response.status in (401, 403):
        raise HibpError(
            f"HIBP отклонил запрос (HTTP {response.status}): проверьте {API_KEY_ENV}"
        )
    return AccountResult(account, error=f"HTTP {response.status}")
