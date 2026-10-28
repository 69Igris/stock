/**
 * Read one bash array's body out of a shell script — MONEY-1405.
 *
 * Three tests sliced `setup-scheduler.sh` with
 *
 *     SCHED.slice(at, SCHED.indexOf(")", at))
 *
 * which reads to the first `)` ANYWHERE after the opening paren — including one
 * inside a COMMENT. MONEY-1404 added a comment to `OLD_SCHEDULER_PREFIXES`
 * mentioning `(mf.captnemo.in/kuvera)`, and that closing paren truncated the
 * slice twelve lines early. The test then reported that
 * `financial-data-sync-weekly` was missing from a list it was sitting in, which
 * is the worst possible direction for this particular assertion: it claims a
 * RETIRED scheduler is still live.
 *
 * A bash array closes on a line that is nothing but `)`, so that is what this
 * looks for. Prose inside the array cannot end it, and neither can a `)` in a
 * quoted element.
 *
 * Comments are STRIPPED rather than returned, because every caller is asking
 * "is this name an ELEMENT of the array" and a name mentioned in a comment is
 * not. Before this, `OLD_SCHEDULER_PREFIXES` could have satisfied its test with
 * the job named only in prose.
 */
export function bashArrayBody(src: string, name: string): string {
  const open = src.indexOf(`${name}=(`);
  if (open === -1) {
    throw new Error(
      `bashArrayBody: no array named ${name} — the script moved or was renamed, ` +
        `and a test that slices an empty string asserts nothing`,
    );
  }
  const from = src.indexOf("\n", open);
  if (from === -1) throw new Error(`bashArrayBody: ${name}=( is the last line`);

  const lines = src.slice(from + 1).split("\n");
  const end = lines.findIndex((l) => /^\s*\)\s*$/.test(l));
  if (end === -1) {
    throw new Error(`bashArrayBody: ${name} is never closed by a bare ")"`);
  }
  return lines
    .slice(0, end)
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
}
