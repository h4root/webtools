from __future__ import annotations

import socket
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from certcheck.checks import Result, classify, days_left, issuer_name, parse_not_after

DEFAULT_PORT = 443
DEFAULT_TIMEOUT = 5.0


@dataclass(frozen=True)
class Target:
    host: str
    port: int = DEFAULT_PORT

    def __str__(self) -> str:
        return self.host if self.port == DEFAULT_PORT else f"{self.host}:{self.port}"


def parse_target(raw: str, default_port: int = DEFAULT_PORT) -> Target:
    text = raw.strip()
    if "://" in text:
        text = text.split("://", 1)[1]
    text = text.split("/", 1)[0]
    try:
        parts = urlsplit(f"//{text}")
        host, port = parts.hostname, parts.port
    except ValueError as error:
        raise ValueError(f"не удалось разобрать адрес {raw!r}: {error}") from error
    if not host:
        raise ValueError(f"не удалось разобрать адрес {raw!r}")
    return Target(host, port or default_port)


def read_targets(text: str, default_port: int = DEFAULT_PORT) -> list[Target]:
    lines = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [parse_target(line, default_port) for line in lines if line]


def fetch_certificate(target: Target, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
    context = ssl.create_default_context()
    with socket.create_connection((target.host, target.port), timeout=timeout) as sock:
        with context.wrap_socket(sock, server_hostname=target.host) as tls:
            return tls.getpeercert()


def check_target(
    target: Target,
    warn_days: int,
    timeout: float = DEFAULT_TIMEOUT,
    now: datetime | None = None,
) -> Result:
    try:
        cert = fetch_certificate(target, timeout)
    except ssl.SSLCertVerificationError as error:
        return Result(str(target), "invalid", detail=getattr(error, "verify_message", None) or str(error))
    except ssl.SSLError as error:
        return Result(str(target), "invalid", detail=str(error))
    except OSError as error:
        return Result(str(target), "unreachable", detail=str(error))

    try:
        not_after = parse_not_after(cert)
    except ValueError as error:
        return Result(str(target), "invalid", detail=str(error))

    days = days_left(not_after, now or datetime.now(timezone.utc))
    return Result(
        str(target),
        classify(days, warn_days),
        days_left=days,
        not_after=not_after,
        issuer=issuer_name(cert),
    )
