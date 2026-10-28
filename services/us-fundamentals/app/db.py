"""MongoDB access — MONEY-979.

One process-wide :class:`~pymongo.MongoClient`, created lazily. pymongo's client
owns a connection POOL and is documented as safe to share, so creating one per
request would open a new pool per request and exhaust Atlas' connection limit
under the fan-out this service generates.

The database NAME comes out of ``DATABASE_URL`` rather than a second variable:
``mongodb+srv://user:pw@host/stockbook?retryWrites=true`` already names it, and a
second variable is a second copy of one fact that can disagree.
"""

from __future__ import annotations

import threading
from typing import Any
from urllib.parse import unquote, urlsplit

from app import settings
from app.logging_setup import log_error

_lock = threading.Lock()
_client: Any = None
_database: Any = None


def database_name_from_url(url: str) -> str | None:
    """Extract the database name from a Mongo connection string.

    Returns ``None`` when the URL carries no path segment, which is a real and
    silent misconfiguration: pymongo would then hand back the ``admin`` database
    and every write would land in the wrong place with no error.
    """
    path = urlsplit(url).path
    name = unquote(path.lstrip("/")).split("?")[0]
    return name or None


def get_client() -> Any:
    """The shared client, or ``None`` when ``DATABASE_URL`` is unset."""
    global _client
    if _client is not None:
        return _client
    url = settings.database_url()
    if not url:
        return None
    with _lock:
        if _client is None:
            from pymongo import MongoClient

            _client = MongoClient(
                url,
                # A health check must not hang a request for 30 s while the
                # driver retries server selection.
                serverSelectionTimeoutMS=5000,
                appname="us-fundamentals",
            )
    return _client


def get_database() -> Any:
    """The configured database handle, or ``None`` when unavailable."""
    global _database
    if _database is not None:
        return _database
    client = get_client()
    if client is None:
        return None
    url = settings.database_url() or ""
    name = database_name_from_url(url)
    if not name:
        log_error("DATABASE_URL names no database - refusing to default to `admin`")
        return None
    with _lock:
        if _database is None:
            _database = client[name]
    return _database


def ping() -> tuple[bool, str]:
    """``(ok, detail)``. Never raises — this backs ``/health``.

    "Could not determine" is its own value: an unset ``DATABASE_URL`` reports
    ``not_configured``, a live failure reports the exception TYPE. Collapsing
    both into ``False`` would let a service that was never given a URL look
    identical to one whose cluster is down.
    """
    database = get_database()
    if database is None:
        return False, "not_configured"
    try:
        database.command("ping")
        return True, "ok"
    except Exception as err:
        return False, type(err).__name__


def reset_for_tests() -> None:
    """Drop the cached client/database. Test-only."""
    global _client, _database
    with _lock:
        _client = None
        _database = None
