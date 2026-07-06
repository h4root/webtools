from __future__ import annotations

import math
import re

MIN_TOKEN_LENGTH = 20
MIN_UNIQUE_CHARS = 8
BASE64_ENTROPY_THRESHOLD = 4.5
HEX_ENTROPY_THRESHOLD = 3.0

_TOKEN_RE = re.compile(r"[A-Za-z0-9+/=_\-]{20,}")
_HEX_RE = re.compile(r"\A[0-9a-fA-F]+\Z")


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    counts: dict[str, int] = {}
    for char in value:
        counts[char] = counts.get(char, 0) + 1
    length = len(value)
    return -sum((n / length) * math.log2(n / length) for n in counts.values())


def _looks_like_word(token: str) -> bool:
    vowels = sum(token.lower().count(v) for v in "aeiou")
    return vowels / len(token) > 0.3


def find_high_entropy_tokens(line: str) -> list[str]:
    tokens: list[str] = []
    for match in _TOKEN_RE.finditer(line):
        token = match.group(0)
        if len(token) < MIN_TOKEN_LENGTH or len(set(token)) < MIN_UNIQUE_CHARS:
            continue
        entropy = shannon_entropy(token)
        if _HEX_RE.match(token):
            if entropy >= HEX_ENTROPY_THRESHOLD:
                tokens.append(token)
        elif entropy >= BASE64_ENTROPY_THRESHOLD and not _looks_like_word(token):
            tokens.append(token)
    return tokens
