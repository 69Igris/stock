"""SEC access: one identified HTTP client, one shared rate budget, one archive.

Deliberately EMPTY of re-exports. A convenience barrel here would make
``from app.sec import ...`` pull in :mod:`app.sec.client` (and therefore httpx)
and :mod:`app.sec.archive` (and therefore google-cloud-storage) for a caller that
only wanted a pure key builder out of :mod:`app.sec.archive_logic` — which is
most callers, and every unit test. Import the module you need.

Layout:

* :mod:`app.sec.errors`        typed failures + the pure response classifier
* :mod:`app.sec.limiter`       the Redis-backed 9 req/s budget shared by every process
* :mod:`app.sec.client`        the only sec.gov fetcher
* :mod:`app.sec.archive_logic` PURE key builders + the gz-JSONL shard codec
* :mod:`app.sec.archive`       the GCS I/O around them
"""
