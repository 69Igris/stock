# ============================================
# usemoney-market-data — Docker image
# ============================================
# The TradingView UDF datafeed, served from Cloud Run behind Cloud CDN.
#
# Build (from monorepo root):
#   docker build -t gcr.io/stock-book-483718/usemoney-market-data:latest \
#     -f apps/market-data/Dockerfile .
# ============================================

# node:22-alpine, matching workers. The repo's engines field allows 20, but the
# workers image is already 22 and a second Node major in the same estate is a
# difference that only shows up in the one place it breaks.
FROM node:22-alpine AS builder

WORKDIR /app

# Prisma needs OpenSSL to pick its engine binary target. This service reaches
# Mongo only for the readiness probe today, but A2 gives it real reads.
RUN apk add --no-cache openssl

COPY package.json yarn.lock ./
COPY packages ./packages
COPY apps/market-data ./apps/market-data
COPY scripts ./scripts

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN yarn install --frozen-lockfile

WORKDIR /app/packages/database
RUN yarn db:generate

WORKDIR /app/apps/market-data
RUN yarn build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/market-data/dist ./dist
COPY --from=builder /app/apps/market-data/package.json ./package.json

ENV NODE_ENV=production
# Cloud Run supplies PORT; this is only a documented default.
ENV PORT=8080
EXPOSE 8080

# `--import dd-trace/register.js` is what makes instrumentation work at all.
#
# tsup emits ESM with every non-workspace dependency external, so `dist/index.js`
# carries real `import` statements for hono, ioredis and the Mongo driver.
# dd-trace patches CommonJS through require-in-the-middle, which needs nothing,
# but patches ESM through import-in-the-middle, which must be REGISTERED before
# the process loads anything (MONEY-1380). Without this flag the service starts,
# serves traffic, and produces no spans — with no error anywhere.
#
# `register.js`, NOT `initialize.mjs`: the latter also calls `tracer.init()`
# from the environment, constructing a tracer before `initTracer` runs and
# overriding the options resolved in code.
CMD ["node", "--import", "dd-trace/register.js", "dist/index.js"]
