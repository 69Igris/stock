import { Hono } from "hono";
import { getMessageId } from "../lib/message";

/**
 * RETIRED — MONEY-1404. Kept, and answers 200, deliberately.
 *
 * ## It could not write, in either environment, by construction
 *
 * Its only source was `https://mf.captnemo.in/kuvera/{ISIN}.json`, and that
 * endpoint is **dead** — 404 for every ISIN including captnemo's own documented
 * sample, re-verified 2026-08-18.
 *
 * But it never got as far as the 404. `fetchKuveraMetadata`
 * (`market-data/instruments/mf-metadata-provider.ts`) short-circuits to `null`
 * unless `MF_METADATA_PROVIDER === "kuvera"`, and BOTH cloudbuild specs set it
 * to `"amfi"` — the two providers are mutually exclusive by one env var, and
 * the one this job needs is not the one that is set. So every candidate fell
 * to `notFound++`, `written` was 0, and the job returned cleanly. Every Sunday,
 * in prod and QA, since MONEY-209.
 *
 * ## Why it looked healthy for so long
 *
 * `apply-monitors.sh` carried it as a `sparse` zero-write monitor with its own
 * recorded reason: the candidate query excludes anything that already has an
 * `expenseRatio`, so a drained queue legitimately reports 0 forever. That
 * exemption is correct for a working job and it also masked this one
 * completely — a guaranteed no-op and a finished backlog produce the identical
 * signal. MONEY-1238's defect class, one layer up: not a monitor watching the
 * wrong series, but a monitor whose "healthy" reading is indistinguishable from
 * the failure.
 *
 * ## What replaces it
 *
 * Nothing new is needed. `expenseRatio` is already carried by AMFI's own
 * monthly TER file, which `mf-metadata-weekly` fetches and parses through
 * `amfi-fund-metadata-provider.ts` — a primary source, from the regulator's own
 * publication, with 63.5% coverage measured 2026-08-18 against this job's zero.
 *
 * ## Why the ROUTE survives, and why it answers 200
 *
 * Same reasoning as `financial-data-sync` (MONEY-1220), and the pattern is
 * copied from it deliberately. The scheduler is removed from
 * `setup-scheduler.sh` AND added to its stale-delete list, but a scheduler is
 * live infrastructure rather than a file: until someone runs that script the
 * job keeps firing, and any message already on the topic keeps being delivered.
 * Deleting this route would make those deliveries 404 — a non-2xx, so Pub/Sub
 * NACKs and redelivers until `--max-delivery-attempts=5` parks the message on
 * the dead-letter topic. Five retries and a DLQ notification, weekly, for a job
 * retired on purpose.
 *
 * **200, not 410.** Pub/Sub acknowledges only on 102/200/201/202/204; every
 * other status, 410 emphatically included, is a NACK. The semantically-correct
 * "Gone" would produce exactly the retry storm this route exists to prevent.
 * The body carries the reason, which is what a human curling it needs; the
 * status code is for the transport, and the transport understands only
 * "consumed" or "try again".
 */
export const etfExpenseEnrichmentRoute = new Hono();

const RETIRED_MESSAGE =
  "etf-expense-enrichment is retired (MONEY-1404). Its only source " +
  "(mf.captnemo.in/kuvera) is dead, and it could not reach it anyway: " +
  "fetchKuveraMetadata returns null unless MF_METADATA_PROVIDER === 'kuvera' " +
  "and both specs set 'amfi', so the job was a guaranteed no-op in every " +
  "environment. expenseRatio now comes from AMFI's own monthly TER file via " +
  "/jobs/mf-metadata-sync.";

etfExpenseEnrichmentRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  console.warn(
    `[etf-expense-enrichment] RETIRED — dropping message ${getMessageId(body)}. ${RETIRED_MESSAGE}`,
  );
  // 200 = ACK. Consume and discard, rather than burning five delivery attempts
  // and a dead-letter notification on a job that was retired deliberately.
  return c.json({ success: true, retired: true, reason: RETIRED_MESSAGE });
});
