# us-fundamentals — SEC EDGAR ingestion service (MONEY-979)
#
# Build context is the SERVICE directory, not the repo root:
#   docker build -f services/us-fundamentals/Dockerfile services/us-fundamentals
# Nothing here imports from the TypeScript workspaces, so there is no reason to
# ship 2 GB of node_modules into the layer cache.

FROM python:3.12-slim

# ── Runtime environment ────────────────────────────────────────────────────
#
# EDGAR_LOCAL_DATA_DIR is the load-bearing one. edgartools CREATES its data
# directory AT IMPORT (`~/.edgar` by default) and Cloud Run's filesystem is
# READ-ONLY everywhere except /tmp — so without this the container dies on
# `import edgar` with a PermissionError, before any handler runs and before
# anything useful reaches the log. It is set here rather than in the Cloud Build
# spec so a `docker run` of this image behaves the same way.
#
# /tmp on Cloud Run is an in-memory tmpfs and counts against the container's
# memory limit. That is acceptable because this path holds edgartools' own
# bookkeeping, not filings: our archive lives in GCS and the SEC client streams.
ENV EDGAR_LOCAL_DATA_DIR=/tmp/edgar \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependency layer first, so a source-only change does not re-resolve the whole
# tree (edgartools pulls pandas + pyarrow; that resolve is minutes, not seconds).
COPY pyproject.toml constraints.txt README.md ./
# `-c constraints.txt` pins the whole closure. `pyproject.toml` carries FLOORS,
# so without it two builds of one commit can install different code — including
# a different `google-auth`, which is what validates every Pub/Sub push token.
RUN mkdir -p app && touch app/__init__.py && pip install --no-cache-dir -c constraints.txt .

# `app/` ONLY. The four Cloud Run jobs are `python -m app.bulk.<name>`, so every
# runnable entry point lives under this tree. `scripts/capture_fixtures.py` is
# deliberately NOT copied: it is a hand-run one-shot that makes ~10 SEC requests
# to record test fixtures, it is excluded from the image by .dockerignore's
# `tests/` sibling reasoning, and COPYing a directory another task owns would
# make THIS build fail the moment that task moves it.
COPY app ./app

# Reinstall so the package metadata matches the real source rather than the
# placeholder created above.
RUN pip install --no-cache-dir --no-deps .

# ── DD_VERSION is a property of the IMAGE ──────────────────────────────────
#
# Baked in with `--build-arg DD_VERSION=$COMMIT_SHA`, exactly as
# `workers/Dockerfile:93-99` does it, and NOT left to the deploy to supply.
#
# The SERVICE spec sets it too, and that is not redundancy — the two carry the
# same SHA because they are written by the same build. The five Cloud Run JOBS
# are the case that needs this: their env block is owned by
# `scripts/ops/setup-us-fundamentals-jobs.sh`, which runs at PROVISION time and
# never again, so a job's spec cannot carry the release's SHA. Without the ARG
# they report `settings.dd_version() == "unknown"` forever. With it, a job that
# drifted to a stale image reports the STALE SHA — which is the whole point:
# making DD_VERSION a property of the job SPEC is precisely the forge that would
# let a stale-pinned job report a fresh one (MONEY-1235).
ARG DD_VERSION=unknown
ENV DD_VERSION=${DD_VERSION}

# ── Non-root ───────────────────────────────────────────────────────────────
#
# Created AFTER the installs so the site-packages layer stays root-owned and
# read-only to the process. /tmp/edgar is pre-created and chowned because the
# library mkdirs it at import and a Cloud Run task starts with an empty /tmp.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin appuser \
    && mkdir -p /tmp/edgar \
    && chown -R appuser:appuser /tmp/edgar /app
USER appuser

EXPOSE 8080

# ── ddtrace-run: APM actually STARTS here (MONEY-979 / T19) ────────────────
#
# Both Cloud Build specs set DD_TRACE_ENABLED, DD_TRACE_AGENT_URL and run the
# `serverless-init` sidecar — but a plain `uvicorn` CMD never imports ddtrace,
# so no tracer was ever created. DogStatsD metrics worked the whole time
# (`app/store/outcome.py` writes UDP to localhost:8125, which the sidecar
# listens on), which is what made the gap invisible: the Datadog service page
# had data, just no traces. A spec that claims a capability the container does
# not have is the MONEY-1257 shape.
#
# `ddtrace-run` rather than `import ddtrace.auto` in main.py, for one reason
# that outlives whoever writes the next import:
#
#   ddtrace-run patches through a bootstrap `sitecustomize` BEFORE the
#   interpreter imports ANY application module, so it cannot miss a library.
#   The in-file form has to sit after `install_logging()` (which must be first,
#   or ddtrace's own startup warnings are logged unredacted) and before the
#   FIRST framework import (or `app = FastAPI(...)` is constructed against an
#   unpatched class and the app is silently untraced). That is a two-sided
#   ordering constraint enforced only by a comment, and the failure is silent in
#   both directions.
#
# MEASURED, this venv, 2026-08-29:
#   plain `python`      -> fastapi/httpx/pymongo `_datadog_patch` unset
#   `ddtrace-run python`-> all three `_datadog_patch=True`
#   boot cost           +0.45s warm (0.135s -> ~0.58s). The startup probe is a
#                        TCP check on the sidecar's port 5555 at 10s x 5, so
#                        half a second is not a factor.
#
# `--workers 1` keeps this a single process, so there is no fork for the
# bootstrap's PYTHONPATH to have to survive. ONE worker is also load-bearing on
# its own: Cloud Run scales by INSTANCE, and a second uvicorn worker inside the
# task would double this container's share of the SEC rate limit without the
# shared Redis limiter knowing — the limiter is keyed per fleet, not per
# process, and adding processes silently multiplies the request rate the fleet
# believes it is issuing.
#
# NOT covered here: the Cloud Run JOBS override this CMD with their own
# `--command` (`python -m app.bulk.<name>`) and have no Datadog sidecar to
# receive traces, so they stay metrics-only. They still get DD_VERSION from the
# ARG above.
CMD ["ddtrace-run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
