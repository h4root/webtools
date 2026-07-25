from pathlib import Path

from leakcheck.cli import mask
from leakcheck.scanner import scan_file, scan_path


def test_finds_secret_in_file(tmp_path: Path):
    (tmp_path / "config.py").write_text(
        'API_KEY = "AKIAIOSFODNN7EXAMPLE"\n', encoding="utf-8"
    )
    findings = scan_path(tmp_path)
    assert any(f.rule == "aws-access-key-id" for f in findings)


def test_inline_ignore_suppresses(tmp_path: Path):
    (tmp_path / "config.py").write_text(
        'API_KEY = "AKIAIOSFODNN7EXAMPLE"  # leakcheck: ignore\n', encoding="utf-8"
    )
    assert scan_path(tmp_path) == []


def test_binary_file_skipped(tmp_path: Path):
    target = tmp_path / "blob.bin"
    target.write_bytes(b"AKIAIOSFODNN7EXAMPLE\x00\x01\x02")
    assert scan_file(target) == []


def test_skips_vendored_dirs(tmp_path: Path):
    vendored = tmp_path / "node_modules"
    vendored.mkdir()
    (vendored / "leak.js").write_text('k = "AKIAIOSFODNN7EXAMPLE"', encoding="utf-8")
    assert scan_path(tmp_path) == []


def test_mask_hides_full_secret():
    secret = "AKIAIOSFODNN7EXAMPLE"
    masked = mask(secret)
    assert secret not in masked
    assert masked.startswith("AKIA")
