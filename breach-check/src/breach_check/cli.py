from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Sequence
from getpass import getpass
from pathlib import Path

from breach_check.accounts import (
    DEFAULT_DELAY,
    AccountResult,
    check_account,
    read_accounts,
    validate_account,
)
from breach_check.apikey import API_KEY_ENV, MissingApiKey, resolve_api_key
from breach_check.hibp import DEFAULT_TIMEOUT, HibpError
from breach_check.passwords import PasswordResult, check_password


def _plural(count: int, forms: tuple[str, str, str]) -> str:
    if count % 10 == 1 and count % 100 != 11:
        return forms[0]
    if count % 10 in (2, 3, 4) and count % 100 not in (12, 13, 14):
        return forms[1]
    return forms[2]


def _format_accounts_text(results: list[AccountResult]) -> str:
    width = max(len(r.account) for r in results)
    lines = []
    for result in results:
        if result.error:
            tail = f"ошибка: {result.error}"
        elif not result.breaches:
            tail = "чисто"
        else:
            named = ", ".join(
                f"{b.name} ({b.date})" if b.date else b.name for b in result.breaches
            )
            word = _plural(len(result.breaches), ("утечка", "утечки", "утечек"))
            tail = f"{len(result.breaches)} {word}: {named}"
        lines.append(f"{result.account:<{width}}  {tail}")
    return "\n".join(lines)


def _format_accounts_json(results: list[AccountResult]) -> str:
    payload = [
        {
            "account": r.account,
            "breaches": [
                {"name": b.name, "date": b.date, "data_classes": list(b.data_classes)}
                for b in r.breaches
            ],
            "error": r.error,
        }
        for r in results
    ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _format_passwords_text(results: list[PasswordResult]) -> str:
    width = max(len(r.label) for r in results)
    lines = []
    for result in results:
        tail = (
            f"найден в утечках, совпадений: {result.count}"
            if result.count
            else "не найден"
        )
        lines.append(f"{result.label:<{width}}  {tail}")
    return "\n".join(lines)


def _format_passwords_json(results: list[PasswordResult]) -> str:
    payload = [{"label": r.label, "count": r.count} for r in results]
    return json.dumps(payload, indent=2, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="breach-check",
        description="Проверка по Have I Been Pwned: пароли через k-anonymity "
        "range API (ключ не нужен), email через API v3 (нужен ключ).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    email = subparsers.add_parser(
        "email",
        help=f"Проверить email по утечкам. Ключ: --key-file, {API_KEY_ENV} "
        "или ввод с клавиатуры.",
    )
    email.add_argument("accounts", nargs="*", help="Адреса: user@example.com.")
    email.add_argument(
        "--file",
        "-f",
        type=Path,
        help="Файл со списком адресов, по одному в строке (# — комментарий).",
    )
    email.add_argument(
        "--key-file",
        type=Path,
        help=f"Файл с ключом HIBP: строка {API_KEY_ENV}=... или сам ключ. "
        "Приоритетнее переменной окружения.",
    )
    email.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
        help="Пауза между запросами в секундах: у HIBP жёсткий лимит.",
    )

    password = subparsers.add_parser(
        "password",
        help="Проверить пароль: наружу уходят только первые 5 символов SHA-1.",
    )
    password.add_argument(
        "--stdin",
        action="store_true",
        help="Читать пароли из stdin, по одному в строке, вместо запроса ввода.",
    )

    for subparser in (email, password):
        subparser.add_argument(
            "--timeout",
            type=float,
            default=DEFAULT_TIMEOUT,
            help="Таймаут запроса в секундах.",
        )
        subparser.add_argument(
            "--format",
            choices=("text", "json"),
            default="text",
            help="Формат вывода.",
        )
    return parser


def _collect_accounts(args: argparse.Namespace) -> list[str]:
    accounts = [validate_account(raw) for raw in args.accounts]
    if args.file:
        accounts += read_accounts(args.file.read_text(encoding="utf-8"))
    return accounts


def _run_email(args: argparse.Namespace) -> int:
    if not args.accounts and not args.file:
        print("breach-check: укажите адреса или --file", file=sys.stderr)
        return 2
    if args.file and not args.file.is_file():
        print(f"breach-check: файл не найден: {args.file}", file=sys.stderr)
        return 2

    try:
        accounts = _collect_accounts(args)
    except (OSError, UnicodeDecodeError) as error:
        print(f"breach-check: не удалось прочитать файл: {error}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(f"breach-check: {error}", file=sys.stderr)
        return 2

    if not accounts:
        print("breach-check: список адресов пуст", file=sys.stderr)
        return 2

    try:
        api_key = resolve_api_key(args.key_file)
    except MissingApiKey as error:
        print(f"breach-check: {error}", file=sys.stderr)
        return 2
    except (OSError, UnicodeDecodeError) as error:
        print(f"breach-check: не удалось прочитать ключ: {error}", file=sys.stderr)
        return 2

    results = []
    for index, account in enumerate(accounts):
        if index:
            time.sleep(args.delay)
        results.append(check_account(account, api_key, args.timeout))

    if args.format == "json":
        print(_format_accounts_json(results))
    else:
        print(_format_accounts_text(results))

    failing = [r for r in results if r.breaches or r.error]
    return 1 if failing else 0


def _read_passwords(use_stdin: bool) -> list[tuple[str, str]]:
    if use_stdin:
        lines = sys.stdin.read().splitlines()
        return [(f"строка {n}", line) for n, line in enumerate(lines, 1) if line]
    password = getpass("Пароль (ввод не отображается): ")
    return [("пароль", password)] if password else []


def _run_password(args: argparse.Namespace) -> int:
    entries = _read_passwords(args.stdin)
    if not entries:
        print("breach-check: пароль не введён", file=sys.stderr)
        return 2

    try:
        results = [
            check_password(password, label, args.timeout) for label, password in entries
        ]
    except OSError as error:
        print(f"breach-check: сеть недоступна: {error}", file=sys.stderr)
        return 2

    if args.format == "json":
        print(_format_passwords_json(results))
    else:
        print(_format_passwords_text(results))

    return 1 if any(r.count for r in results) else 0


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return _run_email(args) if args.command == "email" else _run_password(args)
    except HibpError as error:
        print(f"breach-check: {error}", file=sys.stderr)
        return 2
