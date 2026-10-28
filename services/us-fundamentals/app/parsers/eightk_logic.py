"""8-K -> ``us_filing_documents``. PURE — no I/O, no clock.

The TEXT goes to GCS at ``edgar/text/{cik10}/{accession}/{seq}.txt``; the row
holds the pointer, the byte count, the sha256 and the extraction state. The hash
is what makes a reparse cheap: identical text writes NOTHING — not the object,
not the row — so an edgartools upgrade or a mapping bump can re-run the whole
8-K queue and only the documents that actually changed are touched.

``extractionStatus`` IS DECIDED AT WRITE TIME, and it used to be ``PENDING`` for
everything. That was defensible while it meant "the LLM extraction of KPIs and
guidance is out of scope"; what it produced was a column with ONE VALUE on 100%
of 5,377 prod rows (measured 2026-09-05), 3,296 of which already held text. A
column that cannot distinguish its own population measures nothing, and the one
thing an operator wants from it — how much of the queue is actually consumable —
was unanswerable.

So the three values below describe THE TEXT, which is the only thing this parser
knows, and never a downstream LLM stage that still does not exist:

* ``READY`` — text was extracted; the row points at it.
* ``FAILED`` — extraction produced nothing. A refillable gap, not a verdict on
  the document: a later parser version (MONEY-1350 added the PDF path) can turn
  one into a ``READY`` on the next reparse.
* ``PENDING`` — the model DEFAULT (``UsFilingDocumentRow.extractionStatus``), and
  now the never-processed value. No writer stamps it. Keeping it named rather
  than deleting it is what lets a legacy row and a freshly-decided one be told
  apart; ``scripts/backfill_extraction_status.py`` clears the legacy population.

The split is on the TEXT, not on the row's ``textPath``, because a dry run
assigns no path and its rows must still say what the extraction did.
``build_rows`` and the backfill therefore use two different discriminators for
the same fact — the backfill has only the stored row to look at, and its
docstring says so.

WHAT IS NOT A DOCUMENT. EDGAR inserts its own XBRL-viewer artefacts into the
disseminated submission — ``R1.htm``, ``report.css``, ``Show.js``,
``FilingSummary.xml``, ``MetaLinks.json``, the ``-xbrl.zip`` — each stamped
``<DESCRIPTION>IDEA: XBRL DOCUMENT``. They are neither exhibits nor content.
They are excluded by that MARKER rather than by an allow-list of the types we
happen to have seen, because a deny rule with an inclusive default lets a new
exhibit class (an EX-107 filing fee table, say) through, while an allow-list
silently drops it — the same "precision without a catch-all" trap that has cost
this repo coverage before.

IMAGES ARE THE SECOND REFUSAL, and they are refused rather than stored.
Measured on prod 2026-09-01: 3,054 rows in ``us_filing_documents``, 1,847 of
them (60%) ``documentType: "GRAPHIC"``, and ZERO of those 1,847 carrying a
``textPath``. That is not a backlog. An image has no text and never will, so
each one was stamped ``PENDING`` for an extractor that can do nothing with it,
and any backlog number measured over that queue was 60% noise.

REFUSED, not stored as ``UNSUPPORTED``, for three reasons in this order:

1. The row would carry nothing but identity. ``textPath`` / ``textBytes`` /
   ``textHash`` are null BY CONSTRUCTION for an image, and every other column
   of the table describes text.
2. The fact is not lost. The submission bundle is archived under ``edgar/``
   permanently, so "this 8-K had two image exhibits" stays re-derivable from
   bytes we already keep, at zero SEC requests. A row would be a second,
   lossier copy of a retained fact — and the refusal is now REPORTED per filing
   (``binaryMediaSkipped``) instead of being inferred from a smaller total.
3. An ``UNSUPPORTED`` row would not even stop the churn. :func:`text_is_unchanged`
   treats a null hash on either side as NOT unchanged — deliberately; see its
   docstring — and an image has no hash to compare, so EVERY reparse re-emits
   EVERY image row. Measured through this parser on the AAPL fixture: a reparse
   of a completely unchanged filing reported ``documentsUnchanged`` 7 of 9 and
   wrote 2 rows, both images. The queue's whole idempotence claim, "a reparse
   that changes nothing writes nothing", could not hold for any filing carrying
   an image. Refusing makes it true; stamping UNSUPPORTED would leave it false
   and add a status column to it.

The rule reads EDGAR's own TYPE — ``GRAPHIC``, from the vocabulary EDGAR
validates at acceptance — never the filename extension (filer-supplied free
text), and never whether text came out. That last one is the trap:
``eightk_from_bundle`` wraps ``attachment.text()`` in a bare ``except``, so "no
text" is ALSO what a real EX-99.1 looks like when the extractor threw. Refusing
on emptiness would drop that exhibit silently; refusing on TYPE drops only what
EDGAR itself calls an image, and the failed exhibit still lands with
``textPath: None`` — the visible, refillable gap ``build_rows`` exists to keep.

:data:`BINARY_MEDIA_TYPES` holds exactly ONE string and stays that way until a
second type is MEASURED in the table. A deny entry for a type nobody has seen
is untested code, and if that type does turn out to carry text it drops a real
exhibit — the allow-list failure, one direction over.

The two refusals are COUNTED SEPARATELY, and the split is a PARTITION: every
attachment lands in exactly one of storable / generated artefact / binary
media. One "skipped" number over two causes is the MONEY-1255 shape — a counter
that reads full while one of the things it counts is dark.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.parsers import SOURCE, as_datetime
from app.sec.adapter_types import EightKDoc, EightKMeta

#: EDGAR's own marker on every file its XBRL viewer generated. Matched
#: case-insensitively on the trimmed description and nothing else.
GENERATED_MARKER = "IDEA: XBRL DOCUMENT"

#: EDGAR's own document TYPES for binary media. ``GRAPHIC`` is what it stamps
#: on every image attachment (``aapl-20250927_g1.jpg`` in the 10-K fixture,
#: 1,847 rows on prod), and it is the only member because it is the only one
#: measured. See the module docstring for why this stays a measured set rather
#: than a guess at EDGAR's full binary vocabulary.
BINARY_MEDIA_TYPES: frozenset[str] = frozenset({"GRAPHIC"})

#: ``UsFilingDocument.extractionStatus``. See the module docstring for why the
#: parser now decides between the first two and stamps the third on nothing.
#: ``PENDING`` remains the MODEL DEFAULT and therefore the never-processed value.
EXTRACTION_READY = "READY"
EXTRACTION_FAILED = "FAILED"
EXTRACTION_PENDING = "PENDING"

#: Item 2.02 is the earnings release — the one item a reader routes on.
EARNINGS_ITEM = "2.02"

EIGHTK_FORMS: frozenset[str] = frozenset({"8-K", "8-K/A"})


def is_generated_artifact(doc: EightKDoc) -> bool:
    """True for a file EDGAR's viewer produced rather than the filer.

    Deny-listed, not allow-listed: everything else is kept.
    """
    return (doc.description or "").strip().upper() == GENERATED_MARKER


def is_binary_media(doc: EightKDoc) -> bool:
    """True for an attachment EDGAR itself types as binary media — an image.

    Keyed on EDGAR's TYPE. NOT on the filename extension, which is filer-supplied
    free text, and NOT on whether text was extracted, which is a property of OUR
    run: a real exhibit whose extraction threw looks identical from there, and
    refusing it would drop a document instead of recording a refillable gap.

    Deny-listed, not allow-listed: everything else is kept.
    """
    return (doc.document_type or "").strip().upper() in BINARY_MEDIA_TYPES


@dataclass(frozen=True, slots=True)
class DocumentTriage:
    """One walk, three buckets — a PARTITION of a submission's attachments.

    Every input document lands in exactly one field, so
    ``len(storable) + len(generated_artifacts) + len(binary_media)`` equals the
    input length: the two refusal counters cannot double-count a document or
    lose one between them.

    The buckets hold DOCUMENTS, not counts. A count is derivable from a bucket;
    a caller that wants to name the image it refused cannot recover it from an
    integer.
    """

    storable: tuple[EightKDoc, ...]
    generated_artifacts: tuple[EightKDoc, ...]
    binary_media: tuple[EightKDoc, ...]


def triage_documents(docs: Sequence[EightKDoc]) -> DocumentTriage:
    """Split a submission's attachments into what is kept and the two refusals.

    Rule ORDER is fixed, and it matters to exactly one number: a document that
    somehow satisfied both deny rules is counted as a generated artefact, which
    is the bucket ``generatedArtifactsSkipped`` has reported since this parser
    shipped. Reordering would silently move filings between two counters an
    operator reads.
    """
    storable: list[EightKDoc] = []
    generated: list[EightKDoc] = []
    binary: list[EightKDoc] = []
    for doc in docs:
        if is_generated_artifact(doc):
            generated.append(doc)
        elif is_binary_media(doc):
            binary.append(doc)
        else:
            storable.append(doc)
    return DocumentTriage(
        storable=tuple(storable),
        generated_artifacts=tuple(generated),
        binary_media=tuple(binary),
    )


def storable_documents(docs: Sequence[EightKDoc]) -> list[EightKDoc]:
    """The primary document and the exhibits, in filing order.

    A thin view over :func:`triage_documents` rather than a second walk holding
    a second copy of the rules — one rule stated twice is one rule that can
    disagree with itself. ``dispatch`` calls the triage directly, because it
    reports each refusal as its own count; this is the name for a caller that
    only needs what was kept.
    """
    return list(triage_documents(docs).storable)


def has_earnings_item(meta: EightKMeta) -> bool:
    """Item 2.02 present. Stored as an item number, never as a separate flag.

    ``UsFilingDocument.items`` already carries the numbers, so a boolean column
    would be a second copy of one fact that can disagree with the first.
    """
    return EARNINGS_ITEM in meta.items


def text_is_unchanged(existing_hash: str | None, doc: EightKDoc) -> bool:
    """True when a stored row already holds exactly this text.

    ``None`` on either side is NOT "unchanged". An absent stored hash means the
    row predates hashing or was never written, and a document whose text could
    not be extracted has no hash to compare — treating either as a match would
    skip the write that fills the gap, permanently.
    """
    return bool(existing_hash) and existing_hash == doc.text_hash


def build_rows(
    meta: EightKMeta,
    docs: Sequence[EightKDoc],
    *,
    accession: str,
    text_paths: Mapping[int, str],
    symbol: str | None = None,
    filed_at: date | datetime | None = None,
    parser_version: str,
) -> list[dict[str, Any]]:
    """One ``us_filing_documents`` document per stored exhibit.

    ``text_paths`` maps a document's SEQUENCE to the GCS key its text was
    written to. A sequence absent from the mapping stores ``textPath: None`` —
    which is what a document with no extractable text (a binary exhibit) or a
    dry run should look like. The pointer is never fabricated: a row claiming a
    key that holds no object is worse than a row admitting it has none, because
    the reader that follows it gets a 404 instead of a null.
    """
    filed = as_datetime(filed_at if filed_at is not None else meta.filed_at)
    if filed is None:
        raise ValueError(f"{accession}: 8-K has no filing date; refusing to invent one")

    items = list(meta.items)
    rows: list[dict[str, Any]] = []
    for doc in docs:
        rows.append(
            {
                "accession": accession,
                "sequence": doc.sequence,
                "cik10": meta.cik10,
                "symbol": symbol,
                "form": meta.form,
                "filedAt": filed,
                "items": items,
                "documentType": doc.document_type,
                "description": doc.description,
                "filename": doc.filename,
                "textPath": text_paths.get(doc.sequence),
                "textBytes": doc.text_bytes,
                "textHash": doc.text_hash,
                "extractionStatus": (EXTRACTION_READY if doc.text else EXTRACTION_FAILED),
                "source": SOURCE,
                "parserVersion": parser_version,
            }
        )
    return rows
