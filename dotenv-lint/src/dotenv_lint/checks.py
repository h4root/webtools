from __future__ import annotations

import re
from dataclasses import dataclass

from dotenv_lint.parser import Entry, ParsedFile

MIN_SECRET_LENGTH = 12
SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2}

SECRET_KEY_PATTERN = re.compile(
    r"(?i)(?:secret|token|password|passwd|pwd|credential|"
    r"api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key|signing[_-]?key)"
)
PLACEHOLDER_PATTERN = re.compile(
    r"(?i)<.+>|x{3,}|\.{3}|todo|tbd|change[_-]?me|replace[_-]?me|"
    r"your[_-].*|.*[_-]here|placeholder|.*[_-]placeholder"
)
WEAK_VALUES = frozenset(
    {
        "0000",
        "1234",
        "123456",
        "12345678",
        "123456789",
        "admin",
        "default",
        "example",
        "letmein",
        "pass",
        "passwd",
        "password",
        "qwerty",
        "root",
        "secret",
        "test",
    }
)


@dataclass(frozen=True)
class Finding:
    key: str
    line: int | None
    check: str
    severity: str
    detail: str


def _is_secret_key(key: str) -> bool:
    return SECRET_KEY_PATTERN.search(key) is not None


def _check_value(entry: Entry, example_entry: Entry | None) -> Finding | None:
    value = entry.value
    if not value:
        if example_entry is not None and example_entry.value:
            return Finding(
                entry.key,
                entry.line,
                "empty-value",
                "medium",
                f"{entry.key} пуст, хотя в примере значение задано",
            )
        return None

    if PLACEHOLDER_PATTERN.fullmatch(value):
        return Finding(
            entry.key,
            entry.line,
            "placeholder-value",
            "high",
            f'{entry.key} = "{value}" — плейсхолдер не заменён',
        )

    if not _is_secret_key(entry.key):
        return None

    if value.lower() in WEAK_VALUES:
        return Finding(
            entry.key,
            entry.line,
            "weak-value",
            "high",
            f'{entry.key} = "{value}" — значение по умолчанию',
        )

    if example_entry is not None and value == example_entry.value:
        return Finding(
            entry.key,
            entry.line,
            "unchanged-secret",
            "high",
            f"{entry.key} совпадает со значением из примера",
        )

    if len(value) < MIN_SECRET_LENGTH:
        return Finding(
            entry.key,
            entry.line,
            "short-secret",
            "medium",
            f"{entry.key}: {len(value)} символов, ожидается минимум {MIN_SECRET_LENGTH}",
        )
    return None


def lint(env: ParsedFile, example: ParsedFile) -> list[Finding]:
    env_entries = env.first_by_key()
    example_entries = example.first_by_key()
    findings: list[Finding] = []

    for line in env.malformed_lines:
        findings.append(
            Finding("", line, "malformed-line", "medium", "строка не в формате KEY=value")
        )

    for entry in env.duplicates():
        findings.append(
            Finding(
                entry.key,
                entry.line,
                "duplicate-key",
                "medium",
                f"{entry.key} объявлен выше — прежнее значение молча перезаписывается",
            )
        )

    for key in example_entries:
        if key not in env_entries:
            findings.append(
                Finding(key, None, "missing-key", "high", f"{key} есть в примере, но отсутствует")
            )

    for key, entry in env_entries.items():
        example_entry = example_entries.get(key)
        if example_entry is None:
            findings.append(
                Finding(
                    key,
                    entry.line,
                    "extra-key",
                    "low",
                    f"{key} отсутствует в примере — пример устарел",
                )
            )
        value_finding = _check_value(entry, example_entry)
        if value_finding is not None:
            findings.append(value_finding)

    findings.sort(key=lambda f: (f.line is not None, f.line or 0, f.check))
    return findings
