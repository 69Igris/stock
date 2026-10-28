/**
 * MONEY-1169 repair — strip the multipart upload envelope from corrupted GCS
 * objects, in place, restoring the original payload and intended metadata.
 *
 * ## Why this job exists
 *
 * For ~3 months every object written through `uploadFile` from the workers
 * image was stored with the SDK's multipart request body AS its content —
 * boundary lines, metadata JSON and all. That includes the entire `feeds/`
 * archive (23k+ exchange files) and the `stocks/` document tree (scraped
 * PDFs, annual reports). The real payload sits intact inside the envelope, so
 * the object is repairable WITHOUT re-fetching: zero exchange traffic, and
 * decades of history that may no longer be downloadable stay safe.
 *
 * ## MONEY-1315 — "the real payload" is not always real
 *
 * That paragraph said "every object is repairable" for two releases and it is
 * not true of the `stocks/` tree. An envelope faithfully preserves whatever the
 * writer handed it, and under `stocks/` the writer was handing it SEBI landing
 * and challenge pages: `--apply --prefixes=stocks/` ran to 30,000 objects and
 * reported `repaired=0 clean=29,666 failed=329`. Probing 60 of them by hand
 * gave 59 `payload is HTML`, 1 `pdf without %PDF magic`, 0 would-repair. The
 * envelope's own metadata part declares `"contentType":"text/html"`, so the
 * broken uploader was not hiding anything — the DOCUMENT was already wrong
 * before the envelope wrapped it. Two defects stacked.
 *
 * `repaired=0` was therefore right behaviour on a wrongly-labelled population,
 * and the two things that made it read as a mystery are both fixed here: the
 * audit now classifies the INNER payload (`envelope-data` vs `envelope-html`),
 * and the failure reasons STREAM rather than being withheld until the walk
 * finishes.
 *
 * ## MONEY-1322 / MONEY-1323 — the job was sized against its own worst case,
 * and the census promised work the job would not do
 *
 * Two defects, one root: a number stated in prose and enforced nowhere.
 *
 * MONEY-1322. `--concurrency` (default 12) x `--max-bytes` (default 100 MB) x
 * the live buffers per slot is multiple GB against a task sized 2Gi. The
 * mitigation was a sentence in `setup-feed-backfill-job.sh` ("lower
 * --concurrency for stocks/"), while the command that script PRINTED for an
 * operator to paste was a bare `--args="--apply"` — every default, widest
 * scope. The pool is now DERIVED at startup from the container's memory and the
 * ceiling (`deriveDownloadConcurrency`), and the derivation is LOGGED;
 * `--concurrency` is a cap the derivation may lower and never raise.
 *
 * MONEY-1323. `--apply --prefixes=stocks/` reported `repaired=0` against an
 * audit saying five objects were `envelope-data` — defined as "the payload
 * passes the same checks that gate `--apply`". Both were right and they
 * disagreed: all five exceed `--max-bytes`, and the repair skips on size BEFORE
 * the download. The audit now takes the ceiling as an argument and reports
 * `envelope-too-large` for exactly that population, so the census means what it
 * says. (A re-run at `--max-bytes=250000000` recovered them: `repaired=3`, and
 * `too-large` left the reason tally entirely.) The second half of that ticket
 * deleted this file's private copy of the magic-byte rules — see
 * `verifyPayload`.
 *
 * ## Safety properties
 *
 * - DRY-RUN BY DEFAULT. `--apply` is required to write anything.
 * - An object that does not START with an envelope is skipped untouched —
 *   which also makes the job idempotent and safe to re-run mid-way.
 * - The recovered payload must pass a magic-byte check for its type before it
 *   replaces the object; anything ambiguous is left alone and reported.
 * - Writes go through the FIXED `uploadFile` (resumable + CRC32C), so running
 *   this job on a still-broken write path would fail loudly rather than
 *   re-corrupt: the repair itself is a test of the fix.
 *
 * ## Usage
 *
 *   node --import tsx scripts/jobs/feed-repair.ts                    # dry-run, report only
 *   node --import tsx scripts/jobs/feed-repair.ts --apply            # repair in place
 *   node --import tsx scripts/jobs/feed-repair.ts --prefixes=feeds/  # limit scope
 *   node --import tsx scripts/jobs/feed-repair.ts --apply --prefixes=stocks/ \
 *       --max-bytes=250000000                     # reach the oversized PDFs
 *
 * `--concurrency` is a CAP. The pool actually used is derived from the task's
 * memory (`FEED_REPAIR_CONTAINER_MI`, written by setup-feed-backfill-job.sh)
 * and `--max-bytes`, and printed on the first lines of every run.
 *
 * ## --audit (MONEY-1204 / 14a.1)
 *
 * `--audit` is a STRICTLY READ-ONLY mode that answers the question this job
 * could not: "is anything still corrupt, and in which families?" It classifies
 * every object from a RANGED read of its first bytes plus the declared size —
 * no full download, no write, no `--apply` — and prints a per-family table.
 * Cheap enough to run against the whole prod bucket, which is the point: an
 * audit expensive enough that nobody runs it is indistinguishable from none.
 *
 *   node --import tsx scripts/jobs/feed-repair.ts --audit --prefixes=feeds/
 *   node --import tsx scripts/jobs/feed-repair.ts --audit --bucket=stockbook-content-prod
 *
 * `--audit` IGNORES `--apply`. The two are mutually exclusive by construction:
 * an audit that could write is not an audit.
 *
 * Its census separates `envelope-data` (repairable in place) from
 * `envelope-html` and `envelope-unknown` (NOT repairable — re-fetch, or eyes)
 * and, since MONEY-1323, from `envelope-too-large` (intact, but over the
 * `--max-bytes` this audit was run with, so `--apply` skips it before the
 * download). Only the FIRST is work `--apply` will do at that ceiling; treating
 * the whole `envelope` column as repairable is what MONEY-1315 corrected, and
 * treating the oversized slice as repairable is what MONEY-1323 corrected.
 *
 * `--audit` therefore reads `--max-bytes` too, and PRINTS it: the census is
 * relative to a ceiling, so a report that does not name the ceiling cannot be
 * checked against the run it predicts.
 *
 * Cloud Run (after the fixed image is deployed):
 *   gcloud run jobs execute feed-repair-prod --region=asia-south1 --args="--audit"
 *   gcloud run jobs execute feed-repair-prod --region=asia-south1 \
 *       --args="--apply,--prefixes=feeds/"
 */

import { Storage } from "@google-cloud/storage";
import { googleCredentials } from "@usemoney/core/gemini/credentials";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time; this prints
// the commit this process is actually running. See the module header.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  uploadFile,
  isMultipartEnvelope,
  stripMultipartEnvelope,
  classifyArchivedObject,
  classifyPayloadBytes,
  archiveFamilyOf,
  recordArchiveVerdict,
  emptyFamilyAudit,
  isEnvelopeVerdictKind,
  deriveDownloadConcurrency,
  parseContainerMi,
  DEFAULT_CONTAINER_MI,
  ARCHIVE_AUDIT_HEAD_BYTES,
  type ArchiveFamilyAudit,
  type ArchiveVerdictKind,
} from "@usemoney/storage";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

// ─── Args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const AUDIT = argv.includes("--audit");
// `--audit` wins outright. A read-only mode that can be silently upgraded to a
// writing one by a stray flag is not read-only.
const APPLY = !AUDIT && argv.includes("--apply");
const PREFIXES = (arg("prefixes") ?? "feeds/,stocks/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * A CAP, not the pool size — MONEY-1322.
 *
 * The pool actually used is derived at startup from the container's memory and
 * `--max-bytes` (see {@link resolveContainerMi} and the derivation logged by
 * `main`). The derivation may only LOWER this: 12 x 100 MB x 3 live buffers is
 * ~3.5 GB against a 2Gi task, and the mitigation used to be a sentence in the
 * provisioning script that the printed `--args="--apply"` command ignored.
 */
const REQUESTED_CONCURRENCY = Number(arg("concurrency") ?? 12) || 12;
const BUCKET = arg("bucket") ?? process.env.GCP_STORAGE_BUCKET;
/** Objects larger than this are reported, never auto-repaired. */
const MAX_BYTES = Number(arg("max-bytes") ?? 100 * 1024 * 1024);

const log = {
  info: (...a: unknown[]) => console.log("[feed-repair]", ...a),
  warn: (...a: unknown[]) => console.warn("[feed-repair]", ...a),
};

// ─── Payload verification ────────────────────────────────────────────

/**
 * Does this recovered payload deserve to replace the object?
 *
 * ## MONEY-1323 — ONE predicate, and it is not this function
 *
 * This used to restate the magic-byte rules that `classifyPayloadBytes` in
 * `@usemoney/storage` already holds, and the two copies had DRIFTED — silently,
 * and in the direction that flatters the census:
 *
 *   - the audit's `looksLikeHtml` matches `<?xml-stylesheet`; this copy matched
 *     only `<!doctype|html`. An XSL-styled page was `envelope-unknown`
 *     ("repair would refuse it") while the repair would have accepted it.
 *   - the audit has `.xls` / `.xlsx` and `.xml` branches; this copy had
 *     neither, so `envelope-unknown` on a bad workbook was again a claim about
 *     a refusal that would not have happened.
 *
 * Which makes the audit's own definition of `envelope-data` — "the payload
 * passes the same checks that gate `--apply`" — untrue for those extensions.
 * The fix is delegation, not a third rule: this function now keeps ONLY what is
 * genuinely its own (both properties of the STRIP, not of the payload) and asks
 * the classifier for the rest.
 *
 * The short `code` is preserved verbatim, because the streaming reason tally
 * buckets on it (`html=253 pdf-magic=1`) and a renamed code silently splits one
 * population into two rows.
 *
 * Anything that cannot be positively verified is left in place and counted —
 * a wrongly "repaired" object is strictly worse than a corrupt one, because
 * the corrupt shape is at least mechanically recoverable.
 */
function verifyPayload(
  key: string,
  contentType: string | undefined,
  payload: Buffer,
): { ok: true } | { ok: false; code: string; why: string } {
  if (payload.length === 0)
    return { ok: false, code: "empty-after-strip", why: "empty after strip" };
  if (isMultipartEnvelope(payload))
    return {
      ok: false,
      code: "still-envelope",
      why: "still an envelope after strip",
    };

  const verdict = classifyPayloadBytes(key, payload, contentType);
  return verdict.kind === "ok"
    ? { ok: true }
    : { ok: false, code: verdict.code, why: verdict.why };
}

/** Restore a sensible contentType when the envelope carried none. */
function contentTypeFor(key: string, fromEnvelope?: string): string {
  if (fromEnvelope) return fromEnvelope;
  const lower = key.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

// ─── Audit (read-only) ───────────────────────────────────────────────

/**
 * Walk the prefixes and classify every object WITHOUT downloading it whole.
 *
 * Uses a ranged read of the first {@link ARCHIVE_AUDIT_HEAD_BYTES} bytes. On
 * the 425,425 objects of `stockbook-content-prod` (325,086 under `feeds/`,
 * 100,339 under `stocks/`, measured 2026-09-01) a full download would move tens
 * of GB and take long enough
 * that the audit stops being run; the classifier is deliberately designed so
 * every verdict is decidable from the head plus the declared size — including,
 * since MONEY-1315, the verdict on the payload INSIDE a multipart envelope,
 * which the head window is sized to reach (measured payload offset: 209-239
 * bytes on prod).
 *
 * Writes nothing, ever. Its only side effects are log lines and the process
 * exit code.
 *
 * `concurrency` is derived by the caller (MONEY-1322) and is NOT the repair
 * walk's: this reads {@link ARCHIVE_AUDIT_HEAD_BYTES} per object, so its memory
 * cost is ~1 KiB a slot and there is no reason to shrink a 425,425-object,
 * latency-bound walk to fit a `--max-bytes` it never allocates.
 */
async function runAudit(
  bucket: import("@google-cloud/storage").Bucket,
  concurrency: number,
): Promise<void> {
  const families = new Map<string, ArchiveFamilyAudit>();
  let scanned = 0;
  let readErrors = 0;

  // MONEY-1315 open question: "is the envelope writer still live?" The list
  // response already carries `timeCreated` / `updated` for every object, so the
  // answer costs ZERO extra requests — it is a fold over bytes we have already
  // paid for. Tracked across the whole envelope FAMILY (data, html and
  // unknown alike), because the question is about the WRAPPER, not its payload.
  //
  // Read it with one caveat: overwriting a GCS object starts a new generation,
  // so a successful `--apply` moves BOTH stamps to the repair time. These
  // figures are the write time only for objects that have never been repaired,
  // which — since `--apply` has repaired nothing under `stocks/` — is all of
  // them today.
  const envelopeWindow = {
    count: 0,
    minCreated: "",
    maxCreated: "",
    maxCreatedKey: "",
    maxUpdated: "",
    maxUpdatedKey: "",
  };

  // The CEILING the envelope window is judged against. "No envelope newer than
  // date D" only means the writer stopped if something ELSE was written after
  // D — otherwise it means the whole tree went quiet and proves nothing. A
  // falsifiable check needs a verified ceiling, so the newest object in scope
  // is measured too, from the same free list metadata.
  const newest = { created: "", key: "" };

  for (const prefix of PREFIXES) {
    let pageToken: string | undefined;
    do {
      const [files, next] = (await bucket.getFiles({
        prefix,
        maxResults: 500,
        pageToken,
        autoPaginate: false,
      })) as unknown as [
        Array<import("@google-cloud/storage").File>,
        { pageToken?: string } | null,
      ];
      pageToken = next?.pageToken;

      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, files.length) },
          async () => {
            while (cursor < files.length) {
              const file = files[cursor++]!;
              const key = file.name;
              // A "directory" placeholder is not an object anyone parses.
              if (key.endsWith("/")) continue;

              const family = archiveFamilyOf(key);
              let tally = families.get(family);
              if (!tally) {
                tally = emptyFamilyAudit(family);
                families.set(family, tally);
              }

              const size = Number(file.metadata?.size ?? 0);
              let head = Buffer.alloc(0);
              if (size > 0) {
                try {
                  const [buf] = await file.download({
                    start: 0,
                    end: ARCHIVE_AUDIT_HEAD_BYTES - 1,
                  });
                  // Copy rather than alias: `file.download()` yields
                  // Buffer<ArrayBufferLike> while `Buffer.alloc` yields
                  // Buffer<ArrayBuffer>, and the two are not assignable under
                  // the Node 22 typings. At <=1KB the copy is free.
                  head = Buffer.from(buf);
                } catch (err) {
                  // A read failure is NOT a clean object. Counting it as `ok`
                  // would let a permissions or transport problem masquerade as a
                  // healthy archive — the precise shape of MONEY-1189.
                  readErrors++;
                  recordArchiveVerdict(tally, key, {
                    kind: "invalid",
                    why: `head read failed: ${err instanceof Error ? err.message : String(err)}`,
                  });
                  scanned++;
                  continue;
                }
              }

              // MONEY-1323: the ceiling is passed IN, so the census grades what
              // `--apply` would actually reach. Without it, five oversized but
              // intact `stocks/` PDFs counted as `envelope-data` — "repairable"
              // — while the repair skipped every one of them on size before the
              // download and reported `repaired=0`.
              const verdict = classifyArchivedObject({
                key,
                size,
                head,
                maxRepairBytes: MAX_BYTES,
              });
              recordArchiveVerdict(tally, key, verdict);
              const createdAll = String(file.metadata?.timeCreated ?? "");
              if (createdAll > newest.created) {
                newest.created = createdAll;
                newest.key = key;
              }
              if (isEnvelopeVerdictKind(verdict.kind)) {
                // ISO-8601 UTC stamps compare correctly as strings; "" sorts
                // below every real stamp, which is what makes the first
                // observation initialise both ends of the window.
                const created = String(file.metadata?.timeCreated ?? "");
                const updated = String(file.metadata?.updated ?? "");
                envelopeWindow.count++;
                if (created) {
                  if (
                    !envelopeWindow.minCreated ||
                    created < envelopeWindow.minCreated
                  )
                    envelopeWindow.minCreated = created;
                  if (created > envelopeWindow.maxCreated) {
                    envelopeWindow.maxCreated = created;
                    envelopeWindow.maxCreatedKey = key;
                  }
                }
                if (updated > envelopeWindow.maxUpdated) {
                  envelopeWindow.maxUpdated = updated;
                  envelopeWindow.maxUpdatedKey = key;
                }
              }
              scanned++;
            }
          },
        ),
      );

      // Same reasoning as the repair path's progress line (see
      // FailureReporter): a census whose shape only appears at the end is a
      // census nobody can act on while it runs. Folding a handful of family
      // tallies is free next to the ranged reads that produced them.
      if (scanned <= 5000 || scanned % 5000 < 500) {
        const live: Array<[ArchiveVerdictKind, number]> = (
          [
            "envelope-data",
            "envelope-too-large",
            "envelope-html",
            "envelope-unknown",
            "empty",
            "html",
            "invalid",
          ] as const
        ).map((k) => [k, [...families.values()].reduce((n, r) => n + r[k], 0)]);
        const shape = live
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}=${n}`)
          .join(" ");
        log.info(
          `audit progress: scanned=${scanned}` + (shape ? ` | ${shape}` : ""),
        );
      }
    } while (pageToken);
  }

  // ── report ────────────────────────────────────────────────────────
  const rows = [...families.values()].sort((a, b) =>
    a.family.localeCompare(b.family),
  );
  const bad = (t: ArchiveFamilyAudit): number =>
    t.empty +
    t["envelope-data"] +
    t["envelope-html"] +
    t["envelope-unknown"] +
    t["envelope-too-large"] +
    t.html +
    t.invalid;

  const w = Math.max(6, ...rows.map((r) => r.family.length));
  log.info("");
  log.info(
    `${"family".padEnd(w)}  ${"scanned".padStart(8)} ${"ok".padStart(8)} ` +
      `${"empty".padStart(7)} ${"env-data".padStart(9)} ${"env-big".padStart(8)} ` +
      `${"env-html".padStart(9)} ` +
      `${"env-unk".padStart(8)} ${"html".padStart(6)} ${"invalid".padStart(8)}`,
  );
  log.info("-".repeat(w + 79));
  for (const r of rows) {
    log.info(
      `${r.family.padEnd(w)}  ${String(r.scanned).padStart(8)} ${String(r.ok).padStart(8)} ` +
        `${String(r.empty).padStart(7)} ${String(r["envelope-data"]).padStart(9)} ` +
        `${String(r["envelope-too-large"]).padStart(8)} ` +
        `${String(r["envelope-html"]).padStart(9)} ${String(r["envelope-unknown"]).padStart(8)} ` +
        `${String(r.html).padStart(6)} ${String(r.invalid).padStart(8)}` +
        `${bad(r) > 0 ? "   <-- " : ""}`,
    );
  }

  const totals = rows.reduce(
    (a, r) => ({
      scanned: a.scanned + r.scanned,
      ok: a.ok + r.ok,
      empty: a.empty + r.empty,
      envelopeData: a.envelopeData + r["envelope-data"],
      envelopeTooLarge: a.envelopeTooLarge + r["envelope-too-large"],
      envelopeHtml: a.envelopeHtml + r["envelope-html"],
      envelopeUnknown: a.envelopeUnknown + r["envelope-unknown"],
      html: a.html + r.html,
      invalid: a.invalid + r.invalid,
    }),
    {
      scanned: 0,
      ok: 0,
      empty: 0,
      envelopeData: 0,
      envelopeTooLarge: 0,
      envelopeHtml: 0,
      envelopeUnknown: 0,
      html: 0,
      invalid: 0,
    },
  );
  log.info("");
  log.info(
    `AUDIT TOTALS: scanned=${totals.scanned} ok=${totals.ok} empty=${totals.empty} ` +
      `envelope-data=${totals.envelopeData} ` +
      `envelope-too-large=${totals.envelopeTooLarge} ` +
      `envelope-html=${totals.envelopeHtml} ` +
      `envelope-unknown=${totals.envelopeUnknown} html=${totals.html} ` +
      `invalid=${totals.invalid} readErrors=${readErrors}`,
  );
  log.info(
    "REPAIRABLE BY `--apply` = envelope-data ONLY. envelope-html is a MONEY-1169 " +
      "wrapper around the WRONG DOCUMENT (a SEBI/NSE challenge or landing page): " +
      "stripping it yields HTML, the repair refuses it, and the remedy is the " +
      "same re-fetch a bare `html` object needs. envelope-unknown is undetermined " +
      "and never auto-repaired. empty is a successful write of nothing — also a " +
      "re-fetch. Do not collapse these into one 'corrupt' number: that is exactly " +
      "how 14a.1 reported 1,076 objects as REPAIRABLE when ~98% of them were not " +
      "(MONEY-1315).",
  );
  if (totals.envelopeTooLarge > 0) {
    log.info(
      `envelope-too-large=${totals.envelopeTooLarge} is the FOURTH remedy class ` +
        `(MONEY-1323): the payload is intact and would pass every check, but the ` +
        `object exceeds the ${MAX_BYTES}B --max-bytes this audit was run with, so ` +
        `\`--apply\` skips it BEFORE the download and counts it \`tooLarge\`. These ` +
        `objects used to be reported as envelope-data, which is how an --apply run ` +
        `could report repaired=0 against a census promising five repairs. Remedy: ` +
        `re-run scoped, with a bigger ceiling — the pool derivation shrinks to ` +
        `match. e.g. --apply --prefixes=stocks/ --max-bytes=250000000`,
    );
  }

  // ── is the envelope writer still live? (MONEY-1315) ────────────────
  if (envelopeWindow.count === 0) {
    log.info(
      "ENVELOPE WRITER: no envelope-class objects in this scope — nothing to date.",
    );
  } else {
    log.info(
      `ENVELOPE WRITER: ${envelopeWindow.count} envelope-class objects, ` +
        `created ${envelopeWindow.minCreated || "?"} .. ${envelopeWindow.maxCreated || "?"} ` +
        `(newest: ${envelopeWindow.maxCreatedKey}); newest updated ` +
        `${envelopeWindow.maxUpdated || "?"} (${envelopeWindow.maxUpdatedKey}). ` +
        "A newest-created stamp that predates the MONEY-1169 fix deploy means the " +
        "writer is DEAD and this is a fixed backlog; a stamp after it means the " +
        "broken path is still producing envelopes and the repair would be endless.",
    );
  }
  log.info(
    `NEWEST OBJECT IN SCOPE: ${newest.created || "?"} (${newest.key || "-"}). ` +
      "Compare it with the envelope window above BEFORE concluding the writer " +
      "stopped: a quiet envelope stamp proves nothing if nothing else was " +
      "written either.",
  );

  for (const r of rows) {
    if (bad(r) === 0) continue;
    log.warn(`  ${r.family}:`);
    for (const e of r.examples) log.warn(`    [${e.kind}] ${e.key} — ${e.why}`);
  }

  // Scanning nothing means a wrong prefix/bucket or an auth failure. That must
  // never read as a clean archive.
  if (totals.scanned === 0) {
    log.warn("scanned 0 objects — wrong bucket/prefix, or auth failed");
    process.exitCode = 1;
    return;
  }
  // A finding is not a crash: exit 0 so this can run on a schedule, and let the
  // table be the signal. A read error IS a failure of the audit itself.
  if (readErrors > 0) process.exitCode = 1;
}

// ─── Failure reporting (MONEY-1315) ──────────────────────────────────

/**
 * Why the failure log STREAMS instead of buffering.
 *
 * This job used to push every failure reason into an array and print the first
 * 40 of them AFTER the whole walk. Against 425,425 objects that withholds the
 * single most useful signal for hours: `feed-repair --apply --prefixes=stocks/`
 * ran to 30,000 objects reporting `repaired=0 clean=29,666 failed=329`, and
 * "why did it repair nothing?" was a MYSTERY for the length of the run when it
 * was one log line away — every one of those 329 was `payload is HTML`, i.e. a
 * SEBI landing page that had been enveloped, which is not repairable and never
 * was (MONEY-1315).
 *
 * So: a running per-reason TALLY rides the progress line (the shape is visible
 * inside the first 500 objects), and the first {@link SAMPLES_PER_REASON}
 * failures of each DISTINCT reason print the moment they happen. The per-reason
 * cap is what makes that safe — one pathological class flooding the log would
 * bury the second, rarer class, which is the signal that actually needs a
 * human.
 */
const SAMPLES_PER_REASON = 3;

/**
 * Distinct reasons retained before the rest fold into `(other)`.
 *
 * `verifyPayload` emits a fixed six-code vocabulary, but a THROWN error's
 * message has unbounded cardinality — one distinct string per object is
 * entirely possible, and a per-reason tally that grows with the population is
 * a memory leak wearing a diagnostic's clothes. The cap bounds the map; digits
 * are collapsed to `#` first so `no such object: a/1234` and `.../5678` are
 * one reason and not two.
 */
const MAX_DISTINCT_REASONS = 60;

class FailureReporter {
  private readonly counts = new Map<string, number>();
  private readonly printed = new Map<string, number>();
  /** Bounded verbatim sample retained for the end-of-run summary. */
  readonly retained: string[] = [];
  private total = 0;

  /** Normalise a thrown error into a low-cardinality reason code. */
  static codeForError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg.replace(/\d+/g, "#").slice(0, 80)}`;
  }

  record(key: string, code: string, why: string): void {
    this.total++;
    const bucket = this.counts.has(code)
      ? code
      : this.counts.size < MAX_DISTINCT_REASONS
        ? code
        : "(other)";
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);

    const shown = this.printed.get(bucket) ?? 0;
    if (shown < SAMPLES_PER_REASON) {
      this.printed.set(bucket, shown + 1);
      log.warn(
        `  unrepaired [${bucket}] ${key} — ${why}` +
          (shown + 1 === SAMPLES_PER_REASON
            ? `  (further [${bucket}] failures counted, not printed)`
            : ""),
      );
    }
    if (this.retained.length < 40) this.retained.push(`${key} (${why})`);
  }

  /** `html=253 pdf-magic=1`, commonest first — short enough for one line. */
  summary(limit = 8): string {
    const rows = [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
    const head = rows
      .slice(0, limit)
      .map(([code, n]) => `${code}=${n}`)
      .join(" ");
    return rows.length > limit
      ? `${head} (+${rows.length - limit} more reasons)`
      : head;
  }

  get count(): number {
    return this.total;
  }
}

// ─── Main ────────────────────────────────────────────────────────────

interface Tally {
  scanned: number;
  clean: number;
  repaired: number;
  tooLarge: number;
  failed: number;
  bytesRecovered: number;
}

/**
 * How much memory this task has, and WHERE that number came from — MONEY-1322.
 *
 * `FEED_REPAIR_CONTAINER_MI` is written by
 * `scripts/ops/setup-feed-backfill-job.sh` from the same `--memory` it passes to
 * `gcloud run jobs deploy`, so the two cannot drift. Precedent:
 * `DOC_CONVERT_CONTAINER_MI` (MONEY-1314).
 *
 * Three states, deliberately not two:
 *
 *   set + readable    use it.
 *   set + UNREADABLE  THROW. `FEED_REPAIR_CONTAINER_MI=2G` is a configuration
 *                     that looks applied; falling back would reinstate the very
 *                     overshoot the derivation exists to prevent, announced
 *                     only by a log line in a Cloud Run job nobody tails.
 *   absent            assume the provisioned default and SAY SO. This is the
 *                     laptop case and the not-yet-reprovisioned-job case; the
 *                     assumption is safe in both directions, because being
 *                     wrong high on a laptop only costs speed while being wrong
 *                     low on Cloud Run costs the task.
 */
function resolveContainerMi(): { mi: number; source: string } {
  const raw = process.env.FEED_REPAIR_CONTAINER_MI;
  const parsed = parseContainerMi(raw);
  return parsed === undefined
    ? {
        mi: DEFAULT_CONTAINER_MI,
        source:
          "ASSUMED (FEED_REPAIR_CONTAINER_MI unset — re-run setup-feed-backfill-job.sh to declare it)",
      }
    : { mi: parsed, source: `FEED_REPAIR_CONTAINER_MI=${raw}` };
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "feed-repair");

  if (!BUCKET) {
    throw new Error(
      "feed-repair: no bucket — set GCP_STORAGE_BUCKET or pass --bucket=",
    );
  }

  const storage = new Storage({
    ...googleCredentials(),
    projectId: process.env.GCP_PROJECT_ID,
  });
  const bucket = storage.bucket(BUCKET);

  // ── MONEY-1322: size the pool, then say how ──────────────────────────
  // Derived, logged, and applied to BOTH modes with the per-object ceiling each
  // one actually allocates. The audit's is ~1 KiB (a ranged head read), so its
  // derivation almost always leaves the requested pool intact — that asymmetry
  // is the point of passing the ceiling rather than hardcoding one number.
  const container = resolveContainerMi();
  log.info(`task memory: ${container.mi}MiB — source: ${container.source}`);

  if (AUDIT) {
    const auditPlan = deriveDownloadConcurrency({
      requested: REQUESTED_CONCURRENCY,
      containerMi: container.mi,
      maxBytes: ARCHIVE_AUDIT_HEAD_BYTES,
    });
    log.info(`audit pool: ${auditPlan.why}`);
    log.info(
      `bucket=${BUCKET} prefixes=${PREFIXES.join(",")} mode=AUDIT (read-only) ` +
        `maxRepairBytes=${MAX_BYTES} (the ceiling the census GRADES against — ` +
        `envelope-too-large is relative to it)`,
    );
    await runAudit(bucket, auditPlan.concurrency);
    return;
  }

  const repairPlan = deriveDownloadConcurrency({
    requested: REQUESTED_CONCURRENCY,
    containerMi: container.mi,
    maxBytes: MAX_BYTES,
  });
  log.info(`repair pool: ${repairPlan.why}`);
  if (!repairPlan.fitsWorstCase) {
    // Warn rather than refuse: one-at-a-time IS how the five oversized `stocks/`
    // PDFs get repaired, and a job that refuses to start cannot do that work at
    // all. The operator gets the arithmetic and the two levers.
    log.warn(
      "POOL DOES NOT FIT its own worst case even at concurrency=1 — a single " +
        "object at --max-bytes needs more than this task has. The run may be " +
        "OOM-KILLED mid-object, which on Cloud Run looks like a task that " +
        "vanished rather than a budget that was blown. Raise the task memory " +
        "(setup-feed-backfill-job.sh --repair-memory=) or lower --max-bytes.",
    );
  }
  const CONCURRENCY = repairPlan.concurrency;

  log.info(
    `bucket=${BUCKET} prefixes=${PREFIXES.join(",")} ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN (pass --apply to write)"}`,
  );

  const tally: Tally = {
    scanned: 0,
    clean: 0,
    repaired: 0,
    tooLarge: 0,
    failed: 0,
    bytesRecovered: 0,
  };
  const failures = new FailureReporter();

  for (const prefix of PREFIXES) {
    let pageToken: string | undefined;
    do {
      const [files, next] = (await bucket.getFiles({
        prefix,
        maxResults: 500,
        pageToken,
        autoPaginate: false,
      })) as unknown as [
        Array<import("@google-cloud/storage").File>,
        { pageToken?: string } | null,
      ];
      pageToken = next?.pageToken;

      // Small worker pool — enough parallelism to finish 23k objects in
      // minutes, small enough to stay far from any API quota.
      let cursor = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, files.length) },
          async () => {
            while (cursor < files.length) {
              const file = files[cursor++]!;
              tally.scanned++;

              try {
                const size = Number(file.metadata?.size ?? 0);
                if (size > MAX_BYTES) {
                  // MONEY-1323: this `continue` is why the audit has to know
                  // the ceiling. The object is never downloaded, so nothing
                  // here can tell whether its payload was intact — only the
                  // size-aware census can, and it calls this population
                  // `envelope-too-large` rather than `envelope-data`.
                  tally.tooLarge++;
                  failures.record(
                    file.name,
                    "too-large",
                    `too large: ${size}B > ${MAX_BYTES}B — re-run scoped with a ` +
                      `bigger --max-bytes (the pool derivation shrinks to match)`,
                  );
                  continue;
                }

                const [buf] = await file.download();
                const stripped = stripMultipartEnvelope(buf);
                if (!stripped) {
                  tally.clean++;
                  continue;
                }

                const check = verifyPayload(
                  file.name,
                  stripped.contentType,
                  stripped.payload,
                );
                if (!check.ok) {
                  tally.failed++;
                  failures.record(file.name, check.code, check.why);
                  continue;
                }

                if (APPLY) {
                  const idx = file.name.lastIndexOf("/");
                  await uploadFile({
                    file: stripped.payload,
                    fileName: idx === -1 ? file.name : file.name.slice(idx + 1),
                    ...(idx === -1 ? {} : { folder: file.name.slice(0, idx) }),
                    contentType: contentTypeFor(
                      file.name,
                      stripped.contentType,
                    ),
                    isPublic: false,
                    bucketName: BUCKET,
                    timeoutMs: 60_000,
                  });
                }
                tally.repaired++;
                tally.bytesRecovered += stripped.payload.length;
              } catch (err) {
                tally.failed++;
                failures.record(
                  file.name,
                  FailureReporter.codeForError(err),
                  err instanceof Error ? err.message : String(err),
                );
              }
            }
          },
        ),
      );

      // Every page for the first few, then every ~2,000. The early lines are
      // the point: the reason tally has to be readable inside the first
      // thousand objects, not at the end of a multi-hour walk.
      if (tally.scanned <= 2000 || tally.scanned % 2000 < 500) {
        log.info(
          `progress: scanned=${tally.scanned} repaired=${tally.repaired} ` +
            `clean=${tally.clean} failed=${tally.failed}` +
            (failures.count > 0 ? ` | reasons: ${failures.summary()}` : ""),
        );
      }
    } while (pageToken);
  }

  log.info(
    `DONE mode=${APPLY ? "APPLY" : "DRY-RUN"}: scanned=${tally.scanned} ` +
      `repaired=${tally.repaired} clean=${tally.clean} ` +
      `failed=${tally.failed} tooLarge=${tally.tooLarge} ` +
      `recovered=${(tally.bytesRecovered / 1048576).toFixed(1)}MB ` +
      `(concurrency=${CONCURRENCY} maxBytes=${MAX_BYTES})`,
  );
  if (tally.tooLarge > 0) {
    log.warn(
      `tooLarge=${tally.tooLarge} objects were SKIPPED BEFORE the download and ` +
        `are NOT failures of the repair — they are outside the ${MAX_BYTES}B ` +
        `ceiling this run carried.`,
    );
    // MONEY-1321 M14 — THIS IS NOT `envelope-too-large`, AND THE LINE ABOVE
    // USED TO SAY IT WAS.
    //
    // `tooLarge` is incremented from `size > MAX_BYTES` alone, before any
    // download, so it counts EVERY oversized object under the prefix —
    // envelope or not, intact or not. `--audit`'s `envelope-too-large` is a
    // strict SUBSET: `classifyArchivedObject` reaches that verdict only after
    // confirming the head carries a MONEY-1169 envelope AND that the payload
    // inside it is intact. Every large ordinary object — a bhavcopy zip, a
    // 200 MB annual report — lands in the first and cannot land in the second.
    //
    // Reading them as one population is expensive in a specific way: it says
    // "raise --max-bytes and re-run" about a set that is mostly not repairable,
    // so the operator re-downloads tens of GB to repair whatever small fraction
    // actually carries an envelope. The number to size that decision by is the
    // audit's, not this one.
    log.warn(
      `  Do NOT read this as repairable work. Run \`--audit --max-bytes ` +
        `${MAX_BYTES}\` and use its \`envelope-too-large\` count — that verdict ` +
        `is the SUBSET of these that carries a MONEY-1169 envelope over an ` +
        `INTACT payload, i.e. the only ones a bigger ceiling would actually ` +
        `repair. Everything else here is simply a big object (MONEY-1323/1321).`,
    );
  }
  if (failures.count > 0) {
    log.warn(`UNREPAIRED BY REASON: ${failures.summary(20)}`);
    for (const f of failures.retained) log.warn(`  unrepaired: ${f}`);
    if (failures.count > failures.retained.length)
      log.warn(`  ...and ${failures.count - failures.retained.length} more`);
    log.warn(
      "`html` here means the STORED DOCUMENT is a challenge/landing page that " +
        "was then enveloped — two defects stacked. The repair refusing it is " +
        "CORRECT; the remedy is a re-fetch, not `--apply`. See MONEY-1315.",
    );
  }

  // Nothing scanned means wrong prefix/bucket or an auth failure — never
  // success. Failures mean objects that still need eyes.
  if (tally.scanned === 0 || tally.failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("[feed-repair] failed:", err);
  process.exitCode = 1;
});
