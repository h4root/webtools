from dotenv_lint.parser import parse


def test_parses_key_value_pairs():
    parsed = parse("HOST=localhost\nPORT=5432\n")
    assert [(e.key, e.value, e.line) for e in parsed.entries] == [
        ("HOST", "localhost", 1),
        ("PORT", "5432", 2),
    ]


def test_skips_comments_and_blank_lines():
    parsed = parse("# comment\n\nHOST=localhost\n")
    assert [e.key for e in parsed.entries] == ["HOST"]
    assert parsed.malformed_lines == []


def test_strips_export_prefix():
    parsed = parse("export TOKEN=abc\n")
    assert parsed.entries[0].key == "TOKEN"


def test_strips_quotes_and_inline_comment():
    parsed = parse('GREETING="hello world"\nPORT=5432 # база\n')
    assert parsed.entries[0].value == "hello world"
    assert parsed.entries[1].value == "5432"


def test_hash_without_space_stays_in_value():
    parsed = parse("PASSWORD=abc#def\n")
    assert parsed.entries[0].value == "abc#def"


def test_reads_multiline_quoted_value():
    parsed = parse('KEY="line one\nline two"\nPORT=5432\n')
    assert parsed.entries[0].value == "line one\nline two"
    assert parsed.entries[1].key == "PORT"


def test_reports_malformed_lines():
    parsed = parse("HOST=localhost\njust some text\n1BAD=value\n")
    assert parsed.malformed_lines == [2, 3]


def test_duplicates_keep_first_value():
    parsed = parse("HOST=first\nHOST=second\n")
    assert parsed.first_by_key()["HOST"].value == "first"
    assert [e.line for e in parsed.duplicates()] == [2]
