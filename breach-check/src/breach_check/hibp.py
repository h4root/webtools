from __future__ import annotations

from dataclasses import dataclass
from email.message import Message
from urllib.error import HTTPError
from urllib.request import Request, urlopen

USER_AGENT = "breach-check/0.1.0 (+https://github.com/h4root/webtools)"
DEFAULT_TIMEOUT = 10.0


class HibpError(RuntimeError):
    pass


@dataclass(frozen=True)
class Response:
    status: int
    body: str
    retry_after: float | None = None


def _retry_after(headers: Message) -> float | None:
    raw = headers.get("Retry-After")
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def http_get(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Response:
    request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            return Response(response.status, body, _retry_after(response.headers))
    except HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        return Response(error.code, body, _retry_after(error.headers))
