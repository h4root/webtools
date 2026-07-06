from leakcheck.entropy import find_high_entropy_tokens, shannon_entropy


def test_entropy_zero_for_repeated_chars():
    assert shannon_entropy("aaaaaaaa") == 0.0


def test_entropy_higher_for_random_than_uniform():
    assert shannon_entropy("aB3xZ9qL7pW2") > shannon_entropy("aaaabbbb")


def test_finds_high_entropy_base64_token():
    line = 'key = "kJ8fQ2mZ9xP1vC4tR7wN3bY6dL0sA5hG8uE2iO"'
    assert find_high_entropy_tokens(line)


def test_ignores_plain_english_sentence():
    line = "this is a perfectly ordinary sentence without any secrets in it"
    assert find_high_entropy_tokens(line) == []


def test_ignores_short_tokens():
    assert find_high_entropy_tokens("id = abc123") == []
