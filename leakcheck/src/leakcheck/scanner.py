from __future__ import annotations

import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from leakcheck.entropy import find_high_entropy_tokens
from leakcheck.rules import scan_line

MAX_FILE_BYTES = 1_000_000
IGNORE_MARKER = "leakcheck: ignore"
SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        "dist",
        "build",
        ".mypy_cache",
        ".pytest_cache",
        ".idea",
    }
)
SKIP_FILES = frozenset(
    {
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "Pipfile.lock",
        "composer.lock",
        "Cargo.lock",
        "go.sum",
    }
)


def _should_scan(path: Path) -> bool:
    if path.name in SKIP_FILES:
        return False
    if path.name.endswith((".min.js", ".min.css")) or path.suffix == ".map":
        return False
    return True


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    rule: str
    severity: str
    secret: str


def _is_binary(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return b"\x00" in handle.read(1024)
    except OSError:
        return True


def _staged_files(root: Path) -> Iterator[Path]:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    for name in result.stdout.splitlines():
        path = root / name
        if path.is_file() and _should_scan(path):
            yield path


def iter_files(root: Path, staged: bool) -> Iterator[Path]:
    if staged:
        yield from _staged_files(root)
        return
    if root.is_file():
        yield root
        return
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not _should_scan(path):
            continue
        yield path


def scan_file(
    path: Path, use_entropy: bool = True, max_bytes: int = MAX_FILE_BYTES
) -> list[Finding]:
    try:
        if path.stat().st_size > max_bytes:
            return []
    except OSError:
        return []
    if _is_binary(path):
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    findings: list[Finding] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        if IGNORE_MARKER in line:
            continue
        seen: set[str] = set()
        for match in scan_line(line):
            if match.value in seen:
                continue
            seen.add(match.value)
            findings.append(Finding(path, line_no, match.rule, match.severity, match.value))
        if use_entropy:
            for token in find_high_entropy_tokens(line):
                if token in seen:
                    continue
                seen.add(token)
                findings.append(Finding(path, line_no, "high-entropy-string", "medium", token))
    return findings


def scan_path(
    root: Path,
    staged: bool = False,
    use_entropy: bool = True,
    max_bytes: int = MAX_FILE_BYTES,
) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_files(root, staged):
        findings.extend(scan_file(path, use_entropy=use_entropy, max_bytes=max_bytes))
    return findings
