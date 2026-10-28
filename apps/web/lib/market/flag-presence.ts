import "server-only";

/**
 * A `PlatformConfig` row that was never seeded is indistinguishable, at every
 * reader, from one deliberately set to false. MONEY-1484.
 *
 * ## What this is for
 *
 * `getConfig` already answers in THREE states — `{data: null}` (no row),
 * `{data: {...}}` (a row, whatever its value), `{success: false}` (unreadable).
 * Three readers then collapse the first two into one `undefined` on their way
 * into a predicate:
 *
 *   quotes-target.ts     flagValue: flag.data?.value
 *   udf-target.ts        flagValue: res.data?.value
 *   market-data-token.ts flagValue: flag.success ? flag.data?.value : undefined
 *
 * Every one of those predicates is correct and must not change: anything that
 * is not an explicit literal TRUE is false, for the same reason the `*_APPLY`
 * env flags compare against a literal (`Boolean("false")` is `true`). The read
 * stays fail-safe. What was missing is that NOBODY COULD TELL the two apart at
 * runtime — an environment nobody had configured looked exactly like one
 * deliberately left on the legacy route, and QA sat that way while every chart
 * and quote quietly used `/api/market/quote`.
 *
 * That is the shape `MF_METADATA_PROVIDER` used to disable a job silently for
 * months (MONEY-1214), and the reason this repo's convention is that "absent"
 * and "explicitly off" are never one value.
 *
 * ## Why it only warns, and only once
 *
 * It does NOT change any decision — a missing row still resolves to off, which
 * is the safe answer and the one a fresh environment should get. It makes the
 * state SAYABLE.
 *
 * ## Why `server-only`
 *
 * Both importers (`quotes-target.ts`, `udf-target.ts`) carry it and the
 * extraction dropped it. Without the anchor a client component could pull this
 * in — directly or through a barrel — and bundle it for the browser with NO
 * error: `warned` would become per-TAB rather than per-process, so the dedupe
 * below silently stops working, and the message names an internal ops command
 * into a visitor's console. `server-only` turns that into a build failure.
 *
 * It also makes this module unimportable from `node:test` (the package's
 * default export throws outside a React Server Component), which is why the
 * DECISION lives in `flag-presence-logic.ts` and is tested there.
 *
 * Once per key per process, because these readers sit behind a 30s cache that
 * every page render can miss; an un-deduped warn would put a line in the log
 * for every render of every page in an environment that is merely unconfigured,
 * which is how a real signal gets filtered out. The Set is per-process state
 * about LOGGING only — never about the flag's value, which is re-read every
 * time (this repo's standing rule is to never cache a fail-open default).
 */
import {
  flagAbsenceMessage,
  shouldReportFlagAbsence,
} from "./flag-presence-logic";

const warned = new Set<string>();

/** Say so, once, when `key` has no row at all. See the module header. */
export function noteFlagPresence(key: string, absent: boolean): void {
  if (shouldReportFlagAbsence(key, absent, warned)) {
    console.warn(flagAbsenceMessage(key));
  }
}

/** Test seam — the report is once per process, so a suite needs a reset. */
export function resetFlagPresenceWarnings(): void {
  warned.clear();
}
