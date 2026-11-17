"""Tests for the column/character mismatch diagnosis (numerical + HTTP)."""

import itertools
import math

import pytest
from fastapi.testclient import TestClient

from app.decoder import NEG_INF
from app.diagnosis import MAX_SEGMENT_FRAMES, Segment, run_diagnosis, validate_request
from app.main import app
from app.state import SessionError, SessionManager, advance, confirm

from test_decoder import brute_force

VOCAB3 = ["<blank>", "a", "b"]
VOCAB4 = ["<blank>", "a", "b", "c"]


def make_manager_session(vocab, frames, width=8):
    manager = SessionManager()
    return manager, manager.create(vocab, width, frames)


# ---------------------------------------------------------------- numerical core


def test_segment_score_matches_brute_force():
    frames = [
        [0.6, 0.4, 0.0],
        [0.1, 0.8, 0.1],
        [0.5, 0.0, 0.5],
        [0.2, 0.3, 0.5],
    ]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 4)
    result = run_diagnosis(session, [1, 2], [Segment(0, 4, "ab")])

    # Identity permutation (1, 2) must reproduce the brute-force exact CTC
    # probability of "ab" over the four frames.
    identity = next(m for m in result["mappings"] if m["permutation"] == [1, 2])
    expected_total, expected_blank, expected_nonblank = brute_force(frames, "ab", VOCAB3)
    assert identity["reachable"]
    assert abs(identity["segments"][0]["logp"] - expected_total) < 1e-9
    assert math.isfinite(identity["total_logp"])
    assert abs(identity["total_logp"] - expected_total) < 1e-9
    # sanity: the exact probability really comes from finite CTC paths
    assert expected_blank != NEG_INF or expected_nonblank != NEG_INF


def test_swapped_columns_identified_by_reference_subtitle():
    # The model really emits the "a" sound on column 2 and the "b" sound on
    # column 1, i.e. the vocabulary labels are swapped against the columns.
    frames = [
        [0.10, 0.05, 0.85],
        [0.10, 0.05, 0.85],
        [0.80, 0.10, 0.10],
        [0.10, 0.80, 0.10],
        [0.10, 0.80, 0.10],
    ]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 5)
    result = run_diagnosis(
        session, [1, 2], [Segment(0, 3, "a"), Segment(3, 5, "b")]
    )

    assert result["unique_optimal"] is True
    assert result["optimal_count"] == 1
    winner = next(m for m in result["mappings"] if m["optimal"])
    # Correct repair: a -> column 2, b -> column 1.
    assert winner["permutation"] == [2, 1]
    assignment = {item["char"]: item["column"] for item in winner["assignment"]}
    assert assignment == {"a": 2, "b": 1}
    # The identity (no swap) must score strictly worse.
    identity = next(m for m in result["mappings"] if m["permutation"] == [1, 2])
    assert identity["total_logp"] < winner["total_logp"]


def test_total_score_is_sum_of_segment_log_scores():
    frames = [
        [0.2, 0.7, 0.1],
        [0.5, 0.4, 0.1],
        [0.3, 0.1, 0.6],
        [0.6, 0.1, 0.3],
        [0.4, 0.2, 0.4],
    ]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 5)
    result = run_diagnosis(
        session, [1, 2], [Segment(0, 2, "a"), Segment(2, 5, "b")]
    )
    for mapping in result["mappings"]:
        if mapping["reachable"]:
            assert abs(
                mapping["total_logp"] - sum(s["logp"] for s in mapping["segments"])
            ) < 1e-12


def test_tied_optimal_mappings_are_all_reported():
    # Columns 1 and 2 carry identical probabilities, so no bijection can win
    # uniquely: both must be flagged optimal and unique_optimal must be False.
    frames = [
        [0.2, 0.4, 0.4],
        [0.2, 0.4, 0.4],
        [0.6, 0.2, 0.2],
    ]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 3)
    result = run_diagnosis(session, [1, 2], [Segment(0, 3, "a")])
    assert result["any_reachable"] is True
    assert result["unique_optimal"] is False
    assert result["optimal_count"] == 2
    winners = sorted(
        tuple(m["permutation"]) for m in result["mappings"] if m["optimal"]
    )
    assert winners == [(1, 2), (2, 1)]
    scores = {tuple(m["permutation"]): m["total_logp"] for m in result["mappings"]}
    assert abs(scores[(1, 2)] - scores[(2, 1)]) < 1e-12


def test_zero_probability_paths_are_unreachable_and_never_win():
    # Column 3 ("c") is impossible on every frame.  Every permutation that
    # maps the subtitle character c onto column 3 is unreachable.
    frames = [
        [0.30, 0.40, 0.30, 0.0],
        [0.30, 0.35, 0.35, 0.0],
        [0.50, 0.30, 0.20, 0.0],
    ]
    manager, session = make_manager_session(VOCAB4, frames)
    advance(session, 3)
    result = run_diagnosis(session, [1, 2, 3], [Segment(0, 3, "c")])

    perms = list(itertools.permutations([1, 2, 3]))
    assert len(result["mappings"]) == len(perms)
    unreachable = [m for m in result["mappings"] if not m["reachable"]]
    # c sits at permutation position 3; the 2! perms putting column 3 there
    # make the subtitle path impossible.
    assert len(unreachable) == 2
    assert all(m["total_logp"] is None for m in unreachable)
    assert all(m["segments"][0]["logp"] is None for m in unreachable)
    assert all(not m["optimal"] for m in unreachable)
    assert result["any_reachable"] is True
    assert result["optimal_count"] >= 1
    # Reachable rows are always listed before unreachable ones.
    assert all(
        m["reachable"]
        for m in result["mappings"][: len(result["mappings"]) - len(unreachable)]
    )


def test_all_unreachable_reports_no_winner():
    # A pure-blank frame cannot produce any label, so every bijection fails.
    frames = [[1.0, 0.0, 0.0]]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 1)
    result = run_diagnosis(session, [1, 2], [Segment(0, 1, "a")])
    assert result["any_reachable"] is False
    assert result["best_logp"] is None
    assert result["optimal_count"] == 0
    assert result["unique_optimal"] is False
    assert len(result["mappings"]) == 2
    assert all(not m["reachable"] for m in result["mappings"])


def test_repeated_characters_follow_ctc_blank_rule():
    # "aa" over three frames without an intervening blank is impossible; with a
    # blank in the middle it becomes reachable.  The diagnosis shares the exact
    # CTC forward routine with the decoder, so its semantics are identical.
    no_blank = [[0.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 1.0, 0.0]]
    manager, session = make_manager_session(VOCAB3, no_blank)
    advance(session, 3)
    result = run_diagnosis(session, [1, 2], [Segment(0, 3, "aa")])
    identity = next(m for m in result["mappings"] if m["permutation"] == [1, 2])
    assert identity["segments"][0]["reachable"] is False

    with_blank = [[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    manager2, session2 = make_manager_session(VOCAB3, with_blank)
    advance(session2, 3)
    result2 = run_diagnosis(session2, [1, 2], [Segment(0, 3, "aa")])
    identity2 = next(m for m in result2["mappings"] if m["permutation"] == [1, 2])
    assert identity2["segments"][0]["reachable"] is True
    assert abs(identity2["segments"][0]["logp"]) < 1e-12  # probability 1.0 -> log 0


# ---------------------------------------------------------------- validation


def test_validate_request_rules():
    frames = [[0.3, 0.4, 0.3] for _ in range(8)]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 8)

    def expect_error(columns, segments):
        with pytest.raises(Exception):
            validate_request(session, columns, segments)

    # column count must be 2..5
    expect_error([1], [Segment(0, 1, "a")])
    expect_error([1, 1], [Segment(0, 1, "a")])  # duplicates
    expect_error([0, 1], [Segment(0, 1, "a")])  # blank column is not selectable
    expect_error([1, 9], [Segment(0, 1, "a")])  # out of range
    # segments: 1..4, non-empty, in-vocab subtitles
    expect_error([1, 2], [])
    expect_error([1, 2], [Segment(0, 1, "")])
    expect_error([1, 2], [Segment(0, 1, "z")])
    # at most 64 frames per segment
    expect_error([1, 2], [Segment(0, MAX_SEGMENT_FRAMES + 1, "a")])
    # intervals must not overlap
    expect_error([1, 2], [Segment(0, 3, "a"), Segment(2, 4, "b")])
    # empty / backwards intervals rejected
    expect_error([1, 2], [Segment(3, 3, "a")])
    expect_error([1, 2], [Segment(4, 2, "a")])

    # disjoint segments are accepted and returned sorted by start frame while
    # the picked-column order is preserved.
    columns, segments = validate_request(
        session, [2, 1], [Segment(4, 6, "b"), Segment(0, 2, "a")]
    )
    assert columns == [2, 1]
    assert [s.start for s in segments] == [0, 4]


def test_picked_char_must_occur_in_subtitles():
    frames = [[0.25, 0.25, 0.25, 0.25] for _ in range(4)]
    manager, session = make_manager_session(VOCAB4, frames)
    advance(session, 4)
    # Picking columns 1,2 while the subtitle only uses the fixed column 3.
    with pytest.raises(Exception):
        validate_request(session, [1, 2], [Segment(0, 2, "c")])


def test_diagnosis_cannot_read_unadvanced_frames():
    frames = [[0.3, 0.4, 0.3] for _ in range(6)]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 3)
    with pytest.raises(SessionError):
        validate_request(session, [1, 2], [Segment(0, 4, "a")])


def test_diagnosis_is_strictly_read_only():
    frames = [
        [0.6, 0.4, 0.0],
        [0.1, 0.8, 0.1],
        [0.5, 0.0, 0.5],
        [0.2, 0.3, 0.5],
    ]
    manager, session = make_manager_session(VOCAB3, frames)
    advance(session, 3)
    confirm(session, "a")
    revision_before = session.revision
    next_frame_before = session.next_frame
    prefix_before = session.prefix
    beams_before = [
        (b.text, b.logp, b.logp_blank, b.logp_nonblank) for b in session.beams
    ]
    confirmations_before = len(session.confirmations)

    result = run_diagnosis(session, [1, 2], [Segment(0, 3, "a")])
    assert result["revision"] == revision_before

    assert session.revision == revision_before
    assert session.next_frame == next_frame_before
    assert session.prefix == prefix_before
    assert len(session.confirmations) == confirmations_before
    assert [
        (b.text, b.logp, b.logp_blank, b.logp_nonblank) for b in session.beams
    ] == beams_before
    # Running it again is still safe and deterministic.
    again = run_diagnosis(session, [1, 2], [Segment(0, 3, "a")])
    assert again["mappings"] == result["mappings"]


# ---------------------------------------------------------------- HTTP layer


@pytest.fixture()
def client():
    return TestClient(app)


def create_session(client, vocab=VOCAB3, frames=None):
    frames = frames or [
        [0.10, 0.05, 0.85],
        [0.10, 0.05, 0.85],
        [0.80, 0.10, 0.10],
        [0.10, 0.80, 0.10],
        [0.10, 0.80, 0.10],
    ]
    response = client.post(
        "/api/sessions",
        json={"vocab": vocab, "beam_width": 8, "frames": frames},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_diagnose_endpoint_repairs_swap(client):
    session = create_session(client)
    sid = session["session_id"]
    assert (
        client.post("/api/advance", json={"session_id": sid, "to_frame": 5}).status_code
        == 200
    )
    response = client.post(
        "/api/diagnose",
        json={
            "session_id": sid,
            "columns": [1, 2],
            "segments": [
                {"start": 0, "end": 3, "subtitle": "a"},
                {"start": 3, "end": 5, "subtitle": "b"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    # One advance bumped the revision; diagnosis itself must not bump it.
    assert payload["revision"] == 1
    assert payload["unique_optimal"] is True
    winner = next(m for m in payload["mappings"] if m["optimal"])
    assert winner["permutation"] == [2, 1]
    state = client.get(f"/api/sessions/{sid}").json()
    assert state["revision"] == 1
    assert state["next_frame"] == 5


def test_diagnose_validation_errors_are_400(client):
    session = create_session(client)
    sid = session["session_id"]
    client.post("/api/advance", json={"session_id": sid, "to_frame": 5})
    bad_payloads = [
        {"columns": [1], "segments": [{"start": 0, "end": 1, "subtitle": "a"}]},
        {"columns": [0, 1], "segments": [{"start": 0, "end": 1, "subtitle": "a"}]},
        {"columns": [1, 2], "segments": []},
        {"columns": [1, 2], "segments": [{"start": 0, "end": 1, "subtitle": ""}]},
        {"columns": [1, 2], "segments": [{"start": 0, "end": 1, "subtitle": "z"}]},
        {
            "columns": [1, 2],
            "segments": [
                {"start": 0, "end": 2, "subtitle": "a"},
                {"start": 1, "end": 3, "subtitle": "b"},
            ],
        },
        {"columns": [1, 2], "segments": [{"start": 0, "end": 65, "subtitle": "a"}]},
        # five segments exceed the 1..4 limit
        {
            "columns": [1, 2],
            "segments": [
                {"start": i, "end": i + 1, "subtitle": "a"} for i in range(5)
            ],
        },
        # a single picked column is below the 2..5 range
        {"columns": [1], "segments": [{"start": 0, "end": 1, "subtitle": "a"}]},
    ]
    for payload in bad_payloads:
        payload["session_id"] = sid
        response = client.post("/api/diagnose", json=payload)
        assert response.status_code == 400, (payload, response.text)


def test_diagnose_accepts_five_columns_and_four_segments(client):
    vocab = ["<blank>", "a", "b", "c", "d", "e"]
    frames = [[0.2, 0.2, 0.2, 0.15, 0.15, 0.1] for _ in range(8)]
    created = client.post(
        "/api/sessions",
        json={"vocab": vocab, "beam_width": 8, "frames": frames},
    ).json()
    sid = created["session_id"]
    client.post("/api/advance", json={"session_id": sid, "to_frame": 8})
    response = client.post(
        "/api/diagnose",
        json={
            "session_id": sid,
            "columns": [1, 2, 3, 4, 5],
            "segments": [
                {"start": 0, "end": 2, "subtitle": "a"},
                {"start": 2, "end": 4, "subtitle": "b"},
                {"start": 4, "end": 6, "subtitle": "c"},
                {"start": 6, "end": 8, "subtitle": "d"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["mappings"]) == 120  # 5! bijections
    assert all(len(m["segments"]) == 4 for m in payload["mappings"])


def test_diagnose_unadvanced_frames_are_409(client):
    session = create_session(client)
    sid = session["session_id"]
    client.post("/api/advance", json={"session_id": sid, "to_frame": 2})
    response = client.post(
        "/api/diagnose",
        json={
            "session_id": sid,
            "columns": [1, 2],
            "segments": [{"start": 0, "end": 4, "subtitle": "a"}],
        },
    )
    assert response.status_code == 409
    # The failed diagnosis must not mutate anything.
    state = client.get(f"/api/sessions/{sid}").json()
    assert state["next_frame"] == 2
    assert state["revision"] == 1


def test_diagnose_unknown_session_is_404(client):
    response = client.post(
        "/api/diagnose",
        json={
            "session_id": "missing",
            "columns": [1, 2],
            "segments": [{"start": 0, "end": 1, "subtitle": "a"}],
        },
    )
    assert response.status_code == 404


def test_diagnose_interleaved_with_mutations_stays_read_only(client):
    session = create_session(client)
    sid = session["session_id"]
    client.post("/api/advance", json={"session_id": sid, "to_frame": 5})
    diag = client.post(
        "/api/diagnose",
        json={
            "session_id": sid,
            "columns": [1, 2],
            "segments": [{"start": 0, "end": 3, "subtitle": "a"}],
        },
    )
    assert diag.status_code == 200
    state = client.get(f"/api/sessions/{sid}").json()
    target = state["beams"][0]["text"]
    assert target
    confirmed = client.post("/api/confirm", json={"session_id": sid, "prefix": target})
    assert confirmed.status_code == 200
    after = client.get(f"/api/sessions/{sid}").json()
    assert after["prefix"] == target
    assert after["confirmed_count"] == 1
