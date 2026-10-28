/**
 * Measure `document_embeddings`. MONEY-1471 (data-platform B0).
 *
 * READ-ONLY. B0 measures and decides; **B8 executes**. This script writes
 * nothing, deletes nothing, and creates no index.
 *
 * ## WHY
 *
 * S0 measured this collection at **50.8 GiB — 54% of the whole Atlas
 * footprint**: 5,555,213 docs, 12.0 KiB average, 5 indexes. The shape is the
 * cost, and it is two independent halves:
 *
 *   `content`    the chunk TEXT, stored inline
 *   `embedding`  768 `Float[]` as BSON doubles = **6,144 B per vector**
 *
 * Every option in the decision doc shrinks one half or the other, so the
 * measurement has to size them separately rather than report one total.
 *
 * ## WHY IT SAMPLES RATHER THAN SCANS
 *
 * 5.55M documents at 12 KiB is 50 GiB of reads. `$sample` over a declared size
 * gives every ratio the doc needs to two significant figures for the cost of a
 * few thousand documents, and every derived number is printed WITH its sample
 * size so a reader can tell an estimate from a census. The counts that must be
 * exact — totals, group sizes — come from `$group`, which reads the index.
 *
 * ## Usage
 *
 *   npx tsx scripts/ops/embeddings-profile.ts --env prod
 *   npx tsx scripts/ops/embeddings-profile.ts --env prod --sample 20000
 *   npx tsx scripts/ops/embeddings-profile.ts --env prod --census   # FULL SCAN
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const GCP_PROJECT = "stock-book-483718";

/** Sample size for the byte/duplication estimates. */
const DEFAULT_SAMPLE = 10_000;

/**
 * Wall-clock ceiling on every aggregation.
 *
 * Two minutes. Long enough for a `$sample` over 5.55M documents, short enough
 * that a pipeline which turns out to be a full scan is killed by the SERVER
 * rather than left running against production while somebody notices.
 */
const MAX_QUERY_MS = 120_000;

function parseArgs(): {
  env: "qa" | "prod" | null;
  sample: number;
  census: boolean;
} {
  const argv = process.argv.slice(2);
  const take = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = take("--env");
  if (env !== undefined && env !== "qa" && env !== "prod") {
    throw new Error("--env must be qa or prod");
  }
  const sample = Number(take("--sample") ?? DEFAULT_SAMPLE);
  if (!Number.isFinite(sample) || sample <= 0)
    throw new Error("--sample must be positive");
  return { env: env ?? null, sample, census: argv.includes("--census") };
}

function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/** Host only — `URL` keeps credentials in username/password, never in `host`. */
function maskedHost(uri: string): string {
  try {
    return new URL(uri).host || "?";
  } catch {
    const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    return (at >= 0 ? authority.slice(at + 1) : authority).trim() || "?";
  }
}

function pct(n: number, of: number): string {
  return of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

interface Agg {
  _id?: unknown;
  n?: unknown;
  meanBytes?: unknown;
  maxBytes?: unknown;
  minBytes?: unknown;
  dims?: unknown;
  extra?: unknown;
  groups?: unknown;
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const uri = args.env ? databaseUrlForEnv(args.env) : process.env.DATABASE_URL;
  if (!uri) throw new Error("pass --env <qa|prod> or set DATABASE_URL");

  const prisma = new PrismaClient({ datasources: { db: { url: uri } } });
  const raw = (cmd: Record<string, unknown>) =>
    prisma.$runCommandRaw(cmd as never) as unknown as Promise<
      Record<string, unknown>
    >;

  const agg = async (pipeline: unknown[]): Promise<Agg[]> => {
    const res = await raw({
      aggregate: "document_embeddings",
      pipeline,
      cursor: {},
      allowDiskUse: true,
      // BOUNDED. This runs against the PRODUCTION cluster that also serves
      // users, over 5.55M documents and 50.8 GiB. An unbounded aggregation
      // here is how a measurement becomes an incident — the first cut had
      // none, ran for twenty minutes, and had to be killed.
      maxTimeMS: MAX_QUERY_MS,
    });
    const cursor = res.cursor as
      | { firstBatch?: Agg[]; id?: unknown; ns?: string }
      | undefined;
    const rows: Agg[] = [...(cursor?.firstBatch ?? [])];

    // THE CURSOR IS DRAINED, not read as one batch.
    //
    // The first cut took `firstBatch` and warned when the cursor was not
    // exhausted — and then hit exactly that: a `$sample` of 2,000 returned 101
    // rows, so every byte statistic was computed from 101 documents while the
    // header claimed 2,000. Warning about a defect is not protection from it
    // (MONEY-1189, and MONEY-1196 for the same lesson).
    let cursorId = cursor?.id;
    const ns = cursor?.ns ?? "";
    const collection = ns.includes(".")
      ? ns.slice(ns.indexOf(".") + 1)
      : "document_embeddings";
    while (cursorId && String(cursorId) !== "0") {
      const more = await raw({
        getMore: cursorId,
        collection,
        batchSize: 1000,
        maxTimeMS: MAX_QUERY_MS,
      });
      const next = more.cursor as
        | { nextBatch?: Agg[]; id?: unknown }
        | undefined;
      rows.push(...(next?.nextBatch ?? []));
      cursorId = next?.id;
      // A pipeline that never exhausts would spin here; every one below is
      // bounded by `$sample`, `$limit`, or a low-cardinality `$group`.
      if ((next?.nextBatch ?? []).length === 0) break;
    }
    return rows;
  };

  try {
    console.log(
      `\ndocument_embeddings — ${args.env ?? "DATABASE_URL"} (${maskedHost(uri)})`,
    );
    console.log("READ-ONLY. B0 measures and decides; B8 executes.\n");

    /* ── 1. Size and shape ───────────────────────────────────────────── */
    const stats = await raw({ collStats: "document_embeddings", scale: 1 });
    const count = Number(stats.count ?? 0);
    const storage = Number(stats.storageSize ?? 0);
    const dataSize = Number(stats.size ?? 0);
    const indexSize = Number(stats.totalIndexSize ?? 0);
    console.log("── 1. size");
    console.log(`   documents      ${count.toLocaleString()}`);
    console.log(`   data           ${gib(dataSize)}`);
    console.log(`   storage        ${gib(storage)}`);
    console.log(`   indexes        ${gib(indexSize)}`);
    console.log(
      `   avg doc        ${(dataSize / Math.max(1, count) / 1024).toFixed(1)} KiB`,
    );

    /* ── 2. By docType — EXACT, and cheap because docType is INDEXED ──── */
    //
    // NOT a `$group`. `$group` over the whole collection is a full scan: the
    // first cut did exactly that and the server killed it at the 120s ceiling
    // on QA's 987k documents, never mind prod's 5.55M. `@@index([docType])`
    // exists, so `distinct` walks the index keys and each `count` is
    // index-only — exact numbers for a fraction of the work.
    console.log("\n── 2. by docType (EXACT, index-only)");
    const dtRes = await raw({
      distinct: "document_embeddings",
      key: "docType",
      maxTimeMS: MAX_QUERY_MS,
    });
    const docTypes = (dtRes.values as unknown[]) ?? [];
    for (const dt of docTypes) {
      const c = await raw({
        count: "document_embeddings",
        query: { docType: dt },
        maxTimeMS: MAX_QUERY_MS,
      });
      const n = Number(c.n ?? 0);
      console.log(
        `   ${String(dt ?? "(null)").padEnd(24)} ${n.toLocaleString().padStart(12)}  ${pct(n, count)}`,
      );
    }

    /* ── 3. By embeddingModel — SAMPLED, because it is NOT indexed ────── */
    console.log(
      `\n── 3. by embeddingModel (SAMPLED n=${args.sample.toLocaleString()}, proportions only)`,
    );
    const modelSample = await agg([
      { $sample: { size: args.sample } },
      { $group: { _id: "$embeddingModel", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    const sampled = modelSample.reduce((a, r) => a + Number(r.n ?? 0), 0);
    for (const r of modelSample) {
      const share = Number(r.n) / Math.max(1, sampled);
      console.log(
        `   ${String(r._id ?? "(null)").padEnd(28)} ${pct(Number(r.n), sampled).padStart(7)}  ` +
          `~${Math.round(share * count).toLocaleString()} docs`,
      );
    }
    console.log(
      "   (a projection from the sample — do not quote it as a census)",
    );

    /* ── 4. chunks per document — FULL SCAN, opt-in ──────────────────── */
    console.log("\n── 4. chunks per docId");
    if (args.census) {
      // `$limit 10` AFTER a `$sort` does not avoid the scan: the group still
      // reads every document. This was outside the flag in the first cut, which
      // made `--census` look like the only expensive path when it was not.
      const perDoc = await agg([
        { $group: { _id: "$docId", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 10 },
      ]);
      console.log("   top 10 by chunk count:");
      for (const r of perDoc) {
        console.log(
          `   ${String(r._id ?? "(null)")
            .slice(0, 30)
            .padEnd(32)} ${Number(r.n).toLocaleString()}`,
        );
      }
    }
    if (args.census) {
      // OPT-IN. `$group` over every docId is a FULL COLLECTION SCAN — 5.55M
      // documents, 50.8 GiB — on the cluster that serves the product. It is
      // the one number here that cannot be sampled, so it is available and
      // deliberate rather than on by default.
      const distinctDocs = await agg([
        { $group: { _id: "$docId" } },
        { $count: "n" },
      ]);
      const nDocs = Number(distinctDocs[0]?.n ?? 0);
      console.log(
        `   distinct docIds: ${nDocs.toLocaleString()} -> ` +
          `${(count / Math.max(1, nDocs)).toFixed(1)} chunks/doc avg (FULL SCAN)`,
      );
    } else {
      console.log(
        "   skipped — pass --census. Both numbers here need a FULL COLLECTION " +
          "SCAN of 5.55M documents on the cluster that serves the product.",
      );
    }

    /* ── 5. content bytes + duplication — AGGREGATED SERVER-SIDE ─────── */
    //
    // Every statistic here is computed by Mongo and returned as a HANDFUL of
    // rows. The first cut shipped the documents to the client, which was wrong
    // twice over: 768 floats per document is ~6 KiB of BSON sent purely to
    // call `.length` on it, and 3,000 of those blows past the 16 MiB reply cap
    // — so the reply was paged, the cursor id came back as a 64-bit Long that
    // JavaScript's Number rounds (`6900656456624420000`), and `getMore` then
    // failed with CursorNotFound. Aggregating server-side removes all three
    // problems rather than working around them.
    console.log(
      `\n── 5. content and vectors (SAMPLED n=${args.sample.toLocaleString()})`,
    );
    const shape = await agg([
      { $sample: { size: args.sample } },
      {
        $project: {
          _id: 0,
          bytes: { $strLenBytes: { $ifNull: ["$content", ""] } },
          dims: { $size: { $ifNull: ["$embedding", []] } },
        },
      },
      {
        $group: {
          _id: null,
          n: { $sum: 1 },
          meanBytes: { $avg: "$bytes" },
          maxBytes: { $max: "$bytes" },
          minBytes: { $min: "$bytes" },
          dims: { $addToSet: "$dims" },
        },
      },
    ]);
    const shp = shape[0] ?? {};
    const nSampled = Number(shp.n ?? 0);
    const meanLen = Number(shp.meanBytes ?? 0);
    console.log(`   n sampled      ${nSampled.toLocaleString()}`);
    console.log(`   content mean   ${meanLen.toFixed(0)} B`);
    console.log(
      `   min / max      ${Number(shp.minBytes ?? 0)} / ${Number(shp.maxBytes ?? 0)} B`,
    );
    console.log(
      `   vector dims    ${((shp.dims as number[]) ?? []).join(", ") || "none"}`,
    );

    // DUPLICATES, also server-side: group the sample by content and count the
    // groups with more than one member. One row back, not N.
    const dupRes = await agg([
      { $sample: { size: args.sample } },
      { $group: { _id: "$content", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      {
        $group: {
          _id: null,
          groups: { $sum: 1 },
          extra: { $sum: { $subtract: ["$n", 1] } },
        },
      },
    ]);
    const extra = Number(dupRes[0]?.extra ?? 0);
    console.log(
      `   exact dupes    ${extra.toLocaleString()} redundant of ${nSampled.toLocaleString()} ` +
        `(${pct(extra, nSampled)})`,
    );
    console.log(
      "   NOTE this is a LOWER BOUND, and a weak one: two copies among 5.55M rows " +
        "are unlikely to both be drawn into one sample. A real duplication census " +
        "needs the full scan B8 will do anyway.",
    );

    /* ── 6. the arithmetic the decision rests on ─────────────────────── */
    const observedDims =
      ((shp.dims as number[]) ?? []).find((d) => d > 0) ?? 768;
    const vectorBytes = observedDims * 8;
    console.log("\n── 6. the two halves, sized separately");
    console.log(
      `   vector half    ${gib(vectorBytes * count)}  (${observedDims} dims x 8 B BSON double)`,
    );
    console.log(
      `   content half   ${gib(meanLen * count)}  (mean x count, from the sample)`,
    );
    console.log(
      `   -> float32     ${gib((vectorBytes / 2) * count)}  (BinData, 2x)`,
    );
    console.log(
      `   -> int8        ${gib((vectorBytes / 8) * count)}  (quantized, 8x)`,
    );
    console.log(
      `   -> content out ${gib(200 * count)}  (pointer + 200-char preview)`,
    );

    /* ── 7. the Search index — the open question B8 is gated on ──────── */
    //
    // WHY THIS IS HERE. §5 of the decision doc recommends int8, and int8 is a
    // property of the INDEX, not of the collection: only a `vectorSearch`
    // index declares `quantization` per field. If this collection is served by
    // the LEGACY form — a `knnVector` field inside a classic `search` index —
    // then quantization is not available at all and B8's first step is an
    // index migration, which changes the recommendation rather than its size.
    //
    // `$listSearchIndexes` is a native aggregation stage, so it rides the
    // connection this script already has. The Atlas Admin API would answer the
    // same question for the price of a new key pair.
    console.log("\n── 7. search index (the B8 gate)");
    let searchIndexes: Agg[] | null = null;
    try {
      // MUST be the first stage of the pipeline.
      searchIndexes = await agg([{ $listSearchIndexes: {} }]);
    } catch (err) {
      // THREE STATES, NOT TWO. A failed call and an empty list are different
      // answers, and collapsing them is this repo's most expensive habit: an
      // empty list would be written down as "no quantization declared" and
      // read later as a measurement. `listFiles` fails open to `[]` for the
      // same reason, and a ledger built on that is worse than no ledger.
      console.log(
        `   DID NOT RUN    ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log(
        "   ^ this is NOT 'no index'. The question is UNANSWERED — do not record " +
          "a quantization verdict in the decision doc from this run.",
      );
    }

    if (searchIndexes !== null) {
      if (searchIndexes.length === 0) {
        console.log(
          "   none declared  — the collection has NO Atlas Search index",
        );
        console.log(
          "   ^ measured, not inferred: the stage ran and returned zero rows. If a " +
            "vector retrieval path works today it is not served from here.",
        );
      }
      for (const ix of searchIndexes) {
        const def = (ix.latestDefinition ?? {}) as Record<string, unknown>;
        const kind = String(ix.type ?? "search");
        console.log(
          `   ${String(ix.name)}  type=${kind} status=${String(ix.status ?? "?")} ` +
            `queryable=${String(ix.queryable ?? "?")}`,
        );

        // The modern form: `fields[]`, each vector field carrying its own
        // dimensions, similarity and quantization.
        const fields = Array.isArray(def.fields)
          ? (def.fields as Record<string, unknown>[])
          : [];
        for (const f of fields.filter((f) => f.type === "vector")) {
          // `quantization` ABSENT is Atlas's default, which is "none" — but it
          // is printed as `absent` rather than silently normalised, because
          // "the field does not declare it" and "the field declares none" are
          // answers to different questions when the next step is an edit.
          const q = Object.hasOwn(f, "quantization")
            ? String(f.quantization)
            : "absent (defaults to none)";
          console.log(
            `      vector ${String(f.path)}  dims=${String(f.numDimensions)} ` +
              `similarity=${String(f.similarity)} quantization=${q}`,
          );
        }

        // The LEGACY form: a `knnVector` inside `mappings.fields`. This is the
        // one that changes B8's plan, so it is named rather than left to the
        // reader to notice by the absence of the block above.
        const mappings = (def.mappings ?? {}) as Record<string, unknown>;
        const mapped = (mappings.fields ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const [path, spec] of Object.entries(mapped)) {
          const specs = Array.isArray(spec) ? spec : [spec];
          for (const sp of specs as Record<string, unknown>[]) {
            if (sp?.type !== "knnVector") continue;
            console.log(
              `      LEGACY knnVector ${path}  dims=${String(sp.dimensions)} ` +
                `similarity=${String(sp.similarity)}`,
            );
            console.log(
              "      ^ a knnVector inside a classic `search` index supports NO " +
                "quantization. B8 must migrate this to a `vectorSearch` index " +
                "BEFORE int8 is reachable at all.",
            );
          }
        }
      }
    }

    console.log(
      "\nEvery derived number above is the sample's, scaled. Quote it WITH the " +
        "sample size in the decision doc, and re-measure before B8 arms anything.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
