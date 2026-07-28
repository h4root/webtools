from __future__ import annotations

import re
from dataclasses import dataclass, field

KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
EXPORT_PREFIX = "export "


@dataclass(frozen=True)
class Entry:
    key: str
    value: str
    line: int


@dataclass
class ParsedFile:
    entries: list[Entry] = field(default_factory=list)
    malformed_lines: list[int] = field(default_factory=list)

    def first_by_key(self) -> dict[str, Entry]:
        first: dict[str, Entry] = {}
        for entry in self.entries:
            first.setdefault(entry.key, entry)
        return first

    def duplicates(self) -> list[Entry]:
        seen: set[str] = set()
        repeated: list[Entry] = []
        for entry in self.entries:
            if entry.key in seen:
                repeated.append(entry)
            seen.add(entry.key)
        return repeated


def _read_value(rest: str, lines: list[str], next_index: int) -> tuple[str, int]:
    """Вернуть значение и число дополнительно поглощённых строк (многострочные кавычки)."""
    rest = rest.strip()
    quote = rest[:1]
    if quote not in ("'", '"'):
        value, _, _ = rest.partition(" #")
        return value.rstrip(), 0

    body = rest[1:]
    closing = body.find(quote)
    if closing != -1:
        return body[:closing], 0

    collected = [body]
    consumed = 0
    while next_index + consumed < len(lines):
        line = lines[next_index + consumed]
        consumed += 1
        closing = line.find(quote)
        if closing != -1:
            collected.append(line[:closing])
            break
        collected.append(line)
    return "\n".join(collected), consumed


def parse(text: str) -> ParsedFile:
    parsed = ParsedFile()
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        raw = lines[index]
        line_no = index + 1
        index += 1

        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith(EXPORT_PREFIX):
            stripped = stripped[len(EXPORT_PREFIX) :].lstrip()

        key, separator, rest = stripped.partition("=")
        key = key.strip()
        if not separator or not KEY_PATTERN.fullmatch(key):
            parsed.malformed_lines.append(line_no)
            continue

        value, consumed = _read_value(rest, lines, index)
        index += consumed
        parsed.entries.append(Entry(key, value, line_no))
    return parsed
