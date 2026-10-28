/**
 * The Mongo I/O the `corporate_actions` repairs share — MONEY-1530, MONEY-1535.
 *
 * Two scripts rewrite rows of one production table under the same safety
 * contract (backup first and counted back, compare-and-set writes, a consent
 * gate), so the machinery that enforces it exists ONCE. What each script
 * decides lives in its own `-logic.ts`; what it touches, and how carefully, is
 * here.
 *
 * Constructing the client is deliberately NOT here. Each script resolves
 * `--env` through `pinJobEnv` and builds its own `PrismaClient` from that URI,
 * in its own source, because `ops-script-db-target.test.ts` reads each
 * script's text to prove it does.
 */
import { createInterface } from "node:readline/promises";
import type { CliArgs } from "@usemoney/core/ops/cli-args";

/** A document or command exactly as `$runCommandRaw` speaks it: relaxed EJSON. */
export type RawDoc = Record<string, unknown>;
/** One `$runCommandRaw` call. */
export type Run = (command: RawDoc) => Promise<RawDoc>;
/** A compare-and-set write: applies only while `expect` still matches. */
export interface CasOp {
  id: string;
  expect: RawDoc;
  set: RawDoc;
}
export interface BackupEntry {
  id: string;
  role: string;
  doc: RawDoc;
  /** What the repair writes, when a field-level restore needs to recognise it. */
  wrote?: RawDoc;
}

/** Keyset page. `$runCommandRaw` has no `getMore`. ~2 MB at ~1 KB a row. */
const PAGE = 2_000;
/** Statements per write command. */
const CHUNK = 500;

export const fmt = (x: number): string => x.toLocaleString("en-US");
export const oid = (id: string): RawDoc => ({ $oid: id });
export const idOf = (doc: RawDoc): string => (doc._id as { $oid: string }).$oid;

/** Every document, keyset-paged on `_id` until a page comes back EMPTY. */
export async function readAll(run: Run, collection: string): Promise<RawDoc[]> {
  const out: RawDoc[] = [];
  let after: unknown = null;
  for (;;) {
    const res = await run({
      find: collection,
      filter: after === null ? {} : { _id: { $gt: after } },
      sort: { _id: 1 },
      limit: PAGE,
      batchSize: PAGE,
      singleBatch: true,
    });
    const batch =
      (res.cursor as { firstBatch?: RawDoc[] } | undefined)?.firstBatch ?? [];
    // Stop on EMPTY, not on short: a page the server cut at 16 MB is short and
    // not the last, and stopping there would plan against part of the table.
    if (batch.length === 0) return out;
    out.push(...batch);
    after = batch[batch.length - 1]!._id;
  }
}

/** The whole collection, refused unless the read matches the count. */
export async function readWhole(
  run: Run,
  collection: string,
): Promise<RawDoc[]> {
  const docs = await readAll(run, collection);
  const counted = Number((await run({ count: collection })).n);
  if (docs.length !== counted) {
    throw new Error(
      `read ${docs.length} of ${counted} ${collection} documents — refusing to ` +
        "plan against part of the table. A writer was running; re-run outside " +
        "04:30 IST (corporate-actions-sync).",
    );
  }
  return docs;
}

/** Throws unless every statement matched exactly one document. */
export function assertWrite(res: RawDoc, expected: number, what: string): void {
  const errors = res.writeErrors as unknown[] | undefined;
  if (res.ok !== 1 || (errors && errors.length > 0) || res.n !== expected) {
    throw new Error(
      `${what}: ${String(res.n)} of ${expected} statements applied` +
        (errors?.length ? `; first error ${JSON.stringify(errors[0])}` : "") +
        ". A row changed after the plan was read, or a key was already taken. " +
        "Nothing is lost — the backup was taken first — and running this again " +
        "re-plans from the current state.",
    );
  }
}

/** `$set` each op onto its row, only while the row still matches `expect`. */
export async function updateOps(
  run: Run,
  collection: string,
  ops: readonly CasOp[],
  what: string,
): Promise<void> {
  for (let i = 0; i < ops.length; i += CHUNK) {
    const slice = ops.slice(i, i + CHUNK);
    const res = await run({
      update: collection,
      updates: slice.map((op) => ({
        q: { _id: oid(op.id), ...op.expect },
        u: { $set: op.set },
      })),
      ordered: false,
    });
    assertWrite(res, slice.length, what);
  }
}

/** Delete each op's row, only while it still matches `expect`. */
export async function deleteOps(
  run: Run,
  collection: string,
  ops: readonly CasOp[],
  what: string,
): Promise<void> {
  for (let i = 0; i < ops.length; i += CHUNK) {
    const slice = ops.slice(i, i + CHUNK);
    const res = await run({
      delete: collection,
      deletes: slice.map((op) => ({
        q: { _id: oid(op.id), ...op.expect },
        limit: 1,
      })),
      ordered: false,
    });
    assertWrite(res, slice.length, what);
  }
}

/**
 * Copy every entry into `backupCollection`, then COUNT THEM BACK.
 *
 * Keyed on the row's own `_id` with `$setOnInsert`, so a re-run after a crash
 * never overwrites the ORIGINAL with a half-repaired copy. A copy nobody
 * counted is not a backup: this throws, before anything is modified, unless
 * every id is present.
 */
export async function backupVerified(
  run: Run,
  backupCollection: string,
  entries: readonly BackupEntry[],
): Promise<number> {
  const stamp = { $date: new Date().toISOString() };
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const res = await run({
      update: backupCollection,
      updates: slice.map((b) => ({
        q: { _id: oid(b.id) },
        u: {
          $setOnInsert: {
            doc: b.doc,
            role: b.role,
            backedUpAt: stamp,
            ...(b.wrote ? { wrote: b.wrote } : {}),
          },
        },
        upsert: true,
      })),
      ordered: false,
    });
    assertWrite(res, slice.length, "backup");
  }
  let held = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const res = await run({
      count: backupCollection,
      query: {
        _id: { $in: entries.slice(i, i + CHUNK).map((b) => oid(b.id)) },
      },
    });
    held += Number(res.n);
  }
  if (held !== entries.length) {
    throw new Error(
      `backup holds ${held} of ${entries.length} — nothing modified.`,
    );
  }
  return held;
}

/** Which of `ids` exist in `collection` now. */
export async function presentIds(
  run: Run,
  collection: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const res = await run({
      find: collection,
      filter: { _id: { $in: ids.slice(i, i + CHUNK).map(oid) } },
      projection: { _id: 1 },
      limit: CHUNK,
      batchSize: CHUNK,
      singleBatch: true,
    });
    const batch =
      (res.cursor as { firstBatch?: RawDoc[] } | undefined)?.firstBatch ?? [];
    for (const d of batch) present.add(idOf(d));
  }
  return present;
}

/**
 * `--yes` is the non-interactive consent; without it, a TTY prompt that
 * echoes the redacted target. An abort exits NON-ZERO: "the operator said no"
 * must not read as "step completed" to a wrapper's `&&`.
 */
export async function consent(
  args: CliArgs,
  target: string,
  change: string,
): Promise<void> {
  if (args.has("yes")) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\n  ${change}\n  target: ${target}\n  type "yes" to write: `,
  );
  rl.close();
  if (answer.trim() !== "yes") {
    console.log("Aborted — nothing written.");
    process.exit(1);
  }
}
