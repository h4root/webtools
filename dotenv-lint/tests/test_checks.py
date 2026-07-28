from dotenv_lint.checks import lint
from dotenv_lint.parser import parse


def check_names(env: str, example: str) -> set[str]:
    return {f.check for f in lint(parse(env), parse(example))}


def test_matching_files_are_clean():
    env = "DATABASE_URL=postgres://user@localhost/app\nAPI_KEY=not-a-real-key-value\n"
    example = "DATABASE_URL=\nAPI_KEY=\n"
    assert lint(parse(env), parse(example)) == []


def test_reports_missing_key():
    findings = lint(parse("HOST=localhost\n"), parse("HOST=\nPORT=\n"))
    assert [(f.key, f.check, f.severity) for f in findings] == [("PORT", "missing-key", "high")]


def test_reports_extra_key_as_low():
    findings = lint(parse("HOST=localhost\nDEBUG=1\n"), parse("HOST=\n"))
    assert [(f.key, f.check, f.severity) for f in findings] == [("DEBUG", "extra-key", "low")]


def test_reports_empty_value_when_example_has_one():
    assert "empty-value" in check_names("PORT=\n", "PORT=5432\n")


def test_empty_value_allowed_when_example_is_empty():
    assert lint(parse("PORT=\n"), parse("PORT=\n")) == []


def test_reports_unreplaced_placeholder():
    assert "placeholder-value" in check_names("API_URL=<your-url>\n", "API_URL=\n")


def test_reports_weak_secret_value():
    assert "weak-value" in check_names("DB_PASSWORD=password\n", "DB_PASSWORD=\n")


def test_changeme_reported_as_placeholder():
    assert "placeholder-value" in check_names("DB_PASSWORD=change_me\n", "DB_PASSWORD=\n")


def test_weak_value_ignored_for_non_secret_key():
    assert lint(parse("NODE_ENV=test\n"), parse("NODE_ENV=\n")) == []


def test_reports_secret_copied_from_example():
    assert "unchanged-secret" in check_names(
        "JWT_SECRET=replace-with-random\n", "JWT_SECRET=replace-with-random\n"
    )


def test_reports_short_secret():
    assert "short-secret" in check_names("API_KEY=abc123\n", "API_KEY=\n")


def test_short_value_ignored_for_non_secret_key():
    assert lint(parse("PORT=5432\n"), parse("PORT=\n")) == []


def test_reports_duplicate_key():
    assert "duplicate-key" in check_names("HOST=first\nHOST=second\n", "HOST=\n")


def test_reports_malformed_line():
    assert "malformed-line" in check_names("HOST=localhost\ngarbage line\n", "HOST=\n")


def test_findings_sorted_with_missing_keys_first():
    findings = lint(parse("HOST=localhost\nDEBUG=1\n"), parse("HOST=\nPORT=\n"))
    assert [f.check for f in findings] == ["missing-key", "extra-key"]
