"""The limiter's TRANSPORT: does `rediss://` work, and does a TLS failure classify? — MONEY-979 T21.

`tests/test_limiter.py` proves the limiter's LOGIC against a fake client and
`tests/test_limiter_load.py` proves its ARITHMETIC against a real Redis. Neither
touches the wire. This file is the third question, and it is the one with the
worst failure mode:

**DigitalOcean managed Redis is TLS-only (`rediss://`), and `app/sec/limiter.py`
FAILS CLOSED.** So a TLS problem is not a degradation — it is total SEC
ingestion failure, reported as a clean `LimiterUnavailable` by a module whose
docstring says failing closed is correct. Everything downstream looks healthy:
the job returns, the outcome line says `selected 0, written 0`, and a quiet
overnight run looks exactly the same.

Nothing else in this repo connects to that Redis from Python. The TypeScript
side uses **ioredis** (`packages/core/src/cache/redis.ts` is the only
`new Redis(...)` reachable from the app), so there is no precedent to copy and
no existing evidence that redis-py's defaults are the right ones. That is worth
stating rather than assuming: a Node client bundles its own CA list into the
binary, and CPython does not — it defers to OpenSSL's system trust store. The
two clients can therefore disagree about the SAME certificate on the SAME host,
and only one of them has ever been run against it.

## What is asserted here, and what cannot be

ASSERTED, by executing the real driver:
  * `rediss://` selects `SSLConnection` with certificate verification and
    hostname checking ON, from `from_url` with no extra kwargs.
  * A real TLS handshake failure is classified as `LimiterUnavailable` at
    install AND at acquire — it does not escape as a bare `ssl.SSLError` or a
    bare `redis.ConnectionError`.
  * The failure message names TLS, so a certificate problem is distinguishable
    from a down cluster.
  * Zero SEC requests are issued when the limiter is unavailable.

NOT ASSERTABLE from here, and deliberately not faked:
  * That the DEPLOYED container can complete a handshake with the real
    DigitalOcean endpoint. That needs the real cert, the real CA bundle and the
    real egress. The measurement already exists and costs nothing: `/health`
    calls `redis.Redis.from_url(REDIS_URL).ping()` and reports
    `redis.ok`. One GET against the first deployed revision settles it.
"""

from __future__ import annotations

import shutil
import socket
import ssl
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import redis
from redis.connection import Connection, SSLConnection, parse_url
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import RedisError

from app.sec.errors import LimiterUnavailable
from app.sec.limiter import (
    _redis_errors,
    describe,
    install_shared_limiter,
    reset_installed_limiter,
    try_acquire,
)

#: Long enough for a handshake to fail, short enough that a hung test is a
#: failing test rather than a stalled suite.
TIMEOUT_SECONDS = 5.0


@pytest.fixture(autouse=True)
def _forget_limiter() -> Iterator[None]:
    reset_installed_limiter()
    yield
    reset_installed_limiter()


# ── A server that is deliberately the WRONG kind ────────────────────────────


class _PlaintextServer:
    """Speaks plain (non-TLS) Redis on a real port.

    This is not an exotic scenario — it is the single most likely DigitalOcean
    misconfiguration. Managed Redis publishes a TLS port and, on some plans, a
    non-TLS one; pointing `rediss://` at the wrong number is a one-character
    mistake in a secret nobody reads. It also needs no certificate to
    reproduce, which is why it carries the unconditional assertions.
    """

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            try:
                conn.recv(4096)
                conn.sendall(b"+PONG\r\n")
            except OSError:
                pass
            finally:
                conn.close()

    def close(self) -> None:
        self.sock.close()


@pytest.fixture
def plaintext_server() -> Iterator[_PlaintextServer]:
    server = _PlaintextServer()
    try:
        yield server
    finally:
        server.close()


@pytest.fixture
def self_signed_tls_server(tmp_path: Path) -> Iterator[int]:
    """A REAL TLS server whose certificate no CA vouches for.

    The other half of the TLS failure space: the handshake gets far enough to
    exchange a certificate and then verification rejects it — which is what an
    expired DigitalOcean cert, a MITM proxy, or a container with an empty
    `/etc/ssl/certs` all look like from the client. `WRONG_VERSION_NUMBER`
    (the plaintext case) never reaches that code path.

    Skipped rather than faked when `openssl` is absent: a stub certificate
    would test the stub.
    """
    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("openssl is not on PATH; cannot mint a throwaway certificate")

    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    result = subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:prime256v1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
            "-days",
            "1",
            "-nodes",
            "-subj",
            "/CN=localhost",
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        pytest.skip("openssl could not mint a certificate")

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))

    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    port = listener.getsockname()[1]

    def serve() -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            try:
                # The client aborts here; that IS the scenario.
                with context.wrap_socket(conn, server_side=True) as tls:
                    tls.recv(4096)
                    tls.sendall(b"+PONG\r\n")
            except OSError:
                pass

    threading.Thread(target=serve, daemon=True).start()
    try:
        yield port
    finally:
        listener.close()


def _client(url: str) -> redis.Redis:
    """Built exactly as `limiter._connect` builds it — no extra kwargs."""
    return redis.Redis.from_url(
        url,
        socket_timeout=TIMEOUT_SECONDS,
        socket_connect_timeout=TIMEOUT_SECONDS,
        decode_responses=False,
    )


# ── 1. What `from_url` actually builds for `rediss://` ──────────────────────


def test_rediss_selects_an_SSL_connection_with_verification_ON() -> None:
    """The question T21 asks first: does `from_url` handle `rediss://` with no
    extra kwargs, and what SSL context does it build?

    Answered against the INSTALLED driver rather than its docs. redis-py 8.1.0
    `parse_url` maps the `rediss` scheme to `SSLConnection`, whose defaults are
    `ssl_cert_reqs="required"` and `ssl_check_hostname=True`. So the answer is
    yes AND it verifies — no `ssl_cert_reqs=none` is needed or wanted.

    `ca_certs is None` is the consequential half: `_wrap_socket_with_ssl` then
    calls `ssl.create_default_context()` and never `load_verify_locations`, so
    trust comes ENTIRELY from OpenSSL's system store. Python does not bundle a
    CA list the way Node does. A container without `ca-certificates` fails every
    handshake with `CERTIFICATE_VERIFY_FAILED` — configuration, not code, and
    invisible until it runs.
    """
    kwargs = parse_url("rediss://default:pw@example.db.ondigitalocean.com:25061/0")
    assert kwargs["connection_class"] is SSLConnection

    conn = SSLConnection(host="h", port=1)
    assert conn.cert_reqs == ssl.CERT_REQUIRED
    assert conn.check_hostname is True
    assert conn.ca_certs is None, "trust comes from the system store; see the docstring"


def test_plain_redis_does_NOT_get_an_SSL_connection() -> None:
    """The control. Without it the assertion above passes for a `parse_url` that
    returned `SSLConnection` for every scheme, which would be the same bug in the
    reassuring direction."""
    kwargs = parse_url("redis://example.com:6379/0")
    assert kwargs.get("connection_class", Connection) is not SSLConnection


# ── 2. A real TLS failure, classified rather than leaked ────────────────────


def test_a_TLS_handshake_failure_is_a_redis_ConnectionError_and_NOT_an_OSError(
    plaintext_server: _PlaintextServer,
) -> None:
    """The measurement `_redis_errors()` depends on, taken from the wire.

    `ssl.SSLError` IS an `OSError`, so the intuitive reading is that catching
    `OSError` is enough. It is not: redis-py catches the `SSLError` in
    `connect_check_health` and re-raises `redis.exceptions.ConnectionError`,
    whose only base is `RedisError`. Catching only `OSError` would let every TLS
    failure escape.
    """
    client = _client(f"rediss://127.0.0.1:{plaintext_server.port}/0")
    with pytest.raises(RedisConnectionError) as raised:
        client.ping()

    assert isinstance(raised.value, RedisError)
    assert not isinstance(raised.value, OSError), (
        "redis's ConnectionError is NOT an OSError — narrowing _redis_errors() to "
        "(OSError,) would let TLS failures escape the fail-closed contract"
    )
    assert isinstance(raised.value.__context__, ssl.SSLError)


def test_the_redis_error_tuple_covers_the_class_a_TLS_failure_ARRIVES_as(
    plaintext_server: _PlaintextServer,
) -> None:
    """Ties the tuple to the measured class instead of to a belief about it.

    MUTATION: change `_redis_errors()` to return `(OSError,)` — red here and in
    the acquire test below, green in every other limiter test.
    """
    client = _client(f"rediss://127.0.0.1:{plaintext_server.port}/0")
    with pytest.raises(Exception) as raised:  # the CLASS is what is being asserted, below
        client.ping()
    assert isinstance(raised.value, _redis_errors())


def test_a_TLS_failure_at_INSTALL_raises_LimiterUnavailable(
    plaintext_server: _PlaintextServer,
) -> None:
    """Fail CLOSED, with the right exception type, on the real wire.

    Not `ssl.SSLError`, not `redis.ConnectionError` — `LimiterUnavailable`, the
    one class every caller is written to handle. A leaked driver exception here
    would take the route to 500 and have Pub/Sub redeliver it five times into a
    limiter that is still broken.
    """
    with pytest.raises(LimiterUnavailable) as raised:
        install_shared_limiter(
            f"rediss://127.0.0.1:{plaintext_server.port}/0", 9, inject_edgartools=False
        )
    assert "TLS" in str(raised.value)


def test_the_failure_message_NAMES_the_TLS_reason(plaintext_server: _PlaintextServer) -> None:
    """A cert problem and a down cluster must not print the same sentence.

    Before this, both read `Redis unreachable at install: ConnectionError`. They
    have different fixes — one is "rotate the cert" or "install ca-certificates",
    the other is "the cluster is down" — and the wrong one costs an outage's
    worth of looking in the wrong place.
    """
    with pytest.raises(LimiterUnavailable) as raised:
        install_shared_limiter(
            f"rediss://127.0.0.1:{plaintext_server.port}/0", 9, inject_edgartools=False
        )
    message = str(raised.value)
    assert "TLS:WRONG_VERSION_NUMBER" in message
    # The whitelist: a type name and an OpenSSL reason token, nothing else. The
    # driver's own message carries the host:port and is exactly the kind of
    # rendered text this repo does not put in a log.
    assert "127.0.0.1" not in message


def test_a_CERTIFICATE_failure_is_classified_too(self_signed_tls_server: int) -> None:
    """The other half of the TLS space, and the half that matches the real risk.

    `WRONG_VERSION_NUMBER` never reaches certificate verification. This one does:
    a real handshake, a real certificate, and a real rejection — the shape of an
    expired DigitalOcean cert or a container with no CA bundle.
    """
    with pytest.raises(LimiterUnavailable) as raised:
        install_shared_limiter(
            f"rediss://127.0.0.1:{self_signed_tls_server}/0", 9, inject_edgartools=False
        )
    assert "TLS:" in str(raised.value)
    assert "CERTIFICATE_VERIFY_FAILED" in str(raised.value)


def test_a_TLS_failure_at_ACQUIRE_is_classified_not_leaked() -> None:
    """The install can succeed and the wire can fail later — a rotated
    certificate, a failover, a dropped pool connection.

    `try_acquire` must answer `LimiterUnavailable` then too. If the driver
    exception escaped, the caller's `except LimiterUnavailable` would miss it and
    the SEC request would be attempted on a budget nobody accounted for.
    """

    class TlsFailingBucket:
        rates: tuple[Any, ...] = ()

        def try_acquire(self, *_args: Any, **_kwargs: Any) -> bool:
            raise RedisConnectionError("Error 1 connecting to host:6379.") from ssl.SSLError(
                1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"
            )

    class LimiterLike:
        def __init__(self) -> None:
            self.bucket_factory = type("F", (), {"bucket": TlsFailingBucket()})()

        def try_acquire(self, *args: Any, **kwargs: Any) -> bool:
            return self.bucket_factory.bucket.try_acquire(*args, **kwargs)

    with pytest.raises(LimiterUnavailable) as raised:
        try_acquire(limiter=LimiterLike(), timeout=0.1)
    assert "at acquire" in str(raised.value)
    assert "TLS" in str(raised.value)


# ── 3. `describe()` on its own ──────────────────────────────────────────────


def test_describe_finds_a_TLS_cause_through_the_exception_chain() -> None:
    """redis-py re-raises inside an `except` block, so the SSLError lands in
    `__context__` rather than `__cause__`. Walking only `__cause__` would find
    nothing on the one path that matters."""
    inner = ssl.SSLError(1, "boom")
    inner.reason = "CERTIFICATE_VERIFY_FAILED"
    try:
        try:
            raise inner
        except ssl.SSLError:
            raise RedisConnectionError("wrapped") from None
    except RedisConnectionError as outer:
        # `from None` suppresses __cause__; __context__ still holds the SSLError.
        assert describe(outer) == "ConnectionError/TLS:CERTIFICATE_VERIFY_FAILED"


def test_describe_is_just_the_type_name_when_TLS_is_not_involved() -> None:
    """A down cluster must not be reported as a TLS problem — the same
    indistinguishability, pointed the other way."""
    assert describe(RedisConnectionError("connection refused")) == "ConnectionError"
    assert describe(TimeoutError("timed out")) == "TimeoutError"


def test_describe_terminates_on_a_self_referential_exception_chain() -> None:
    """A cycle in `__context__` is legal and a naive walk hangs on it. A limiter
    that hangs while diagnosing why it cannot reach Redis is worse than one that
    says the wrong thing: Pub/Sub redelivers a handler that overruns 600s."""
    first = RuntimeError("a")
    second = RuntimeError("b")
    first.__context__ = second
    second.__context__ = first
    assert describe(first) == "RuntimeError"


def test_describe_never_echoes_the_drivers_message() -> None:
    """The house rule, asserted rather than trusted: httpx and google-auth both
    put the credentialed request inside the exception, so a rendered message is
    not safe to log. A fixed vocabulary cannot leak one whatever a future driver
    decides to put in there."""
    leaky = RedisConnectionError("rediss://default:hunter2@db.ondigitalocean.com:25061")
    assert describe(leaky) == "ConnectionError"


# ── 4. Fail-closed reaches all the way to the SEC client ────────────────────


def test_no_SEC_REQUEST_is_MADE_when_the_limiter_cannot_reach_redis(
    plaintext_server: _PlaintextServer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The property the whole fail-closed design exists for, end to end.

    An unshared limiter is not a degraded run — it is every instance pacing at a
    virtuous-looking 9 req/s while the fleet issues 9N at SEC's edge, and the
    consequence lands days later as a block with nothing to attribute it to. So
    the assertion is on the SOCKET: zero connections attempted, not "an error was
    logged".
    """
    from app.sec.client import SecClient

    monkeypatch.setenv("EDGAR_IDENTITY", "UseMoney test@example.com")
    monkeypatch.setenv("SEC_EGRESS", "archive")

    with pytest.raises(LimiterUnavailable):
        install_shared_limiter(
            f"rediss://127.0.0.1:{plaintext_server.port}/0", 9, inject_edgartools=False
        )

    attempted: list[Any] = []
    real_connect = socket.socket.connect

    def spy(self: socket.socket, address: Any) -> Any:
        attempted.append(address)
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", spy)

    with SecClient.from_settings() as client, pytest.raises(LimiterUnavailable):
        client.get("https://www.sec.gov/Archives/edgar/data/320193/index.json")

    assert attempted == [], f"a SEC connection was attempted without a shared budget: {attempted}"


# ── 5. The numbers the connection-ceiling arithmetic rests on ───────────────


def test_the_pool_and_retry_defaults_the_ceiling_was_SIZED_FROM() -> None:
    """Pins the two driver defaults the DigitalOcean plan sizing was computed
    against, so an upgrade that changes either is visible instead of quietly
    invalidating the number in the runbook.

    `max_connections = 100` PER POOL is a ceiling, not a reservation — connections
    are created lazily and one process holds as many as it has simultaneous
    commands in flight. It matters because it is the WORST case a single runaway
    process can put on the cluster.

    `retries == 0` on connect is the other half, and it is the good news: a TLS
    failure fails on the first attempt rather than after three
    `socket_connect_timeout` waits, so a broken certificate surfaces in seconds
    instead of pushing a handler toward the 600s ack deadline.
    """
    pool = _client("rediss://example.com:25061/0").connection_pool
    assert pool.max_connections == 100
    assert pool.connection_class is SSLConnection

    conn = pool.connection_class(**pool.connection_kwargs)
    assert getattr(conn.retry, "_retries", None) == 0, (
        "redis-py now retries the connect; the T21 ceiling and the fail-fast "
        "argument both assumed it does not"
    )
    assert conn.socket_connect_timeout == TIMEOUT_SECONDS
