"""A local stand-in for sec.gov that RECORDS when each request arrived.

Used by the fair-access load test. It exists because the property under test —
"no more than 9 requests per second reach the host, across every process" — can
only be observed at the RECEIVING end. Measuring it in the client would measure
our own intentions.

**Never sec.gov.** The whole point of the load test is to fire ~800 requests as
fast as a shared budget allows; pointing that at the real host is precisely the
behaviour the limiter exists to prevent.

Timestamps are taken in the parent process (the server runs in a thread here),
so the multiprocessing workers need no IPC to report anything back.
"""

from __future__ import annotations

import threading
import time
from bisect import bisect_left
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import TracebackType


def max_in_window(stamps: list[float], seconds: float = 1.0) -> int:
    """The largest number of timestamps inside ANY sliding window of ``seconds``.

    Sliding, not bucketed, because that is the shape of the limit being enforced:
    ``RedisBucket``'s Lua counts ``ZCOUNT`` over ``now - interval`` to ``now`` on
    every insert, so the guarantee is about every window, not about wall-clock
    seconds. A fixed bucket would also split one burst across a boundary and
    report two innocent halves.

    Module-level so the same arithmetic covers server ARRIVALS and client
    ADMISSIONS; two implementations of one measure is how a load test ends up
    proving different things about each side.
    """
    ordered = sorted(stamps)
    best = 0
    for index, at in enumerate(ordered):
        end = bisect_left(ordered, at + seconds, index)
        best = max(best, end - index)
    return best


class _Recorder:
    """Arrival timestamps, shared by every handler thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.arrivals: list[float] = []

    def record(self) -> None:
        now = time.time()
        with self._lock:
            self.arrivals.append(now)

    def snapshot(self) -> list[float]:
        with self._lock:
            return sorted(self.arrivals)


class FakeSecServer:
    """A threaded HTTP server on 127.0.0.1 that answers instantly and counts.

    Answers instantly on purpose: any per-request latency of its own would blur
    the arrival histogram the assertion reads, and blur it in the direction that
    HIDES a violation.
    """

    def __init__(self, *, status: int = 200, body: bytes = b"ok") -> None:
        self._status = status
        self._body = body
        self._recorder = _Recorder()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self) -> None:
        recorder = self._recorder
        status = self._status
        body = self._body

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _respond(self, with_body: bool) -> None:
                recorder.record()
                self.send_response(status)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Last-Modified", "Fri, 29 Aug 2026 03:49:00 GMT")
                self.send_header("ETag", '"fake-etag"')
                self.end_headers()
                if with_body:
                    self.wfile.write(body)

            def do_GET(self) -> None:  # BaseHTTPRequestHandler names its own hooks
                self._respond(True)

            def do_HEAD(self) -> None:  # BaseHTTPRequestHandler names its own hooks
                self._respond(False)

            def log_message(self, *_args: object) -> None:
                """Silence. One line per request on stderr is 800 lines of noise."""

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, name="fake-sec", daemon=True)
        thread.start()
        self._server = server
        self._thread = thread

    def stop(self) -> None:
        """Shut down and JOIN. A test that leaves a server thread running is an orphan."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> FakeSecServer:
        self.start()
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _tb: TracebackType | None,
    ) -> None:
        self.stop()

    # ── observation ────────────────────────────────────────────────────────

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("server is not running")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def total(self) -> int:
        return len(self._recorder.arrivals)

    def arrivals(self) -> list[float]:
        return self._recorder.snapshot()

    def per_second_histogram(self, *, since: float | None = None) -> dict[int, int]:
        """Requests per FIXED one-second bucket, keyed by second-since-first-arrival.

        The reporting view. :meth:`max_in_any_window` is the one an assertion
        should use — a fixed bucket can split a burst across a boundary and
        report two innocent halves.
        """
        arrivals = self._recorder.snapshot()
        if since is not None:
            arrivals = [at for at in arrivals if at >= since]
        if not arrivals:
            return {}
        start = arrivals[0]
        histogram: dict[int, int] = {}
        for at in arrivals:
            bucket = int(at - start)
            histogram[bucket] = histogram.get(bucket, 0) + 1
        return histogram

    def max_in_any_window(self, seconds: float = 1.0, *, since: float | None = None) -> int:
        """Busiest sliding window over arrivals, optionally only those at/after ``since``."""
        arrivals = self._recorder.snapshot()
        if since is not None:
            arrivals = [at for at in arrivals if at >= since]
        return max_in_window(arrivals, seconds)
