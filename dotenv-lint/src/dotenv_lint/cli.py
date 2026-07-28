from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from dotenv_lint.checks import SEVERITY_ORDER, Finding, lint
from dotenv_lint.parser import parse


def _format_text(findings: list[Finding], env_path: Path) -> str:
    return "\n".join(
        f"{env_path}:{f.line}: [{f.severity}] {f.check}: {f.detail}"
        if f.line is not None
        else f"{env_path}: [{f.severity}] {f.check}: {f.detail}"
        for f in findings
    )


def _format_json(findings: list[Finding]) -> str:
    payload = [
        {
            "key": f.key,
            "line": f.line,
            "check": f.check,
            "severity": f.severity,
            "detail": f.detail,
        }
        for f in findings
    ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dotenv-lint",
        description="Сверить .env с .env.example: пропущенные и лишние ключи, "
        "незаменённые плейсхолдеры, слабые значения.",
    )
    parser.add_argument(
        "env",
        nargs="?",
        default=Path(".env"),
        type=Path,
        help="Путь к .env (по умолчанию: .env в текущем каталоге).",
    )
    parser.add_argument(
        "--example",
        type=Path,
        help="Путь к .env.example (по умолчанию: .env.example рядом с .env).",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Формат вывода.",
    )
    parser.add_argument(
        "--fail-on",
        choices=("high", "medium", "low"),
        default="medium",
        help="Минимальная серьёзность, при которой код возврата 1.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    env_path: Path = args.env
    example_path: Path = args.example or env_path.with_name(".env.example")

    for path in (env_path, example_path):
        if not path.is_file():
            print(f"dotenv-lint: файл не найден: {path}", file=sys.stderr)
            return 2

    try:
        env_text = env_path.read_text(encoding="utf-8")
        example_text = example_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        print(f"dotenv-lint: не удалось прочитать файл: {error}", file=sys.stderr)
        return 2

    findings = lint(parse(env_text), parse(example_text))
    if not findings:
        return 0

    print(_format_json(findings) if args.format == "json" else _format_text(findings, env_path))
    if args.format == "text":
        print(f"\nНайдено проблем: {len(findings)}", file=sys.stderr)

    threshold = SEVERITY_ORDER[args.fail_on]
    return 1 if any(SEVERITY_ORDER[f.severity] >= threshold for f in findings) else 0
