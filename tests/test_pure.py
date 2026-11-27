"""Pure helpers: labels, levels, error classes, knowledge search."""

import pytest

from keel import errors, knowledge, labels, levels


def test_strictest_label_of_empty_is_default() -> None:
    assert labels.strictest([]) == "public"
    assert labels.strictest([], default="internal") == "internal"


def test_strictest_label_single_and_many() -> None:
    assert labels.strictest(["confidential"]) == "confidential"
    assert labels.strictest(["public", "restricted", "internal"]) == "restricted"


def test_unknown_label_is_a_clear_error() -> None:
    with pytest.raises(ValueError, match="unknown label"):
        labels.rank("secret")


def test_audiences() -> None:
    assert labels.audience_allows(labels.audience_max_for_target("team"), "confidential")
    assert not labels.audience_allows(labels.audience_max_for_target("team"), "restricted")
    assert not labels.audience_allows(labels.audience_max_for_target("org"), "confidential")
    assert labels.audience_max_for_target("nowhere") == "public"


def test_approval_rate_empty_single_many() -> None:
    assert levels.approval_rate([]) is None
    assert levels.approval_rate(["approved"]) == 1.0
    assert levels.approval_rate(["approved", "edited", "rejected", "approved"]) == 0.5


def test_unknown_action_needs_act_level() -> None:
    assert levels.min_level_for("something.new") == levels.DEFAULT_ACTION_MIN_LEVEL
    assert not levels.may_act_alone(2, "something.new")


@pytest.mark.parametrize(
    ("status", "cls"),
    [
        (503, errors.UNKNOWN_OUTCOME),
        (502, errors.UNKNOWN_OUTCOME),
        (504, errors.UNKNOWN_OUTCOME),
        (500, errors.UNKNOWN_OUTCOME),
        (408, errors.UNKNOWN_OUTCOME),
        (403, errors.PERMISSION_DENIED),
        (401, errors.AUTH_INVALID),
        (404, errors.NOT_FOUND),
        (429, errors.RATE_LIMITED),
        (422, errors.BAD_REQUEST),
    ],
)
def test_http_classes(status: int, cls: str) -> None:
    assert errors.classify_http("GitHub", status).error_class == cls


def test_403_is_not_credential_expiry_unless_rate_limit() -> None:
    assert errors.classify_http("GitHub", 403).error_class == errors.PERMISSION_DENIED
    limited = errors.classify_http("GitHub", 403, headers={"X-RateLimit-Remaining": "0", "Retry-After": "12"})
    assert (limited.error_class, limited.retry_after_s) == (errors.RATE_LIMITED, 12.0)


def test_transport_errors_depend_on_whether_sent() -> None:
    assert errors.classify_transport("Slack", TimeoutError(), sent=True).error_class == errors.UNKNOWN_OUTCOME
    assert (
        errors.classify_transport("Slack", ConnectionRefusedError(), sent=False).error_class
        == errors.UNREACHABLE
    )


def test_slack_codes() -> None:
    assert errors.classify_slack("token_revoked").error_class == errors.AUTH_INVALID
    assert errors.classify_slack("not_in_channel").error_class == errors.PERMISSION_DENIED


def test_tokenize_and_chunks_empty() -> None:
    assert knowledge.tokenize("") == []
    assert knowledge.chunks("") == []
    assert knowledge.chunks("   \n\n  ") == []


def test_chunks_single_and_split() -> None:
    assert knowledge.chunks("one paragraph") == ["one paragraph"]
    parts = knowledge.chunks("a" * 50 + "\n\n" + "b" * 50, size=60)
    assert parts == ["a" * 50, "b" * 50]
    assert all(len(p) <= 60 for p in knowledge.chunks("x" * 200, size=60))


def _p(title: str, text: str, label: str = "internal") -> knowledge.Passage:
    return knowledge.Passage(doc_id=title, title=title, source=f"s://{title}", label=label, text=text)


def test_bm25_empty_inputs() -> None:
    assert knowledge.bm25("", [_p("a", "rotate keys")]) == []
    assert knowledge.bm25("rotate", []) == []
    assert knowledge.bm25("the and of", [_p("a", "rotate keys")]) == []


def test_bm25_single_and_ranking() -> None:
    assert [p.title for p in knowledge.bm25("rotate", [_p("keys", "how to rotate keys")])] == ["keys"]
    ranked = knowledge.bm25(
        "webhook secret rotation",
        [
            _p("lunch", "team lunch is on friday"),
            _p("webhooks", "rotate the webhook secret: webhook secret rotation runbook"),
            _p("deploy", "deploys use the secret store"),
        ],
    )
    assert ranked[0].title == "webhooks"
    assert "lunch" not in [p.title for p in ranked]
