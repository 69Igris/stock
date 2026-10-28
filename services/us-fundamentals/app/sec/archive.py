"""GCS I/O for the SEC archive — MONEY-979. Every DECISION lives in ``archive_logic``.

This module is deliberately thin: connect, get, put, stream. It exists so that
one place in the service knows what a bucket is, and so the key builders and the
shard codec stay testable without one.

## A miss and a failure are different values

:func:`read_bytes` answers ``None`` for "not in the archive" and RAISES for
everything else. Conflating the two is how an archive-first client turns a
transient GCS permission error into a silent re-fetch from SEC — the fetch
succeeds, the run looks healthy, and the only evidence is a request count nobody
is watching. "Could not determine" is never the same value as "not there".

## Every shard write is a read-merge-write

A GCS put REPLACES the object. :func:`merge_and_write_shard` is the only
supported way to add rows to a shard, because a writer that encodes just the
rows it happens to hold destroys every other row in that shard and the put still
returns 200.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import IO, Any

from app import settings

from .archive_logic import (
    SHARD_CONTENT_TYPE,
    Row,
    ShardParse,
    encode_shard,
    merge_shard,
)
from .archive_logic import (
    decode_shard as decode_shard_bytes,
)

#: Raw filing bundles are SGML text. Stored with a charset so a browser or a
#: `gsutil cat` renders them instead of offering a download.
BUNDLE_CONTENT_TYPE = "text/plain; charset=utf-8"

#: Streaming chunk for the 1.3-1.5 GiB bulk zips. Cloud Run's /tmp is RAM, so
#: nothing is ever staged on disk; this is the resumable-upload window.
DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

_client: Any | None = None


class ArchiveUnavailable(RuntimeError):
    """No bucket is configured, so there is no archive to read or write.

    Raised rather than degraded-to-passthrough on purpose: without the archive,
    "archive-first" silently becomes "SEC every time", which is invisible from
    inside the process and expensive at SEC's edge.
    """


def storage_client() -> Any:
    """Process-wide GCS client, built on first use.

    Lazy because ``google-cloud-storage`` costs ~200 ms to import and half this
    service's unit tests never touch a bucket.
    """
    global _client
    if _client is None:
        from google.cloud import storage  # lazy: see the module docstring

        _client = storage.Client()
    return _client


def reset_storage_client() -> None:
    """Drop the cached client. Tests and forked workers only."""
    global _client
    _client = None


def bucket_name() -> str:
    name = settings.gcp_storage_bucket()
    if not name:
        raise ArchiveUnavailable(
            "GCP_STORAGE_BUCKET is not set; the SEC archive cannot be read or written"
        )
    return name


def _blob(key: str) -> Any:
    return storage_client().bucket(bucket_name()).blob(key)


def read_bytes(key: str) -> bytes | None:
    """Object bytes, or ``None`` when the object does not exist.

    Only a genuine 404 becomes ``None``; every other error propagates.
    """
    from google.cloud.exceptions import NotFound  # lazy: see the module docstring

    try:
        return _blob(key).download_as_bytes()
    except NotFound:
        return None


def exists(key: str) -> bool:
    return bool(_blob(key).exists())


def write_bytes(key: str, data: bytes, *, content_type: str) -> None:
    """Put an object. The content type is REQUIRED — there is no sensible default."""
    _blob(key).upload_from_string(data, content_type=content_type)


def open_blob_writer(
    key: str,
    *,
    content_type: str,
    chunk: int = DEFAULT_CHUNK_BYTES,
) -> IO[bytes]:
    """A binary file-like that streams straight into the object.

    The seam :meth:`app.sec.client.SecClient.stream_to_gcs` writes through, so a
    1.5 GiB zip never exists in memory or in tmpfs (which on Cloud Run is RAM and
    would count against the instance limit twice over).
    """
    blob = _blob(key)
    blob.chunk_size = chunk
    return blob.open("wb", content_type=content_type)


def read_shard(key: str) -> ShardParse | None:
    """Decode a cold shard, or ``None`` if it has never been written.

    A corrupt shard RAISES (:class:`~app.sec.archive_logic.ShardCorruptError`).
    It must not read as an empty one: the 13F evictor deletes hot rows only after
    re-reading what it archived, and "the shard decoded to zero rows" would make
    that check pass against nothing.
    """
    body = read_bytes(key)
    if body is None:
        return None
    return decode_shard_bytes(body)


def write_shard(
    key: str, rows: Sequence[Row], *, sort_key: Callable[[Row], str] | None = None
) -> int:
    """Replace a shard with exactly ``rows``. Returns the byte count written."""
    body = encode_shard(rows, sort_key=sort_key)
    write_bytes(key, body, content_type=SHARD_CONTENT_TYPE)
    return len(body)


def merge_and_write_shard(
    key: str,
    incoming: Sequence[Row],
    key_fn: Callable[[Row], str],
) -> dict[str, int]:
    """Read the shard, merge ``incoming`` over it, write it back.

    Returns ``{"existing", "incoming", "merged", "dropped", "bytes"}`` — the
    counters a job outcome needs, including the lines the existing shard could
    not parse, which would otherwise vanish in the rewrite.
    """
    current = read_shard(key)
    existing_rows: list[Row] = current.rows if current else []
    dropped = current.dropped if current else 0
    merged = merge_shard(existing_rows, incoming, key_fn)
    written = write_shard(key, merged, sort_key=key_fn)
    return {
        "existing": len(existing_rows),
        "incoming": len(incoming),
        "merged": len(merged),
        "dropped": dropped,
        "bytes": written,
    }
