# Cloud Run Job image for the SCHEDULED prod->qa reference-data sync (MONEY-855).
#
# Base = google/cloud-sdk:slim (gcloud + `gcloud storage`, Debian 12) + the mongo
# CLIs + the sync script. Runs NON-INTERACTIVELY (--yes); ALL auth comes from the
# Cloud Run Job's service account via the metadata server — no keys in the image.
#
# Build context is the repo ROOT (so the Dockerfile can COPY the script):
#   gcloud builds submit --config=scripts/ops/sync-job/cloudbuild.yaml .
# (wired by scripts/ops/setup-sync-job.sh)
FROM google/cloud-sdk:slim

# ── WHAT THIS IMAGE DELIBERATELY DOES NOT HAVE: Node — MONEY-1238 ──
# The sync script's post-restore re-link (`relink_required`) used to shell out to
# `npx tsx scripts/ops/repair-instrument-links.ts --apply`. Neither half of that
# was ever here: this base has no Node, and the COPY below ships exactly ONE file.
# So the re-link failed on every scheduled run, and the script — which had no
# `exit` after its restore loop — reported SUCCEEDED anyway.
#
# It was NOT fixed by adding Node. That would mean the monorepo's node_modules
# (1.8 GB measured), a generated Prisma client and its platform-matched query
# engine, in an image that is otherwise a wget and a tar; and pre-bundling with
# esbuild does not avoid it, because @prisma/client is `external` in every
# bundler config in this repo (workers/tsup.config.ts explains why — dynamic
# require plus native binaries). The re-link is pure MongoDB, so it was rewritten
# to run on mongosh, which this image ALREADY installs and verifies below.
#
# Consequence to keep in mind when editing this file: mongosh is now LOAD-BEARING
# for correctness, not just for the empty-guard count. Removing or failing to
# install it does not merely lose a row count — it breaks the repair that keeps
# QA's screener, stock tabs and peers from throwing. `preflight()` in the script
# checks for it before anything is dropped, and
# packages/core/__tests__/market-data/sync-relink-required.test.ts asserts this
# image still ships the runtime the re-link invokes.

# Install mongodb-database-tools (mongodump/mongorestore) + mongosh (the
# empty-guard count AND the post-restore re-link) from VERSION-PINNED TARBALLS —
# deliberately NOT the MongoDB
# apt repo: its signing key carries a SHA1 binding signature that Debian's modern
# apt verifier (sqv/Sequoia) rejects since 2026-02-01, which breaks `apt-get
# update` (exit 100). The debian12 / linux-x64 binaries match the cloud-sdk:slim
# (Debian 12) base. Bump the versions here as needed.
ARG MONGO_TOOLS_VERSION=100.9.5
ARG MONGOSH_VERSION=2.3.1
# Pinned SHA256 of the published tarballs. We dropped the apt-repo signature check
# (its key uses a now-rejected SHA1 binding sig), so we MUST verify integrity here
# instead — this image runs with prod+qa DB creds + GCS access, so an unverified
# binary is a real supply-chain risk. `sha256sum -c` fails the build on any
# mismatch (tamper / wrong file / silent CDN change). Recompute + bump these when
# changing *_VERSION (the CDN has no .sha256 companion to fetch).
ARG MONGO_TOOLS_SHA256=49e46d4bbbb2cd4f6c284c23af4b79dfae19f584c02d223c47ee6f59445feefa
ARG MONGOSH_SHA256=f1fefacf0b5b1f2fca966200478fee1e278be2619df5e2605cbc0f24dd179a1a
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends wget ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    wget -qO /tmp/tools.tgz "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-${MONGO_TOOLS_VERSION}.tgz"; \
    echo "${MONGO_TOOLS_SHA256}  /tmp/tools.tgz" | sha256sum -c -; \
    wget -qO /tmp/mongosh.tgz "https://downloads.mongodb.com/compass/mongosh-${MONGOSH_VERSION}-linux-x64.tgz"; \
    echo "${MONGOSH_SHA256}  /tmp/mongosh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/tools.tgz -C /tmp; \
    cp /tmp/mongodb-database-tools-*/bin/* /usr/local/bin/; \
    tar -xzf /tmp/mongosh.tgz -C /tmp; \
    cp -r /tmp/mongosh-*/bin/* /usr/local/bin/; \
    rm -rf /tmp/tools.tgz /tmp/mongosh.tgz /tmp/mongodb-database-tools-* /tmp/mongosh-*; \
    mongodump --version | head -1; mongorestore --version | head -1; mongosh --version

WORKDIR /app
# ONE file, and that is the point: the script carries its own re-link (an
# embedded mongosh program) rather than shelling out to a sibling. A repair that
# lives in a second file is a repair that can be left out of the image, which is
# exactly how MONEY-1238 happened.
COPY scripts/ops/sync-prod-to-qa.sh /app/sync-prod-to-qa.sh
RUN chmod +x /app/sync-prod-to-qa.sh

# --yes = non-interactive (skip the confirmation prompt). Direction is hard-coded
# prod->qa inside the script. Override args on the Cloud Run Job (e.g.
# `--args=--collections-only`) for a partial run.
ENTRYPOINT ["/app/sync-prod-to-qa.sh"]
CMD ["--yes"]
