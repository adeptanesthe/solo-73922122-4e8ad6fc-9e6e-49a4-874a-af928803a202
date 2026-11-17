"""Column/character mismatch diagnosis via exact CTC path probabilities.

The acoustic model may emit frame-probability columns whose order no longer
matches the workbench vocabulary (a token was inserted, swapped or relabelled).
Given a handful of *revised* subtitle pieces over already-consumed frames, this
module enumerates every bijection between the suspect vocabulary columns and
their single characters and scores each bijection with the **exact** CTC
forward probability of the reference subtitles (all paths that collapse to a
subtitle are merged with log-sum-exp; nothing is renormalised).

Rules implemented here
----------------------
* 2～5 suspect columns are picked from the non-blank vocabulary; the blank
  column (index 0) and every other column stay fixed.  The candidates are all
  permutations of the picked columns, i.e. every bijection between the picked
  characters and the picked probability columns.
* 1～4 mutually disjoint frame intervals of at most 64 already-advanced frames
  carry one reference subtitle each.  Under a candidate bijection the subtitle
  label ids are remapped onto the (hypothetical) real columns and scored with
  the same exact CTC forward routine used for prefix confirmation.
* A bijection's score is the sum of the per-segment log probabilities.  A
  segment whose CTC probability is zero (``-inf``, e.g. a required label never
  appears on any frame of the interval) makes the whole bijection
  *unreachable*; unreachable bijections never win and are listed separately.
* Every bijection attaining the best finite score is reported as optimal.
  Exact ties are kept — when several bijections share the optimum the caller
  must not claim a unique answer.

The computation is strictly read-only: it never touches the decoder beam, the
confirmed prefix or the undo history, and it never bumps the session revision.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple

from .decoder import (
    NEG_INF,
    DecodeError,
    compute_prefix_alpha,
    finite_or_none,
    prefix_alpha_scores,
)
from .state import Session, SessionError

MIN_SELECTED = 2
MAX_SELECTED = 5
MAX_SEGMENTS = 4
MAX_SEGMENT_FRAMES = 64
# Log-score differences below this are reported as an exact tie.  Matches the
# tolerance used by the numerical-core tests.
TIE_EPS = 1e-9


@dataclass(frozen=True)
class Segment:
    """One reference subtitle over the half-open interval [start, end)."""

    start: int
    end: int
    subtitle: str

    @property
    def length(self) -> int:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "subtitle": self.subtitle}


def validate_request(
    session: Session, columns: Sequence[int], raw_segments: Sequence[Segment]
) -> Tuple[List[int], List[Segment]]:
    """Normalise and validate a diagnosis request.

    Returns the picked columns in the user's order and the segments sorted by
    start frame.  Raises :class:`DecodeError` for malformed input and
    :class:`SessionError` when the requested frames have not been advanced yet.
    """
    if not isinstance(columns, (list, tuple)) or not columns:
        raise DecodeError("请选择至少 2 个待核对列")
    if not all(isinstance(c, int) and not isinstance(c, bool) for c in columns):
        raise DecodeError("列号必须是整数")
    if not (MIN_SELECTED <= len(columns) <= MAX_SELECTED):
        raise DecodeError(f"待核对单字（列）数量必须在 {MIN_SELECTED}～{MAX_SELECTED} 个之间")
    if len(set(columns)) != len(columns):
        raise DecodeError("待核对列不能重复")
    vocab_size = len(session.vocab)
    for column in columns:
        if not 1 <= column < vocab_size:
            raise DecodeError(f"列号 {column} 越界：只能选 1～{vocab_size - 1} 的非 blank 列")

    if not isinstance(raw_segments, (list, tuple)) or not raw_segments:
        raise DecodeError("至少填写 1 个参考字幕片段")
    if len(raw_segments) > MAX_SEGMENTS:
        raise DecodeError(f"参考片段最多 {MAX_SEGMENTS} 段")

    segments: List[Segment] = []
    for index, item in enumerate(raw_segments):
        if not isinstance(item, Segment):
            raise DecodeError("片段格式不正确")
        start, end, subtitle = item.start, item.end, item.subtitle
        if isinstance(start, bool) or isinstance(end, bool) or not (
            isinstance(start, int) and isinstance(end, int)
        ):
            raise DecodeError(f"第 {index + 1} 段的帧号必须是整数")
        if start < 0:
            raise DecodeError(f"第 {index + 1} 段起始帧不能为负")
        if end <= start:
            raise DecodeError(f"第 {index + 1} 段结束帧必须大于起始帧")
        if end - start > MAX_SEGMENT_FRAMES:
            raise DecodeError(f"第 {index + 1} 段超过 {MAX_SEGMENT_FRAMES} 帧")
        if end > session.next_frame:
            raise SessionError(
                f"第 {index + 1} 段超出已推进帧（当前仅推进到第 {session.next_frame} 帧边界）"
            )
        if not isinstance(subtitle, str) or not subtitle:
            raise DecodeError(f"第 {index + 1} 段参考字幕不能为空")
        unknown = [ch for ch in subtitle if ch not in session.decoder._token_index]
        if unknown:
            raise DecodeError(
                f"第 {index + 1} 段字幕包含词表外字符：{''.join(sorted(set(unknown)))}"
            )
        segments.append(Segment(start, end, subtitle))

    segments.sort(key=lambda item: (item.start, item.end))
    for previous, current in zip(segments, segments[1:]):
        if current.start < previous.end:
            raise DecodeError(
                f"片段帧区间互不重叠：第 {previous.start}～{previous.end} 帧与 "
                f"第 {current.start}～{current.end} 帧重叠"
            )

    picked_chars = {session.vocab[c] for c in columns}
    if not any(any(ch in picked_chars for ch in segment.subtitle) for segment in segments):
        raise DecodeError("参考字幕中至少要有一个字来自所选的待核对单字，否则各映射无法区分")

    return list(columns), segments


def _segment_logp(session: Session, segment: Segment, remap: Dict[str, int]) -> float:
    """Exact CTC forward log-probability of one subtitle under a column map."""
    token_index = session.decoder._token_index
    label_ids = [remap.get(ch, token_index[ch]) for ch in segment.subtitle]
    alpha = compute_prefix_alpha(session.frames[segment.start : segment.end], label_ids)
    total, _blank, _nonblank = prefix_alpha_scores(alpha)
    return total


def run_diagnosis(session: Session, columns: Sequence[int], raw_segments: Sequence[Segment]) -> dict:
    """Enumerate every bijection and score it on the reference segments.

    Purely reads ``session``: beams, confirmations, revision and frame progress
    are left untouched.
    """
    columns, segments = validate_request(session, columns, raw_segments)
    chars = [session.vocab[c] for c in columns]

    mappings: List[dict] = []
    # perm[j] is the probability column assumed to really emit chars[j].
    for perm in itertools.permutations(columns):
        remap = {chars[j]: int(perm[j]) for j in range(len(columns))}
        segment_views = []
        total = 0.0
        reachable = True
        for segment in segments:
            logp = _segment_logp(session, segment, remap)
            if logp == NEG_INF:
                reachable = False
            else:
                total += logp
            segment_views.append(
                {
                    "start": segment.start,
                    "end": segment.end,
                    "subtitle": segment.subtitle,
                    "logp": finite_or_none(logp),
                    "reachable": logp != NEG_INF,
                }
            )
        mappings.append(
            {
                "permutation": [int(column) for column in perm],
                "assignment": [
                    {"char": chars[j], "column": int(perm[j])} for j in range(len(columns))
                ],
                "total_logp": finite_or_none(total) if reachable else None,
                "reachable": reachable,
                "optimal": False,
                "segments": segment_views,
            }
        )

    reachable_scores = [m["total_logp"] for m in mappings if m["reachable"]]
    any_reachable = bool(reachable_scores)
    best_logp = max(reachable_scores) if any_reachable else None
    if any_reachable:
        for mapping in mappings:
            if mapping["reachable"] and abs(mapping["total_logp"] - best_logp) <= TIE_EPS:
                mapping["optimal"] = True
    optimal_count = sum(1 for mapping in mappings if mapping["optimal"])

    # Reachable (best first, exact ties ordered by permutation for stable
    # output), then unreachable bijections at the bottom.
    mappings.sort(key=lambda m: (not m["reachable"], -(m["total_logp"] or 0.0), m["permutation"]))

    return {
        "session_id": session.id,
        "revision": session.revision,
        "next_frame": session.next_frame,
        "columns": list(columns),
        "chars": chars,
        "segments": [segment.to_dict() for segment in segments],
        "mappings": mappings,
        "best_logp": best_logp,
        "optimal_count": optimal_count,
        "unique_optimal": optimal_count == 1,
        "any_reachable": any_reachable,
    }
