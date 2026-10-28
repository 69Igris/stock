/**
 * The DECISION behind {@link noteFlagPresence} — should this absent-flag report
 * be spoken, given what has already been said? MONEY-1484.
 *
 * Pure, and separate from its caller for one concrete reason: the caller
 * carries `import "server-only"`, whose default export THROWS when it is loaded
 * outside a React Server Component. That is exactly what makes the anchor
 * useful — a client component importing it fails the build rather than shipping
 * process-global state and an internal ops command path to a browser — and it
 * also means a `node:test` file cannot import that module at all.
 *
 * So the branch lives here, where it can be EXECUTED by a test, and the module
 * that owns the console and the anchor stays a thin shell. Same split
 * `quotes-target` already uses: the predicate is tested in `packages/core`, the
 * server-only web wrapper is checked by a source scan.
 */

/**
 * Should `key` be reported now?
 *
 * @param key    the `PlatformConfig` key
 * @param absent true only when `getConfig` returned a row-shaped answer of
 *               `null`. NOT when a row exists whose value is false (a
 *               deliberate off is not a defect and must not be noise), and NOT
 *               when the read itself failed — the caller already logs that, and
 *               conflating them would report a Mongo blip as "never seeded".
 * @param seen   keys already reported in this process. MUTATED on a true
 *               result, so the caller cannot forget to record it.
 */
export function shouldReportFlagAbsence(
  key: string,
  absent: boolean,
  seen: Set<string>
): boolean {
  if (!absent) return false;
  // A PRESENT read must not consume the key's one report. Recording only on the
  // absent branch is what makes that hold: a row deleted after boot still gets
  // reported the first time it is observed missing.
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/**
 * What the operator is told. Kept beside the decision so the test can assert the
 * two things that make it actionable: it names the KEY, and it names the
 * command that fixes it.
 */
export function flagAbsenceMessage(key: string): string {
  return (
    `[platform-config] ${key} has NO ROW in this environment — resolving to ` +
    "OFF and using the legacy route. That is the safe default, but it is NOT " +
    "the same thing as a deliberate off: nothing has configured this " +
    "environment. Seed it with `npx tsx scripts/data/set-market-data-flags.ts " +
    "--env <qa|prod>` (read-only without --apply)."
  );
}
