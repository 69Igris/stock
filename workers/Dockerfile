# ============================================
# StockBook Workers - Docker Image
# ============================================
# HTTP service that receives Pub/Sub push messages.
# Deployed as a GCP Cloud Run Service.
#
# Build (from monorepo root):
#   docker build -t gcr.io/stock-book-483718/stockbook-workers:latest -f workers/Dockerfile .
#
# Run:
#   docker run -p 8080:8080 --env-file workers/.env gcr.io/stock-book-483718/stockbook-workers:latest
# ============================================

# MONEY-1373 — node:22, not node:20. The Databento vendor stream is `.csv.zst`
# and we decode it with `node:zlib`'s `createZstdDecompress`, which does not
# exist before Node 22.15 — on node:20 the decoder is `undefined` and every
# harvested file fails to open, which reads as a bad download rather than a
# missing runtime. Local dev is already 22 (`.nvmrc`), so this closes a gap
# between what we develop against and what Cloud Run runs.
#
# `@firecrawl/pdf-inspector`'s musl prebuild is N-API, so it is ABI-stable
# across Node majors by construction — but that is a claim about a package.json
# field until an image runs it, so the bump was verified by building this
# Dockerfile and requiring the module inside it (MONEY-1373 A1).
FROM node:22-alpine AS builder

WORKDIR /app

# OpenSSL needed for Prisma to detect the correct engine binary target
RUN apk add --no-cache openssl

# Copy root package files
COPY package.json yarn.lock ./

# Copy workspace packages
COPY packages ./packages
COPY workers ./workers

# scripts/ is NOT app source — it is copied because workers/tsup.config.ts lists
# scripts/jobs/*.ts as extra entry points (MONEY-941). Those are Cloud Run JOBS
# (feed-backfill, feed-parse) that run for hours and so cannot be push workers,
# but they share this image: bundling them here means the runtime stage needs no
# TypeScript source and no tsx, only the dist/ it already copies.
COPY scripts ./scripts

# Skip Playwright's bundled-Chromium download during install (the
# @usemoney/video-studio postinstall would attempt it). The worker uses the
# system Chromium (apk) at runtime instead.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies
RUN yarn install --frozen-lockfile

# Generate Prisma client
WORKDIR /app/packages/database
RUN yarn db:generate

# Build workers (tsup bundles @stockbook/* workspace code, externalises npm packages)
WORKDIR /app/workers
RUN yarn build

# ============================================
# Production image
# ============================================
FROM node:22-alpine

WORKDIR /app

# openssl: Prisma query engine. chromium + ffmpeg + fonts: the
# @usemoney/video-studio render pipeline (Playwright screenshots + ffmpeg compose,
# used by /jobs/studio-render). font-noto-devanagari is required so Hindi
# (Devanagari) captions render instead of tofu; the brand Latin fonts come from
# the bundled @fontsource packages in node_modules.
RUN apk add --no-cache openssl chromium ffmpeg nss freetype harfbuzz ca-certificates \
      ttf-freefont font-noto font-noto-devanagari

# Copy built files and npm dependencies — PRESERVING yarn's on-disk layout.
#
# MONEY-1169: the previous version copied BOTH node_modules trees onto ONE
# path (`./node_modules` twice), overlay-merging them. Root node_modules has
# hoisted deps; workers/node_modules has packages yarn could NOT hoist due to
# version conflicts — and a version conflict is precisely a package that MUST
# NOT shadow the root copy. The merge promoted workers' node-fetch@3.3.2
# (nested there for gcp-metadata) to the top level, swapping the HTTP client
# underneath @google-cloud/storage's transports, which are written against
# node-fetch@2. Every multipart upload was then stored VERBATIM as object
# content (three months of silent corruption across feeds/ and stocks/), and
# the resumable path fails with "URL is required." from the same cause.
#
# Keeping dist under /app/workers with its own node_modules beside it restores
# the exact resolution chain yarn validated at install time:
#   /app/workers/dist -> /app/workers/node_modules -> /app/node_modules
# Conflicted versions stay scoped to the subtree that asked for them.
COPY --from=builder /app/workers/dist ./workers/dist
COPY --from=builder /app/workers/package.json ./workers/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/workers/node_modules ./workers/node_modules

# video-studio reads um-brand.css at runtime; tsup bundles the JS but not this
# asset, so copy it and point BRAND_CSS at it (below).
COPY --from=builder /app/packages/video-studio/src/brand/um-brand.css /app/video-studio/um-brand.css

# MONEY-1611 — gold. The `lake-gold` job (scripts/jobs/lake-gold.ts) runs the
# Dataform CLI over THIS copy of dataform/, so what it builds is exactly the
# SQL of the commit this image was built from: no Git connection, no token.
#
# The CLI comes from tools/dataform-cli's LOCKFILE via `npm ci`, so every
# transitive dependency is the one that was reviewed, not whatever the registry
# serves on build day. --ignore-scripts: nothing in the tree runs install code.
# That directory is not a yarn workspace; it exists for this line.
#
# The CLI `npm i`s @dataform/core into a temp copy of the project on EVERY
# compile, so that exact version is put in npm's cache here and the job runs
# npm OFFLINE against it (`npm_config_offline` in lake-gold.ts) — a miss is an
# error, never a run-time fetch. The cache is cleaned first so it holds core
# alone, not the CLI's tarballs. The lockfile's CLI and the cached core must
# equal `dataformCoreVersion` in dataform/workflow_settings.yaml;
# lake-gold-job.test.ts holds the three together.
#
# THE COMPILE IS THE SMOKE TEST, and it runs offline against that cache, for
# both envs: a project that does not compile, or a core version the cache
# lacks, fails THIS build rather than the 06:45 run. ~116 MB for the CLI.
COPY dataform ./dataform
COPY tools/dataform-cli ./tools/dataform-cli
ENV npm_config_cache=/app/.npm-cache
RUN cd /app/tools/dataform-cli \
    && npm ci --ignore-scripts --omit=dev \
    && ln -s /app/tools/dataform-cli/node_modules/.bin/dataform /usr/local/bin/dataform \
    && npm cache clean --force \
    && npm cache add @dataform/core@3.0.0 \
    && for GOLD_ENV in qa prod; do \
         NO_COLOR=1 npm_config_offline=true dataform compile /app/dataform \
           --vars=env=${GOLD_ENV} --default-schema=lake_gold_${GOLD_ENV} \
           --assertion-schema=lake_gold_${GOLD_ENV} --timeout=60s >/dev/null \
         || exit 1; \
       done

# Datadog version tag - passed from Cloud Build as the commit SHA
ARG DD_VERSION=unknown

# Set environment
ENV NODE_ENV=production
# MONEY-1530 — UTC, stated rather than inherited. ECMAScript resolves a
# date-only string like NSE's "08-Sep-2026" in the PROCESS'S LOCAL TIME, and
# that made one ex-date two instants on prod: 11,000 corporate_actions rows at
# 00:00Z from this image (UTC only because nothing set TZ) and 48,224 at 18:30Z
# from a laptop in IST, 1,772 events stored twice. The parser no longer
# depends on TZ; this pins the zone every other zoneless parse on this image
# already runs in, so a base-image change cannot move it. In the IMAGE, not the
# cloudbuild specs: they have almost no argument headroom left, and this also
# covers every Cloud Run JOB on this image, which inherits no service env block.
ENV TZ=UTC
ENV DD_TRACE_ENABLED=true
ENV DD_SERVICE=stockbook-workers
ENV DD_VERSION=${DD_VERSION}

# video-studio render config (Cloud Run /tmp is writable). MUSIC_DIR starts empty —
# licensed/royalty-free tracks must be baked in here or fetched at runtime (the
# W1–W5 reels reference music.track="corporate-lofi").
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    BRAND_CSS=/app/video-studio/um-brand.css \
    VIDEO_STUDIO_OUT=/tmp/video-out \
    MUSIC_DIR=/app/video-studio/music
RUN mkdir -p /app/video-studio/music /tmp/video-out

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the worker service from /app/workers so `dist/...` resolves the layout
# above. Cloud Run JOBS inherit this WORKDIR too, so their
# `--command=node,dist/feed-*.js` specs keep working unchanged.
WORKDIR /app/workers

# MONEY-1380 — `--import dd-trace/register.js` is what makes dd-trace able to
# see this bundle at all.
#
# tsup emits ESM (`format: ["esm"]`) and leaves every non-workspace dependency
# external, so `dist/index.js` carries real `import` statements for
# `@google/genai` and `@anthropic-ai/sdk`. dd-trace patches CommonJS through
# `require-in-the-middle`, which needs no flag — but it patches ESM through
# `import-in-the-middle`, which must be registered before the process loads
# anything. Without this flag every LLM call here is untraced, and so is Prisma,
# ioredis and the pubsub client. The symptom is not an error: LLM Observability
# is simply empty, which looks exactly like a feature nobody used.
#
# `register.js` ONLY installs the loader hook. Do NOT swap it for
# `initialize.mjs`, which also calls `tracer.init()` from the environment and
# would override the options `initTracer` resolves in code — profiling and
# runtime metrics among them.
#
# Deliberately NOT applied to the other two entry points on this image:
#   - `tiingo-realtime` overrides `command:` in both cloudbuild specs. It makes
#     no LLM call, and MONEY-1357 exists to keep that singleton event loop free.
#   - the Cloud Run JOBS pass `--command=node,dist/<job>.js` from their setup
#     scripts. This used to say "none of them calls a model either", which is
#     FALSE: `scripts/jobs/doc-ingest-backfill.ts` imports `@google/genai` and
#     constructs a client. It is harmless for a narrower reason — its only SDK
#     use is `client.batches.*`, and dd-trace's genai plugin instruments just
#     `generateContent`, `generateContentStream` and `embedContent`, so that
#     call produces NO LLM span to lose. A job that ever calls one of those
#     three would be invisible here: a job inherits neither this CMD nor the
#     service's DD_LLMOBS_ENABLED. `llmobs-wrap-coverage.test.ts` now scans
#     `scripts/jobs/` for exactly that.
# Both are pinned by packages/datadog/__tests__/llmobs-deploy-contract.test.ts.
CMD ["node", "--import", "dd-trace/register.js", "dist/index.js"]
