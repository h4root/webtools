from leakcheck.rules import scan_line


def test_detects_aws_access_key():
    matches = scan_line('aws_key = "AKIAIOSFODNN7EXAMPLE"')
    assert any(m.rule == "aws-access-key-id" for m in matches)


def test_detects_github_token():
    token = "ghp_" + "a" * 36
    matches = scan_line(f'token = "{token}"')
    assert any(m.rule == "github-token" for m in matches)


def test_detects_private_key_header():
    matches = scan_line("-----BEGIN RSA PRIVATE KEY-----")
    assert any(m.rule == "private-key" for m in matches)


def test_detects_generic_secret_assignment():
    matches = scan_line('password = "s3cr3tValue"')
    assert any(m.rule == "generic-secret-assignment" for m in matches)


def test_clean_code_has_no_matches():
    assert scan_line("def add(a, b): return a + b") == []
