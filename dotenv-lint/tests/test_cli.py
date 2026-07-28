import json
from pathlib import Path

from dotenv_lint.cli import main


def write_pair(tmp_path: Path, env: str, example: str) -> Path:
    env_path = tmp_path / ".env"
    env_path.write_text(env, encoding="utf-8")
    (tmp_path / ".env.example").write_text(example, encoding="utf-8")
    return env_path


def test_clean_pair_exits_zero(tmp_path: Path):
    env_path = write_pair(tmp_path, "HOST=localhost\n", "HOST=\n")
    assert main([str(env_path)]) == 0


def test_missing_key_exits_one(tmp_path: Path):
    env_path = write_pair(tmp_path, "HOST=localhost\n", "HOST=\nPORT=\n")
    assert main([str(env_path)]) == 1


def test_low_severity_does_not_fail_by_default(tmp_path: Path, capsys):
    env_path = write_pair(tmp_path, "HOST=localhost\nDEBUG=1\n", "HOST=\n")
    assert main([str(env_path)]) == 0
    assert "extra-key" in capsys.readouterr().out


def test_fail_on_low_catches_extra_key(tmp_path: Path):
    env_path = write_pair(tmp_path, "HOST=localhost\nDEBUG=1\n", "HOST=\n")
    assert main([str(env_path), "--fail-on", "low"]) == 1


def test_missing_file_exits_two(tmp_path: Path):
    assert main([str(tmp_path / ".env")]) == 2


def test_json_output_is_parseable(tmp_path: Path, capsys):
    env_path = write_pair(tmp_path, "HOST=localhost\n", "HOST=\nPORT=\n")
    main([str(env_path), "--format", "json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload[0]["check"] == "missing-key"
    assert payload[0]["key"] == "PORT"


def test_custom_example_path(tmp_path: Path):
    env_path = tmp_path / ".env"
    env_path.write_text("HOST=localhost\n", encoding="utf-8")
    example_path = tmp_path / "env.template"
    example_path.write_text("HOST=\nPORT=\n", encoding="utf-8")
    assert main([str(env_path), "--example", str(example_path)]) == 1
