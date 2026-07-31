from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from certcheck.checks import FAILING_STATUSES, STATUS_LABEL, Result
from certcheck.probe import (
    DEFAULT_PORT,
    DEFAULT_TIMEOUT,
    Target,
    check_target,
    parse_target,
    read_targets,
)

MAX_WORKERS = 8


def _format_text(results: list[Result]) -> str:
    width = max(len(r.target) for r in results)
    lines = []
    for result in results:
        status = STATUS_LABEL[result.status]
        if result.not_after is None:
            tail = result.detail or ""
        else:
            expires = result.not_after.strftime("%Y-%m-%d")
            issuer = f"  {result.issuer}" if result.issuer else ""
            tail = f"{result.days_left:>5}д  до {expires}{issuer}"
        lines.append(f"{result.target:<{width}}  {status:<10} {tail}".rstrip())
    return "\n".join(lines)


def _format_json(results: list[Result]) -> str:
    payload = [
        {
            "target": r.target,
            "status": r.status,
            "days_left": r.days_left,
            "not_after": r.not_after.isoformat() if r.not_after else None,
            "issuer": r.issuer,
            "detail": r.detail,
        }
        for r in results
    ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="certcheck",
        description="Проверить срок и валидность TLS-сертификатов: "
        "издатель, дата истечения, сколько дней осталось.",
    )
    parser.add_argument(
        "domains",
        nargs="*",
        help="Домены: example.com, example.com:8443, https://example.com/path.",
    )
    parser.add_argument(
        "--file",
        "-f",
        type=Path,
        help="Файл со списком доменов, по одному в строке (# — комментарий).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="За сколько дней до истечения считать сертификат истекающим.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="Порт по умолчанию, если он не указан рядом с доменом.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="Таймаут подключения в секундах.",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Формат вывода.",
    )
    return parser


def _collect_targets(args: argparse.Namespace) -> list[Target]:
    targets = [parse_target(raw, args.port) for raw in args.domains]
    if args.file:
        targets += read_targets(args.file.read_text(encoding="utf-8"), args.port)
    return targets


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.domains and not args.file:
        print("certcheck: укажите домены или --file", file=sys.stderr)
        return 2
    if args.file and not args.file.is_file():
        print(f"certcheck: файл не найден: {args.file}", file=sys.stderr)
        return 2

    try:
        targets = _collect_targets(args)
    except (OSError, UnicodeDecodeError) as error:
        print(f"certcheck: не удалось прочитать файл: {error}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(f"certcheck: {error}", file=sys.stderr)
        return 2

    if not targets:
        print("certcheck: список доменов пуст", file=sys.stderr)
        return 2

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(targets))) as pool:
        results = list(
            pool.map(lambda t: check_target(t, args.days, args.timeout), targets)
        )

    print(_format_json(results) if args.format == "json" else _format_text(results))

    failing = [r for r in results if r.status in FAILING_STATUSES]
    if failing and args.format == "text":
        print(f"\nТребуют внимания: {len(failing)} из {len(results)}", file=sys.stderr)
    return 1 if failing else 0
