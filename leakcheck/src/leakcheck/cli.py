from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

from leakcheck.scanner import Finding, scan_path


def mask(secret: str) -> str:
    if len(secret) <= 6:
        return (secret[0] + "…") if secret else "…"
    return f"{secret[:4]}…{secret[-2:]} ({len(secret)} chars)"


def _relative(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


def _format_text(findings: list[Finding], base: Path) -> str:
    return "\n".join(
        f"{_relative(f.path, base)}:{f.line}: [{f.severity}] {f.rule}: {mask(f.secret)}"
        for f in findings
    )


def _format_json(findings: list[Finding], base: Path) -> str:
    payload = [
        {
            "path": _relative(f.path, base),
            "line": f.line,
            "rule": f.rule,
            "severity": f.severity,
            "match": mask(f.secret),
        }
        for f in findings
    ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="leakcheck",
        description="Найти захардкоженные секреты (API-ключи, токены, high-entropy строки) в коде.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=Path("."),
        type=Path,
        help="Файл или каталог для сканирования (по умолчанию: текущий).",
    )
    parser.add_argument(
        "--staged",
        action="store_true",
        help="Сканировать только git-staged файлы (режим pre-commit).",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Формат вывода.",
    )
    parser.add_argument(
        "--no-entropy",
        action="store_true",
        help="Отключить детект по энтропии (только правила).",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=1_000_000,
        help="Пропускать файлы больше этого размера, байт.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root: Path = args.path
    search_root = Path.cwd() if args.staged and root == Path(".") else root

    try:
        findings = scan_path(
            search_root,
            staged=args.staged,
            use_entropy=not args.no_entropy,
            max_bytes=args.max_bytes,
        )
    except FileNotFoundError:
        print("leakcheck: git не найден — режим --staged требует git", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError:
        print("leakcheck: --staged нужно запускать внутри git-репозитория", file=sys.stderr)
        return 2

    if not findings:
        return 0

    base = search_root if search_root.is_dir() else search_root.parent
    output = _format_json(findings, base) if args.format == "json" else _format_text(findings, base)
    print(output)
    if args.format == "text":
        print(f"\nНайдено потенциальных секретов: {len(findings)}", file=sys.stderr)
    return 1
