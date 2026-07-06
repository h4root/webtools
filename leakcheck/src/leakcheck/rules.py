from __future__ import annotations

import re
from dataclasses import dataclass
from typing import NamedTuple


class RuleMatch(NamedTuple):
    rule: str
    severity: str
    value: str


@dataclass(frozen=True)
class Rule:
    name: str
    severity: str
    pattern: re.Pattern[str]


RULES: tuple[Rule, ...] = (
    Rule("aws-access-key-id", "high", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    Rule(
        "aws-secret-access-key",
        "high",
        re.compile(r"(?i)aws.{0,20}?(?:secret|sk).{0,20}?['\"]([0-9a-zA-Z/+]{40})['\"]"),
    ),
    Rule("github-token", "high", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b")),
    Rule("github-fine-grained-token", "high", re.compile(r"\bgithub_pat_[0-9A-Za-z_]{82}\b")),
    Rule("slack-token", "high", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b")),
    Rule("google-api-key", "high", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    Rule("stripe-secret-key", "high", re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b")),
    Rule("telegram-bot-token", "medium", re.compile(r"\b\d{8,10}:[0-9A-Za-z_-]{35}\b")),
    Rule(
        "private-key",
        "high",
        re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
    ),
    Rule(
        "jwt",
        "medium",
        re.compile(r"\beyJ[0-9A-Za-z_\-]+\.eyJ[0-9A-Za-z_\-]+\.[0-9A-Za-z_\-]+\b"),
    ),
    Rule(
        "generic-secret-assignment",
        "medium",
        re.compile(
            r"(?i)(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)"
            r"\s*[:=]\s*['\"]([^'\"]{6,})['\"]"
        ),
    ),
)


def scan_line(line: str) -> list[RuleMatch]:
    matches: list[RuleMatch] = []
    for rule in RULES:
        for found in rule.pattern.finditer(line):
            value = found.group(found.lastindex) if found.lastindex else found.group(0)
            matches.append(RuleMatch(rule.name, rule.severity, value))
    return matches
