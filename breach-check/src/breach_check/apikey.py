from __future__ import annotations

import os
import sys
from getpass import getpass
from pathlib import Path

API_KEY_ENV = "HIBP_API_KEY"
KEY_URL = "https://haveibeenpwned.com/API/Key"
PROMPT = "Ключ HIBP (ввод не отображается): "


class MissingApiKey(RuntimeError):
    pass


def parse_key_file(text: str) -> str:
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        name, separator, value = line.partition("=")
        if separator and name.strip().upper() != API_KEY_ENV:
            continue
        key = (value if separator else line).strip().strip("\"'")
        if key:
            return key
    raise MissingApiKey(f"ключ не найден в файле, ожидалась строка вида {API_KEY_ENV}=...")


def resolve_api_key(key_file: Path | None = None, prompt: bool = True) -> str:
    if key_file:
        return parse_key_file(key_file.read_text(encoding="utf-8"))

    from_env = os.environ.get(API_KEY_ENV, "").strip()
    if from_env:
        return from_env

    if prompt and sys.stdin.isatty():
        key = getpass(PROMPT).strip()
        if key:
            return key

    raise MissingApiKey(
        f"нужен ключ HIBP: {API_KEY_ENV}=..., --key-file или ввод с клавиатуры "
        f"({KEY_URL})"
    )
