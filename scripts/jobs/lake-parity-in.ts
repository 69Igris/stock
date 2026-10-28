/**
 * India bar parity: `lake_silver.price_bar_d1` vs Mongo `DailyPrice`.
 * MONEY-1497 (B2-IN step 5). READ-ONLY — it writes nothing, anywhere.
 *
 * ## THE COMPARISON MUST BE EXACT, AND THAT IS THE POINT
 *
 * Both sides are the SAME BYTES parsed by the SAME core parser: `feed-parse`
 * writes `DailyPrice` and `lake-replay-in` writes `price_bar_d1` from one
 * archived object through `parseUdiffBhavcopy` / `parseOldNseCmBhavcopy`. So
 * unlike the US chart-parity harness — which compares a tile against Yahoo and
 * needs a tolerance — a disagreement here is a MAPPING BUG, not rounding. There
 * is no tolerance to tune, and adding one would hide the only class of defect
 * this harness can find.
 *
 * ## A YAHOO-FILLED SESSION IS REPORTED, NOT FAILED
 *
 * `DailyPrice` is a MERGED table: `source: "BHAVCOPY"` where the exchange file
 * was parsed, `"YAHOO"` only where `yahoo-price-service` gap-filled a session
 * the exchange path never delivered (MONEY-1175, `mayWritePriceSource`). The
 * lake holds the exchange truth or a GAP — never Yahoo — so a session Mongo
 * sourced from Yahoo is expected to be absent from the lake. Counting it as a
 * failure would make the harness red on a healthy platform; counting it as a
 * match would let a real gap hide inside it. It gets its own bucket.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/lake-parity-in.ts --env qa
 *     npx tsx scripts/jobs/lake-parity-in.ts --env prod --listings 30 --dates 10
 *
 * Exits 1 on any unexplained disagreement, so it can gate a switchover.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { PrismaClient } from "@prisma/client";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";

const LAKE_REGION = "asia-south1";
const GCP_PROJECT = "stock-book-483718";

/**
 * Built from the URI `--env` resolves, NOT the import-time singleton —
 * MONEY-1523, the fourth job of MONEY-1514's class. `@usemoney/database`'s
 * `prisma` captures `DATABASE_URL` when it is IMPORTED, and `.env` is QA, so
 * `--env prod` compared the prod lake against QA's `DailyPrice` and reported
 * every difference between the two ENVIRONMENTS as a mapping bug.
 */
let prisma: PrismaClient;

/**
 * `DailyPrice.source` values that mean "the exchange file said so".
 *
 * `feed-parse` writes `BHAVCOPY_HIST` and `bhavcopy-sync` writes `BHAVCOPY`;
 * both rank 100 in `price-source-authority.ts`. Anything else is a gap fill.
 */
const EXCHANGE_SOURCES = new Set(["BHAVCOPY", "BHAVCOPY_HIST"]);

interface Args {
  env: "qa" | "prod";
  listings: number;
  dates: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };
  const env = val("--env");
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");
  return {
    env,
    listings: Number(val("--listings") ?? 30),
    dates: Number(val("--dates") ?? 10),
  };
}

interface LakeBar {
  listing_id: string;
  symbol: string;
  exchange: string;
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: string | null;
}

/**
 * Sample from the lake, not from Mongo.
 *
 * The harness exists to find rows the lake got WRONG, so the lake has to
 * nominate them. Sampling from Mongo instead would silently skip every listing
 * the replay failed to write at all — the loudest defect, invisible.
 *
 * `ORDER BY ... LIMIT` per listing rather than a global limit: a global one
 * returns whichever listing happens to sort first and compares thirty sessions
 * of one symbol instead of one session of thirty.
 */
async function sampleLake(args: Args): Promise<LakeBar[]> {
  const bq = new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION });
  const dataset = `lake_silver_${args.env}`;
  const [rows] = await bq.query({
    query: `
      WITH picked AS (
        SELECT listing_id
        FROM \`${GCP_PROJECT}.${dataset}.price_bar_d1\`
        WHERE market = 'IN'
        GROUP BY listing_id
        ORDER BY COUNT(*) DESC
        LIMIT @listings
      ),
      ranked AS (
        SELECT b.listing_id, b.symbol, b.exchange,
               FORMAT_DATE('%Y-%m-%d', b.session_date) AS session_date,
               b.open, b.high, b.low, b.close, b.volume,
               ROW_NUMBER() OVER (
                 PARTITION BY b.listing_id ORDER BY b.session_date DESC
               ) AS rn
        FROM \`${GCP_PROJECT}.${dataset}.price_bar_d1\` b
        JOIN picked p USING (listing_id)
        WHERE b.market = 'IN'
      )
      SELECT listing_id, symbol, exchange, session_date, open, high, low, close, volume
      FROM ranked WHERE rn <= @dates
      ORDER BY listing_id, session_date`,
    params: { listings: args.listings, dates: args.dates },
    types: { listings: "INT64", dates: "INT64" },
  });
  return rows as LakeBar[];
}

/** BigQuery hands NUMERIC back as a `Big`-like object, not a JS number. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(typeof v === "object" ? String(v) : v);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  // FIRST — before any client exists, so the Mongo side of the comparison is
  // the environment `--env` names and not whichever one the shell exported.
  const { databaseUrl } = pinJobEnv(args.env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const bars = await sampleLake(args);
  if (bars.length === 0) {
    // ZERO ROWS IS A FAILURE HERE, not a clean run. A parity harness that
    // compares nothing and exits 0 is the shape it exists to catch.
    throw new Error(
      `no market='IN' rows in lake_silver_${args.env}.price_bar_d1 — ` +
        `run lake-replay-in first`,
    );
  }

  const symbols = [...new Set(bars.map((b) => b.symbol))];
  const exchanges = [...new Set(bars.map((b) => b.exchange))];
  const instruments = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: symbols }, exchange: { in: exchanges } },
    select: { id: true, symbol: true, exchange: true },
  });
  const idBySymbol = new Map(
    instruments.map((i) => [`${i.symbol}:${i.exchange}`, i.id]),
  );

  const dates = [...new Set(bars.map((b) => b.session_date))].map(
    (d) => new Date(`${d}T00:00:00.000Z`),
  );
  const mongo = await prisma.dailyPrice.findMany({
    where: {
      instrumentId: { in: [...idBySymbol.values()] },
      date: { in: dates },
    },
    select: {
      instrumentId: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      source: true,
    },
  });
  const mongoByKey = new Map(
    mongo.map((r) => [
      `${r.instrumentId}\u0000${r.date.toISOString().slice(0, 10)}`,
      r,
    ]),
  );

  let matched = 0;
  let yahooFilled = 0;
  let noInstrument = 0;
  let mongoMissing = 0;
  const mismatches: string[] = [];

  for (const bar of bars) {
    const instrumentId = idBySymbol.get(`${bar.symbol}:${bar.exchange}`);
    if (!instrumentId) {
      // NOT a parity failure. `DailyPrice` keys on a Mongo ObjectId and drops
      // rows it cannot resolve; the lake keys on `{symbol}:{exchange}` and
      // keeps them. So the lake legitimately holds bars Mongo never received,
      // and counting those as mismatches would bury the real ones.
      noInstrument++;
      continue;
    }
    const m = mongoByKey.get(`${instrumentId}\u0000${bar.session_date}`);
    if (!m) {
      mongoMissing++;
      continue;
    }
    if (!EXCHANGE_SOURCES.has(m.source)) {
      yahooFilled++;
      continue;
    }

    const diffs: string[] = [];
    for (const f of ["open", "high", "low", "close"] as const) {
      const lakeValue = num(bar[f]);
      if (lakeValue !== m[f])
        diffs.push(`${f} lake=${lakeValue} mongo=${m[f]}`);
    }
    const lakeVol = bar.volume === null ? null : Number(bar.volume);
    if (lakeVol !== m.volume) {
      diffs.push(`volume lake=${lakeVol} mongo=${m.volume}`);
    }

    if (diffs.length === 0) matched++;
    else
      mismatches.push(
        `${bar.listing_id} ${bar.session_date}: ${diffs.join("; ")}`,
      );
  }

  console.log(`
lake-parity-in — ${args.env}
  compared          ${bars.length} lake bars (${symbols.length} listings)
  EXACT match       ${matched}
  mismatched        ${mismatches.length}
  yahoo-filled      ${yahooFilled}   (Mongo gap-fill; the lake has exchange truth or a gap)
  mongo missing     ${mongoMissing}  (lake ahead of DailyPrice)
  no instrument row ${noInstrument}  (lake keeps what DailyPrice's ObjectId key drops)
`);

  for (const line of mismatches.slice(0, 50)) console.log(`  MISMATCH ${line}`);
  if (mismatches.length > 50) {
    console.log(`  ... and ${mismatches.length - 50} more`);
  }

  if (mismatches.length > 0) {
    console.error(
      "\nBoth sides are the same bytes through the same parser, so a " +
        "disagreement is a MAPPING BUG. Fix the source; do not add a tolerance.",
    );
    process.exitCode = 1;
  }
}

guardCompletion("lake-parity-in", main())
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  // OPTIONAL CHAIN: `prisma` is assigned inside `main()`; a bad `--env` throws
  // before that, and an unguarded call would replace that error with a TypeError.
  .finally(() => void prisma?.$disconnect());
