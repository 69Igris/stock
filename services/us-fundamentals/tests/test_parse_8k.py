"""8-K -> ``us_filing_documents`` + GCS text — MONEY-979 T7.

The fixture is iBio's real 8-K of 2026-08-28: Item 2.02 (results of operations)
plus Item 9.01, a primary document and an EX-99.1 press release — and, wrapped
around them by EDGAR itself, six XBRL-viewer artefacts. That mix is the point:
the naive "store every attachment" parser writes eight rows and six GCS objects
for a filing that contains two documents.

Two properties this file exists for:

1. A REPARSE THAT CHANGES NOTHING WRITES NOTHING. Same ``textHash``, no object,
   no row. This is what makes the whole 8-K queue safe to re-run after a mapping
   bump or an edgartools upgrade.
2. THE OBJECT IS WRITTEN BEFORE THE ROW THAT POINTS AT IT. A stored ``textPath``
   naming a key that holds no object is a 404 for every reader that follows it,
   and nothing in the row says so.
3. AN IMAGE IS NEVER ENQUEUED — MONEY-1324 (P17). Prod held 3,054
   ``us_filing_documents`` rows, 1,847 of them ``GRAPHIC`` and none with a
   ``textPath``: 60% of a PENDING queue that no extractor can ever consume.
   Apple's 10-K is borrowed for these, because it is the only fixture on disk
   carrying REAL ``<TYPE>GRAPHIC`` attachments and a synthetic doc cannot prove
   that an image really does arrive with no text.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from app.parsers import eightk_logic as logic
from app.parsers.dispatch import parse_and_store
from app.sec.archive_logic import text_key
from app.sec.edgar_adapter import eightk_from_bundle

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_text(name: str) -> str:
    return gzip.decompress((FIXTURES / MANIFEST[name]["file"]).read_bytes()).decode(
        "utf-8", "replace"
    )


ACCESSION = "0001420720-26-000019"
CIK = "0001420720"

#: Apple's FY2025 10-K. Borrowed by the image tests only — ``<TYPE>GRAPHIC`` is
#: one vocabulary across every EDGAR form and ``eightk_from_bundle`` is a
#: generic attachment walker, so ``aapl-20250927_g1.jpg`` arrives in exactly the
#: shape an 8-K press release's logo does.
IMAGE_ACCESSION = "0000320193-25-000079"
IMAGE_CIK = "0000320193"
IMAGE_FILENAMES = ["aapl-20250927_g1.jpg", "aapl-20250927_g2.jpg"]


class RecordingPut:
    """Captures ``(key, bytes)`` and shares a call log with the writer."""

    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.objects: list[tuple[str, bytes]] = []

    def __call__(self, key: str, data: bytes) -> None:
        self.log.append("put_object")
        self.objects.append((key, data))


def parsed_documents():
    return eightk_from_bundle(fixture_text("eightk_bundle"))


@pytest.fixture(scope="module")
def documents_with_images() -> tuple[Any, list[Any]]:
    """The 10-K's attachments, walked ONCE. Measured at ~2.0 s per walk."""
    return eightk_from_bundle(fixture_text("tenk_bundle_aapl"))


# ── what is and is not a document ───────────────────────────────────────────


def test_edgar_s_own_viewer_artefacts_are_not_documents() -> None:
    """``R1.htm``, ``FilingSummary.xml`` and the inline-XBRL copy each carry
    ``<DESCRIPTION>IDEA: XBRL DOCUMENT``. They are neither exhibits nor
    content."""
    _, docs = parsed_documents()
    storable = logic.storable_documents(docs)

    assert len(docs) == 5
    assert len(storable) == 2
    assert [doc.document_type for doc in storable] == ["8-K", "EX-99.1"]
    assert [doc.sequence for doc in storable] == [1, 2]
    for dropped in [doc for doc in docs if doc not in storable]:
        assert logic.is_generated_artifact(dropped)
        assert dropped.description == "IDEA: XBRL DOCUMENT"


def test_the_rule_is_a_deny_list_so_an_unknown_exhibit_class_still_lands() -> None:
    """Precision without a catch-all shrinks coverage: an allow-list of the
    types we happen to have seen would silently drop the next EX-107."""
    _, docs = parsed_documents()
    novel = docs[1].__class__(
        sequence=99,
        document_type="EX-107",
        filename="fee-table.htm",
        description="EX-107",
        text="filing fee table",
        text_bytes=16,
        text_hash="abc",
    )
    assert logic.is_generated_artifact(novel) is False
    assert novel in logic.storable_documents([*docs, novel])


def test_an_image_exhibit_is_refused_and_never_enqueued(documents_with_images) -> None:
    """An image has no text and never will, so nothing downstream can consume it.

    Measured on prod 2026-09-01: 1,847 of 3,054 rows were ``GRAPHIC`` and ZERO
    of them carried a ``textPath``. This asserts the REASON on the real
    attachment — nothing came out of it — and not merely the verdict, because a
    verdict pinned without its cause outlives the cause.
    """
    _meta, docs = documents_with_images
    images = [doc for doc in docs if doc.document_type == "GRAPHIC"]
    assert [doc.filename for doc in images] == IMAGE_FILENAMES

    triage = logic.triage_documents(docs)
    for image in images:
        assert (image.text, image.text_bytes, image.text_hash) == (None, None, None)
        assert logic.is_binary_media(image) is True
        assert image not in triage.storable
    assert list(triage.binary_media) == images


def test_a_real_exhibit_is_kept_so_the_rule_can_still_say_yes() -> None:
    """The control. A deny rule that refuses everything passes every test its
    author wrote about refusing."""
    _meta, docs = parsed_documents()
    triage = logic.triage_documents(docs)

    assert [doc.document_type for doc in triage.storable] == ["8-K", "EX-99.1"]
    assert triage.binary_media == ()
    for doc in triage.storable:
        assert logic.is_binary_media(doc) is False


def test_an_exhibit_whose_extraction_THREW_is_still_stored() -> None:
    """The refusal reads EDGAR's TYPE, never our own extraction outcome.

    ``eightk_from_bundle`` wraps ``attachment.text()`` in a bare ``except``, so
    a real EX-99.1 whose extraction failed is indistinguishable from an image by
    its text alone. Refusing on emptiness would drop it permanently and
    silently; it lands instead with ``textPath: None`` — the visible gap a later
    run can fill.
    """
    _meta, docs = parsed_documents()
    unreadable = docs[1].__class__(
        sequence=98,
        document_type="EX-99.1",
        filename="press-release.htm",
        description="EX-99.1",
        text=None,
        text_bytes=None,
        text_hash=None,
    )
    assert logic.is_binary_media(unreadable) is False
    assert unreadable in logic.triage_documents([*docs, unreadable]).storable


def test_the_image_rule_is_a_deny_list_too_and_ignores_the_filename() -> None:
    """A new exhibit class still lands, and a ``.jpg`` NAME does not condemn it.

    The filename is filer-supplied free text; the type is EDGAR's, validated at
    acceptance. An allow-list, or an extension test, silently drops the next
    EX-107.
    """
    _meta, docs = parsed_documents()
    novel = docs[1].__class__(
        sequence=97,
        document_type="EX-107",
        filename="fee-table.jpg",
        description="EX-107",
        text="filing fee table",
        text_bytes=16,
        text_hash="abc",
    )
    assert logic.is_binary_media(novel) is False
    assert novel in logic.triage_documents([*docs, novel]).storable


def test_the_two_deny_rules_are_counted_separately_and_lose_nothing(
    documents_with_images,
) -> None:
    """A PARTITION: every attachment lands in exactly one bucket.

    One "skipped" number over two causes is the MONEY-1255 shape — it reads full
    while one of the things it counts goes dark — so the artefact count must not
    absorb the images, and neither may drop a document on the floor.
    """
    _meta, docs = documents_with_images
    triage = logic.triage_documents(docs)

    assert len(docs) == 81
    assert (len(triage.storable), len(triage.generated_artifacts), len(triage.binary_media)) == (
        7,
        72,
        2,
    )
    buckets = [triage.storable, triage.generated_artifacts, triage.binary_media]
    seen = [id(doc) for bucket in buckets for doc in bucket]
    assert len(seen) == len(docs) == len(set(seen)), "a document was double-counted or lost"


def test_refusing_images_is_what_makes_a_REPARSE_write_nothing(
    documents_with_images,
) -> None:
    """The third reason images are refused rather than stamped UNSUPPORTED.

    ``text_is_unchanged`` treats a null hash on either side as NOT unchanged —
    deliberately — and an image has no hash, so a stored image row is re-emitted
    on EVERY reparse. Measured through this parser before the fix: a reparse of
    a completely unchanged 10-K reported ``documentsUnchanged`` 7 of 9 and wrote
    2 rows, both images. An UNSUPPORTED row would have kept exactly that.
    """
    _meta, docs = documents_with_images
    storable = logic.triage_documents(docs).storable
    # What `MongoLookups.document_hashes` would return after a prior run: it
    # drops rows with no `textHash`, so an image is simply absent from the map.
    stored = {doc.sequence: doc.text_hash for doc in storable if doc.text_hash}

    assert len(stored) == len(storable), "a storable document with no hash re-writes forever"
    assert all(logic.text_is_unchanged(stored.get(doc.sequence), doc) for doc in storable)


def test_items_are_numbers_and_the_earnings_item_is_flagged_from_them() -> None:
    """Item 2.02 is the earnings release. It is stored as an item NUMBER, never
    as a second boolean column that can disagree with the list."""
    meta, _ = parsed_documents()
    assert meta.items == ("2.02", "9.01")
    assert logic.has_earnings_item(meta) is True
    assert logic.EARNINGS_ITEM in meta.items


# ── rows ────────────────────────────────────────────────────────────────────


def test_rows_carry_the_pointer_the_hash_and_a_READY_status() -> None:
    """``extractionStatus`` is decided from the TEXT — MONEY-1351.

    This test used to assert PENDING for everything, and that was true and
    useless: the column read PENDING on 100% of 5,377 prod rows while 3,296 of
    them already held text, so it could not answer the one question it exists
    for. READY here says the row points at text that was extracted; it is not a
    claim about a downstream LLM stage, which is still out of scope.
    """
    meta, docs = parsed_documents()
    storable = logic.storable_documents(docs)
    paths = {doc.sequence: text_key(meta.cik10, ACCESSION, doc.sequence) for doc in storable}
    rows = logic.build_rows(
        meta, storable, accession=ACCESSION, text_paths=paths, parser_version="test"
    )

    assert len(rows) == 2
    assert rows[0]["documentType"] == "8-K"
    assert rows[1]["documentType"] == "EX-99.1"
    assert rows[1]["filename"] == "ibio-20260828xex99d1.htm"
    assert rows[1]["textBytes"] == 24650
    assert rows[1]["textPath"] == f"edgar/text/{CIK}/{ACCESSION}/2.txt"
    for row in rows:
        assert row["extractionStatus"] == "READY"
        assert row["items"] == ["2.02", "9.01"]
        assert row["cik10"] == CIK
        assert row["source"] == "SEC_EDGAR"
        assert row["parserVersion"] == "test"


def test_a_document_whose_extraction_produced_NOTHING_is_FAILED() -> None:
    """The other half of the decision, and the reason it is worth making.

    An exhibit whose extraction threw still LANDS — with ``textPath: None``, the
    visible refillable gap — and now says so in its own column instead of being
    indistinguishable from a document nobody has looked at yet.
    """
    meta, docs = parsed_documents()
    unreadable = docs[1].__class__(
        sequence=98,
        document_type="EX-99.1",
        filename="press-release.htm",
        description="EX-99.1",
        text=None,
    )
    rows = logic.build_rows(
        meta, [unreadable], accession=ACCESSION, text_paths={}, parser_version="test"
    )

    assert [row["extractionStatus"] for row in rows] == ["FAILED"]
    assert rows[0]["textPath"] is None
    assert rows[0]["textHash"] is None


def test_PENDING_is_the_MODEL_DEFAULT_and_no_parser_stamps_it() -> None:
    """ "Never processed" has to stay a distinct value, or the backfill that
    clears the legacy population cannot tell what it has already decided.

    Absent and deliberately-set must be distinguishable — the same rule the
    Cloud Build flags follow. So PENDING survives as the row model's default and
    every path through ``build_rows`` answers one of the other two.
    """
    from app.store.models import UsFilingDocumentRow

    assert UsFilingDocumentRow.model_fields["extractionStatus"].default == logic.EXTRACTION_PENDING
    assert (logic.EXTRACTION_READY, logic.EXTRACTION_FAILED) == ("READY", "FAILED")

    meta, docs = parsed_documents()
    storable = logic.storable_documents(docs)
    rows = logic.build_rows(
        meta, storable, accession=ACCESSION, text_paths={}, parser_version="test"
    )
    assert rows, "premise: the fixture yields storable documents"
    assert all(row["extractionStatus"] != logic.EXTRACTION_PENDING for row in rows)


def test_the_hash_is_sha256_of_the_extracted_text() -> None:
    """Named explicitly rather than "whatever the adapter produced": the whole
    idempotence argument rests on the two sides computing the same digest."""
    _, docs = parsed_documents()
    exhibit = logic.storable_documents(docs)[1]
    assert exhibit.text is not None
    assert exhibit.text_hash == hashlib.sha256(exhibit.text.encode("utf-8")).hexdigest()


def test_a_path_is_never_fabricated_for_a_document_with_no_text() -> None:
    """A binary exhibit has no extractable text. A row claiming a key that holds
    no object is worse than a row admitting it has none."""
    meta, docs = parsed_documents()
    storable = logic.storable_documents(docs)
    rows = logic.build_rows(
        meta, storable, accession=ACCESSION, text_paths={}, parser_version="test"
    )
    assert all(row["textPath"] is None for row in rows)


def test_the_filing_date_is_never_invented() -> None:
    meta, docs = parsed_documents()
    with pytest.raises(ValueError, match="refusing to invent one"):
        logic.build_rows(
            meta.__class__(cik10=CIK, form="8-K", filed_at=None, items=meta.items),
            logic.storable_documents(docs),
            accession=ACCESSION,
            text_paths={},
            parser_version="test",
        )


# ── idempotence ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("stored", [None, "", "a-different-hash"])
def test_an_absent_or_different_hash_is_not_unchanged(stored: str | None) -> None:
    """``None`` on either side is NOT a match: a row that predates hashing would
    otherwise skip the write that fills the gap, permanently."""
    _, docs = parsed_documents()
    doc = logic.storable_documents(docs)[0]
    assert logic.text_is_unchanged(stored, doc) is False


def test_the_same_hash_is_unchanged() -> None:
    _, docs = parsed_documents()
    doc = logic.storable_documents(docs)[0]
    assert logic.text_is_unchanged(doc.text_hash, doc) is True


def test_a_reparse_with_identical_text_writes_nothing() -> None:
    """No GCS object, no row — and the outcome SAYS so rather than reporting a
    silent zero."""
    from tests.test_dispatch import ExplodingWriter, StubLookups

    _meta, docs = parsed_documents()
    stored = {doc.sequence: doc.text_hash for doc in logic.storable_documents(docs)}
    log: list[str] = []
    put = RecordingPut(log)

    outcome = parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=ExplodingWriter(),
        lookups=StubLookups(hashes=stored),
        archive_put=put,
        apply=False,
    )
    assert outcome["rows"] == {"filing_documents": 0}
    assert outcome["detail"]["documentsUnchanged"] == 2
    assert outcome["detail"]["textObjects"] == 0
    assert put.objects == []


def test_a_reparse_of_a_CHANGED_document_writes_only_that_one() -> None:
    from tests.test_dispatch import RecordingWriter, StubLookups

    _meta, docs = parsed_documents()
    storable = logic.storable_documents(docs)
    # The primary document is unchanged; the press release was corrected.
    stored = {storable[0].sequence: storable[0].text_hash, storable[1].sequence: "stale"}
    log: list[str] = []
    writer = RecordingWriter()
    writer.calls = log
    put = RecordingPut(log)

    outcome = parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        lookups=StubLookups(hashes=stored),
        archive_put=put,
        apply=True,
    )
    assert outcome["detail"]["documentsUnchanged"] == 1
    assert outcome["rows"] == {"filing_documents": 1}
    assert [key for key, _ in put.objects] == [f"edgar/text/{CIK}/{ACCESSION}/2.txt"]
    assert writer.rows_for("filing_documents")[0]["documentType"] == "EX-99.1"


# ── ordering ────────────────────────────────────────────────────────────────


def test_the_object_is_written_before_the_row_that_points_at_it() -> None:
    from tests.test_dispatch import RecordingWriter

    log: list[str] = []
    writer = RecordingWriter()
    writer.calls = log
    put = RecordingPut(log)

    outcome = parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        archive_put=put,
        apply=True,
    )
    assert outcome["objectsWritten"] == 2
    assert outcome["written"] == 2
    assert log.count("put_object") == 2
    assert log.index("put_object") < log.index("upsert_rows")
    assert log.index("upsert_rows") < log.index("set_filing_status")


def test_a_failed_object_write_leaves_the_filing_unparsed() -> None:
    """The pointer must never precede the object, so a failed put fails the
    whole parse instead of writing rows that point at nothing."""
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()

    def broken(key: str, data: bytes) -> None:
        raise RuntimeError("GCS said no")

    with pytest.raises(RuntimeError, match="GCS said no"):
        parse_and_store(
            ACCESSION,
            fixture_text("eightk_bundle"),
            parse_class="EIGHTK",
            cik10=CIK,
            form="8-K",
            writer=writer,
            archive_put=broken,
            apply=True,
        )
    assert writer.upserts == []
    assert writer.statuses == []


def test_an_unarmed_run_writes_no_object_at_all() -> None:
    from tests.test_dispatch import ExplodingWriter

    put = RecordingPut([])
    outcome = parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=ExplodingWriter(),
        archive_put=put,
        apply=False,
    )
    # Parsed fully — two documents, two text objects PLANNED — and none written.
    assert outcome["detail"]["textObjects"] == 2
    assert outcome["rows"] == {"filing_documents": 2}
    assert put.objects == []


def test_through_dispatch_the_key_is_accession_and_sequence() -> None:
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        archive_put=lambda key, data: None,
        apply=True,
    )
    collection, _, key = writer.upserts[0]
    assert collection == "filing_documents"
    assert key == ("accession", "sequence")


def test_the_stored_text_is_exactly_what_was_hashed() -> None:
    """The bytes put to GCS and the digest in the row must be the same text, or
    the idempotence check compares a hash to an object that never held it."""
    from tests.test_dispatch import RecordingWriter

    log: list[str] = []
    writer = RecordingWriter()
    writer.calls = log
    put = RecordingPut(log)
    parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        archive_put=put,
        apply=True,
    )
    by_path: dict[str, bytes] = dict(put.objects)
    for row in writer.rows_for("filing_documents"):
        data = by_path[row["textPath"]]
        assert hashlib.sha256(data).hexdigest() == row["textHash"]
        assert len(data) == row["textBytes"]


def test_the_outcome_counts_the_artefacts_it_skipped() -> None:
    outcome: dict[str, Any] = parse_and_store(
        ACCESSION,
        fixture_text("eightk_bundle"),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
    )
    assert outcome["detail"]["documents"] == 2
    assert outcome["detail"]["generatedArtifactsSkipped"] == 3
    assert outcome["detail"]["binaryMediaSkipped"] == 0
    assert outcome["detail"]["isEarnings"] is True


def test_the_outcome_counts_the_images_it_refused() -> None:
    """A refusal that is not REPORTED is indistinguishable from a small filing.

    "We skipped 2 images" and "this filing had 2 fewer exhibits than we thought"
    are the same smaller ``documents`` count otherwise.

    End to end through the seam, so the count an operator reads is the one the
    decision produced — and separate from the artefact counter, which the old
    ``len(docs) - len(storable)`` subtraction would have silently absorbed them
    into.
    """
    outcome: dict[str, Any] = parse_and_store(
        IMAGE_ACCESSION,
        fixture_text("tenk_bundle_aapl"),
        parse_class="EIGHTK",
        cik10=IMAGE_CIK,
        form="10-K",
    )
    assert outcome["detail"]["binaryMediaSkipped"] == 2
    assert outcome["detail"]["generatedArtifactsSkipped"] == 72
    assert outcome["detail"]["documents"] == 7
    assert outcome["rows"] == {"filing_documents": 7}
    assert outcome["detail"]["textObjects"] == 7


# ── PDF exhibits, end to end (MONEY-1350 + MONEY-1351) ──────────────────────


def pdf_bundle(pages: list[list[str]]) -> str:
    """The real 8-K fixture with one extra PDF exhibit. Built by the adapter
    tests, which own the PDF and the uuencoding."""
    from tests.test_edgar_adapter import _pdf, bundle_with_pdf

    return bundle_with_pdf(_pdf(pages))


def test_the_outcome_reports_pdf_extraction_SEPARATELY_from_the_image_refusal() -> None:
    """Two orthogonal measurements, two counters.

    ``binaryMediaSkipped`` is one leg of a three-way PARTITION of the
    attachments; a PDF is STORED, not refused, so folding its count in would
    break that partition in both directions and leave one number reading full
    over two causes — the MONEY-1255 shape.
    """
    outcome: dict[str, Any] = parse_and_store(
        ACCESSION,
        pdf_bundle([["iBio Reports Fiscal Year 2026"]]),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
    )
    detail = outcome["detail"]

    assert detail["pdfTextExtracted"] == 1
    assert detail["pdfNoTextLayer"] == 0
    assert detail["binaryMediaSkipped"] == 0
    # The PDF is a THIRD storable document, alongside the 8-K and the EX-99.1.
    assert detail["documents"] == 3
    assert detail["textObjects"] == 3


def test_a_pdf_exhibit_reaches_the_row_as_READY_with_a_pointer() -> None:
    """The whole point of MONEY-1350: the exhibit stops being a permanent gap.

    Through the real seam — adapter, triage, build_rows, writer — because the
    counter and the row are decided in two different modules and only the seam
    shows they agree.
    """
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    parse_and_store(
        ACCESSION,
        pdf_bundle([["iBio Reports Fiscal Year 2026"]]),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        archive_put=lambda key, data: None,
        apply=True,
    )
    rows = writer.rows_for("filing_documents")
    exhibit = next(row for row in rows if str(row["filename"]).endswith(".pdf"))

    assert exhibit["extractionStatus"] == "READY"
    assert exhibit["textPath"] == f"edgar/text/{CIK}/{ACCESSION}/17.txt"
    assert exhibit["textHash"] is not None


def test_a_scanned_pdf_lands_FAILED_with_no_pointer_rather_than_not_landing() -> None:
    """A gap that is RECORDED is refillable; a document that never landed is not.

    The row exists, admits it has no text, and the outcome names the cause — so
    "this filing had one fewer exhibit" and "one exhibit had no text layer" stop
    being the same number.
    """
    from tests.test_dispatch import RecordingWriter

    writer = RecordingWriter()
    outcome: dict[str, Any] = parse_and_store(
        ACCESSION,
        pdf_bundle([[]]),
        parse_class="EIGHTK",
        cik10=CIK,
        form="8-K",
        writer=writer,
        archive_put=lambda key, data: None,
        apply=True,
    )
    exhibit = next(
        row for row in writer.rows_for("filing_documents") if str(row["filename"]).endswith(".pdf")
    )

    assert outcome["detail"]["pdfNoTextLayer"] == 1
    assert outcome["detail"]["pdfTextExtracted"] == 0
    assert exhibit["extractionStatus"] == "FAILED"
    assert (exhibit["textPath"], exhibit["textHash"], exhibit["textBytes"]) == (None, None, None)
