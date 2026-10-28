"""The archive's pure half: key builders and the gz-JSONL shard codec.

Everything here drives the REAL implementation — no key format is restated in
this file, which is the point. A test that rebuilt ``edgar/filings/...`` inline
would stay green after the builder was deleted.
"""

from __future__ import annotations

import gzip
import json
from datetime import date

import pytest

from app.sec import archive
from app.sec.archive_logic import (
    SHARD_CONTENT_TYPE,
    ArchiveKeyError,
    ShardCorruptError,
    ShardEncodeError,
    ShardFormatError,
    accession_nodashes,
    bulk_key,
    decode_shard,
    encode_shard,
    facts_shard_key,
    filing_key,
    merge_shard,
    parse_shard,
    serialize_shard,
    sniff_shard_format,
    text_key,
    thirteenf_shard_key,
)

APPLE = "0000320193"
ACC = "0001214659-26-011109"


# ── Key builders: the happy path is an EXACT string ─────────────────────────
#
# Exact, because these keys are the only handle an archived object has. A test
# that asserted "starts with edgar/" would pass for a key that lost its CIK.


def test_filing_key_is_the_documented_path() -> None:
    assert filing_key(APPLE, ACC) == f"edgar/filings/{APPLE}/{ACC}/submission.txt"


def test_text_key_carries_the_sequence() -> None:
    assert text_key(APPLE, ACC, 7) == f"edgar/text/{APPLE}/{ACC}/7.txt"


def test_facts_and_13f_shard_keys_have_no_extension() -> None:
    # No extension is deliberate: the reader sniffs magic bytes, so a parquet
    # producer can take these exact keys later without moving an object.
    facts = facts_shard_key(APPLE, "us-gaap")
    holdings = thirteenf_shard_key("0001067983", "2025-06-30")
    assert facts == f"edgar/facts/{APPLE}/us-gaap"
    assert holdings == "edgar/13f/0001067983/2025-06-30"
    assert "." not in facts.rsplit("/", 1)[-1]
    assert "." not in holdings.rsplit("/", 1)[-1]


def test_bulk_key_defaults_the_basename_to_the_feed_zip() -> None:
    assert bulk_key("companyfacts", "2026-08-29") == (
        "edgar/bulk/companyfacts/2026-08-29/companyfacts.zip"
    )
    assert bulk_key("submissions", date(2026, 8, 29), "submissions.zip") == (
        "edgar/bulk/submissions/2026-08-29/submissions.zip"
    )


def test_every_key_lives_under_one_prefix_and_has_no_empty_segment() -> None:
    keys = [
        bulk_key("companyfacts", "2026-08-29"),
        filing_key(APPLE, ACC),
        text_key(APPLE, ACC, 1),
        facts_shard_key(APPLE, "dei"),
        thirteenf_shard_key("0001067983", "2025-06-30"),
    ]
    for key in keys:
        assert key.startswith("edgar/")
        assert "//" not in key
        assert not key.endswith("/")


# ── Key builders: every rejection ───────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_cik",
    [
        "320193",  # unpadded — would be a SECOND prefix for the same company
        "00003201930",  # eleven digits
        "000032019X",
        "",
        None,
        320193,
    ],
)
def test_cik10_must_be_exactly_ten_digits(bad_cik: object) -> None:
    with pytest.raises(ArchiveKeyError):
        filing_key(bad_cik, ACC)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad_accession",
    [
        "000121465926011109",  # the undashed form belongs in the URL, not the key
        "0001214659-26-01110",  # one digit short
        "0001214659/26/011109",
        "",
        None,
    ],
)
def test_accession_must_be_the_dashed_canonical_form(bad_accession: object) -> None:
    with pytest.raises(ArchiveKeyError):
        filing_key(APPLE, bad_accession)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad_segment",
    [
        "",  # empty -> a double slash nobody can query back
        "us-gaap/v2",  # a slash silently invents a directory level
        "us gaap",
        "us\ngaap",
        "us\x00gaap",
        "../secrets",
        ".hidden",
        " us-gaap",
        "us-gaap ",
    ],
)
def test_a_segment_with_a_separator_or_control_character_is_refused(bad_segment: str) -> None:
    with pytest.raises(ArchiveKeyError):
        facts_shard_key(APPLE, bad_segment)


@pytest.mark.parametrize("bad_day", ["2026-02-31", "2026-13-01", "26-01-01", "2026/08/29", ""])
def test_a_date_segment_must_be_a_real_calendar_day(bad_day: str) -> None:
    # A shape-only check accepts 2026-02-31, which sorts between two real days
    # and can never be recomputed by a reader.
    with pytest.raises(ArchiveKeyError):
        bulk_key("companyfacts", bad_day)


@pytest.mark.parametrize("bad_sequence", [0, -1, "1", True, 1.0])
def test_sequence_must_be_a_positive_int(bad_sequence: object) -> None:
    with pytest.raises(ArchiveKeyError):
        text_key(APPLE, ACC, bad_sequence)  # type: ignore[arg-type]


def test_accession_nodashes_validates_before_it_strips() -> None:
    assert accession_nodashes(ACC) == "000121465926011109"
    with pytest.raises(ArchiveKeyError):
        accession_nodashes("nonsense")


# ── The codec ───────────────────────────────────────────────────────────────


def test_round_trip_preserves_rows_and_reports_zero_dropped() -> None:
    rows = [
        {"c": "Revenues", "v": 391035000000, "e": "2024-09-28"},
        {"c": "Assets", "v": 364980000000, "e": "2024-09-28"},
    ]
    parsed = decode_shard(encode_shard(rows, sort_key=lambda r: str(r["c"])))
    assert parsed.dropped == 0
    assert sorted(parsed.rows, key=lambda r: str(r["c"])) == sorted(rows, key=lambda r: str(r["c"]))


def test_the_shard_text_has_NO_trailing_newline() -> None:
    # The TypeScript reader (candle-logic.ts parseColdShard) splits on "\n"; a
    # trailing one yields a final empty element. It tolerates that, but the two
    # writers agree on the stricter shape so that counting lines counts rows.
    text = serialize_shard([{"a": 1}, {"a": 2}])
    assert text == '{"a":1}\n{"a":2}'
    assert not text.endswith("\n")
    assert gzip.decompress(encode_shard([{"a": 1}])) == b'{"a":1}'


def test_json_is_compact_like_JSON_stringify() -> None:
    # Python's json.dumps defaults to ", " and ": ". JSON.stringify uses neither.
    line = serialize_shard([{"b": "x", "a": 1}])
    assert line == '{"b":"x","a":1}'
    assert ", " not in line
    assert ": " not in line


def test_non_ascii_is_stored_raw_not_escaped() -> None:
    # ensure_ascii=False matches JSON.stringify. Otherwise the same row written
    # by the TS writer and this one would have different bytes — and the sha256
    # of a shard is how a no-op re-write is recognised.
    text = serialize_shard([{"n": "Bâloise"}])
    assert text == '{"n":"Bâloise"}'
    assert "\\u" not in text


def test_bytes_depend_on_the_SET_of_rows_not_the_order_they_arrived() -> None:
    rows = [{"k": "b"}, {"k": "a"}, {"k": "c"}]
    first = encode_shard(rows, sort_key=lambda r: str(r["k"]))
    second = encode_shard(list(reversed(rows)), sort_key=lambda r: str(r["k"]))
    assert first == second
    assert first == encode_shard(rows, sort_key=lambda r: str(r["k"]))
    assert [r["k"] for r in decode_shard(first).rows] == ["a", "b", "c"]


def test_the_gzip_header_carries_NO_timestamp() -> None:
    # Bytes 4-8 of a gzip member are MTIME. Left at its default, gzip stamps the
    # current time, and two encodings of identical rows a second apart differ in
    # those four bytes — so the sha256 of a shard could never recognise a no-op
    # re-write, and Node's `gzipSync` (which zeroes them) would disagree with us.
    #
    # Asserted on the HEADER rather than by encoding twice: encoding twice inside
    # one second passes either way, which is exactly how this mutation survived
    # its first review.
    body = encode_shard([{"a": 1}])
    assert body[:2] == b"\x1f\x8b"
    assert body[4:8] == b"\x00\x00\x00\x00"


def test_sniff_recognises_gzip_and_parquet_and_refuses_anything_else() -> None:
    assert sniff_shard_format(encode_shard([{"a": 1}])) == "JSONL_GZ"
    assert sniff_shard_format(b"PAR1\x00\x00") == "PARQUET"
    with pytest.raises(ShardFormatError):
        sniff_shard_format(b'{"a":1}')  # plain JSONL, never written
    with pytest.raises(ShardFormatError):
        sniff_shard_format(b"")


def test_a_parquet_shard_fails_loudly_instead_of_decoding_as_empty() -> None:
    with pytest.raises(ShardFormatError, match="parquet"):
        decode_shard(b"PAR1" + b"\x00" * 32)


def test_a_truncated_gzip_member_raises_and_never_reads_as_an_empty_shard() -> None:
    body = encode_shard([{"a": i} for i in range(200)])
    with pytest.raises(ShardCorruptError):
        decode_shard(body[: len(body) // 2])


def test_a_corrupt_gzip_payload_raises() -> None:
    body = bytearray(encode_shard([{"a": i} for i in range(200)]))
    body[20:40] = b"\x00" * 20
    with pytest.raises(ShardCorruptError):
        decode_shard(bytes(body))


def test_a_malformed_line_is_dropped_and_COUNTED_not_thrown() -> None:
    text = "\n".join(
        [
            '{"a":1}',
            "{not json",
            "",  # a blank line is a separator, not damage
            "[1,2,3]",  # valid JSON, but not a row
            '{"a":2}',
            "   ",
        ]
    )
    parsed = parse_shard(text)
    assert [row["a"] for row in parsed.rows] == [1, 2]
    assert parsed.dropped == 2


def test_a_non_finite_number_is_refused_at_WRITE_time() -> None:
    # json.dumps would otherwise emit the literals NaN / Infinity, which are not
    # JSON: every strict reader drops the line, so the row would be "written"
    # and then silently absent.
    for poison in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ShardEncodeError):
            encode_shard([{"v": poison}])


def test_a_non_serialisable_value_names_the_row_that_broke() -> None:
    with pytest.raises(ShardEncodeError, match="row 1"):
        encode_shard([{"ok": 1}, {"bad": date(2026, 8, 29)}])


def test_a_non_object_row_is_refused() -> None:
    with pytest.raises(ShardEncodeError):
        serialize_shard([[1, 2, 3]])  # type: ignore[list-item]


def test_the_shard_content_type_says_gzip() -> None:
    assert SHARD_CONTENT_TYPE == "application/gzip"


# ── merge_shard ─────────────────────────────────────────────────────────────


def test_merge_lets_INCOMING_win_and_preserves_everything_else() -> None:
    existing = [
        {"cusip": "037833100", "value": 100},
        {"cusip": "594918104", "value": 200},
    ]
    incoming = [
        {"cusip": "037833100", "value": 999},  # restated
        {"cusip": "88160R101", "value": 300},  # new
    ]
    merged = merge_shard(existing, incoming, lambda r: str(r["cusip"]))

    by_cusip = {row["cusip"]: row["value"] for row in merged}
    assert by_cusip == {"037833100": 999, "594918104": 200, "88160R101": 300}
    # Sorted, so the encoded bytes are stable.
    assert [row["cusip"] for row in merged] == ["037833100", "594918104", "88160R101"]


def test_merging_into_an_empty_shard_is_just_the_incoming_rows() -> None:
    incoming = [{"k": "a"}, {"k": "b"}]
    assert merge_shard([], incoming, lambda r: str(r["k"])) == incoming


# ── The I/O wrapper's one decision ──────────────────────────────────────────
#
# `app.sec.archive` is a thin shell around the functions above, but it owns the
# read-merge-write, and getting that wrong destroys a whole shard on a put that
# returns 200. Tested here (rather than in a file of its own) because the two
# modules are one unit of ownership; only the GCS calls are stubbed.


def test_merge_and_write_reads_the_existing_shard_before_replacing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = encode_shard([{"cusip": "A", "v": 1}, {"cusip": "B", "v": 2}])
    written: list[tuple[str, bytes, str]] = []

    monkeypatch.setattr(archive, "read_bytes", lambda key: existing)
    monkeypatch.setattr(
        archive,
        "write_bytes",
        lambda key, data, *, content_type: written.append((key, data, content_type)),
    )

    counters = archive.merge_and_write_shard(
        "edgar/13f/0001067983/2025-06-30",
        [{"cusip": "B", "v": 99}, {"cusip": "C", "v": 3}],
        lambda row: str(row["cusip"]),
    )

    assert counters == {
        "existing": 2,
        "incoming": 2,
        "merged": 3,
        "dropped": 0,
        "bytes": len(written[0][1]),
    }
    key, body, content_type = written[0]
    assert key == "edgar/13f/0001067983/2025-06-30"
    assert content_type == SHARD_CONTENT_TYPE
    # A GCS put REPLACES the object, so the row nobody touched has to be in the
    # bytes that go back.
    assert {row["cusip"]: row["v"] for row in decode_shard(body).rows} == {"A": 1, "B": 99, "C": 3}


def test_merge_and_write_reports_lines_the_existing_shard_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import gzip as _gzip

    damaged = _gzip.compress(b'{"cusip":"A","v":1}\n{oops', mtime=0)
    monkeypatch.setattr(archive, "read_bytes", lambda key: damaged)
    monkeypatch.setattr(archive, "write_bytes", lambda key, data, *, content_type: None)

    counters = archive.merge_and_write_shard(
        "edgar/facts/0000320193/us-gaap", [{"cusip": "B", "v": 2}], lambda row: str(row["cusip"])
    )

    # The rewrite silently loses that line; a counter is the only way anyone
    # finds out it was ever there.
    assert counters["dropped"] == 1
    assert counters["merged"] == 2


def test_read_shard_answers_None_for_a_miss_and_RAISES_for_damage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(archive, "read_bytes", lambda key: None)
    assert archive.read_shard("edgar/facts/0000320193/us-gaap") is None

    monkeypatch.setattr(archive, "read_bytes", lambda key: b"\x1f\x8b truncated")
    # Never zero rows: the 13F evictor deletes hot rows only after re-reading
    # what it archived, and an empty read would make that check pass on nothing.
    with pytest.raises(ShardCorruptError):
        archive.read_shard("edgar/facts/0000320193/us-gaap")


def test_no_bucket_configured_is_an_ERROR_not_a_silent_passthrough() -> None:
    # conftest's clean_env clears GCP_STORAGE_BUCKET. Degrading here would turn
    # "archive first" into "SEC every time", invisibly.
    with pytest.raises(archive.ArchiveUnavailable):
        archive.bucket_name()


def test_a_shard_round_trips_through_json_the_TS_reader_would_accept() -> None:
    # The interop claim, checked rather than asserted in prose: every line of a
    # shard is independently parseable by a strict JSON parser, which is what
    # `JSON.parse(line)` does on the TypeScript side.
    body = encode_shard(
        [{"a": 1, "n": "Bâloise"}, {"a": 2, "n": "x"}], sort_key=lambda r: str(r["a"])
    )
    for line in gzip.decompress(body).decode("utf-8").split("\n"):
        assert isinstance(json.loads(line), dict)
