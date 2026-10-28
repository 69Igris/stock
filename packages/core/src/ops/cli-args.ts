/**
 * The strict argv parser for Cloud Run JOB scripts — MONEY-1373.
 *
 * ## Why this module exists, when three scripts already inline the same rules
 *
 * `parseTiingoCliArgs` lives as INLINED TEXT in three places
 * (`tiingo-us-backfill.ts`, `tiingo-us-corp-actions-backfill.ts`,
 * `tiingo-us-news-seed.ts`), between `tiingo-cli-args:begin/:end` markers, and
 * `tiingo-script-decisions.test.ts` extracts the region into a temp module to
 * EXECUTE it and asserts the three copies are byte-identical. Its stated reason
 * is that "these are standalone scripts with no shared local module".
 *
 * That reason has expired. Those scripts already import
 * `@usemoney/core/ops/backfill-outcome` and `@usemoney/core/ops/build-provenance`
 * — a shared module is exactly what they have. The byte-identical assertion is
 * a pairwise `assert.equal` over a HARDCODED THREE-ENTRY map, so a fourth copy
 * drifts silently: nothing compares it to anything.
 *
 * So the two Databento jobs and the probe import this instead of adding copies
 * four, five and six. The three Tiingo scripts are deliberately NOT migrated
 * here — that is a change to three production argv contracts with its own
 * review, and it does not belong in a ticket about a new vendor. What IS
 * enforced now is that no NEW script starts a copy: `cli-args.test.ts` scans
 * `scripts/` for the marker and fails on any file outside those three.
 *
 * ## The rules, and the defect behind each
 *
 * Every one of these was paid for. MONEY-1252 is the headline: a wrapper that
 * rewrote `--apply` as `--apply=true` had it silently ignored, and a 54-minute
 * "apply" run wrote nothing and exited 0.
 *
 *   - `--flag` or `--flag=value` ONLY. The SPACE form is refused, because
 *     `--limit 500` used to parse as no limit at all — i.e. every row. A parser
 *     whose failure mode is a BIGGER run is worse than no parser.
 *   - An unknown flag is fatal, not ignored. Ignoring one runs something other
 *     than what the operator asked for, and says nothing.
 *   - A repeated flag is fatal rather than last-wins.
 *   - An empty value is fatal: an absent `--symbols` or `--limit` means the
 *     whole population, so "" must not quietly become that.
 *   - A numeric flag is matched as a STRING against a positive-integer regex.
 *     `Number()` accepts `"1e3"`, `" 12 "`, `"0x10"` and `"Infinity"`, and the
 *     original `Number(x) || 0` turned every rejection into 0 — the sentinel
 *     for NO LIMIT. A regex is the only form in which "not a number" cannot
 *     become "everything".
 */

export interface CliSpec {
  /** Flags spelled exactly `--name`, never `--name=value`. */
  bare: readonly string[];
  /** Flags spelled exactly `--name=value`. */
  valued: readonly string[];
  /** A subset of `valued` that must be a positive integer. */
  numeric: readonly string[];
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface CliArgs {
  /** Was this BARE flag passed? */
  has(flag: string): boolean;
  /** A VALUED flag's value, or undefined when it was not passed. */
  value(flag: string): string | undefined;
  /** A NUMERIC flag's value, or `fallback` when it was not passed. */
  number(flag: string, fallback: number): number;
  /** Every occurrence of a REPEATABLE valued flag, in order. */
  all(flag: string): string[];
}

export function parseCliArgs(
  argv: readonly string[],
  spec: CliSpec & {
    /**
     * Valued flags that may appear more than once.
     *
     * The Tiingo parser has no such concept — it refuses every repeat — and
     * that is right for `--limit`. The harvest needs `--entry=` repeatable
     * because a manifest entry is a unit of purchase and an operator
     * legitimately runs two of them in one execution. Read through `all()`;
     * `value()` returns the first.
     */
    repeatable?: readonly string[];
  },
): CliArgs {
  const repeatable = new Set(spec.repeatable ?? []);
  const known = new Set([...spec.bare, ...spec.valued]);
  const usage =
    "Known flags: " +
    [
      ...spec.bare.map((f) => `--${f}`),
      ...spec.valued.map((f) => `--${f}=<value>`),
    ].join(" ") +
    ".";

  const flags = new Set<string>();
  const values = new Map<string, string[]>();

  for (const token of argv) {
    if (!token.startsWith("--")) {
      throw new CliError(
        `Unexpected argument "${token}". Every option is --flag or ` +
          "--flag=value; there are no positional arguments and the SPACE form " +
          'is not accepted, because "--limit 500" used to parse as no limit at ' +
          `all — i.e. every row. ${usage}`,
      );
    }

    const eq = token.indexOf("=");
    const name = (eq < 0 ? token : token.slice(0, eq)).slice(2);

    if (!known.has(name)) {
      throw new CliError(
        `Unknown flag "--${name}". Refusing to run rather than ignoring an ` +
          `option you believed was in effect. ${usage}`,
      );
    }
    const already = flags.has(name) || values.has(name);
    if (already && !repeatable.has(name)) {
      throw new CliError(
        `--${name} was given more than once. Refusing to guess which ` +
          "occurrence wins.",
      );
    }

    if (eq < 0) {
      if (!spec.bare.includes(name)) {
        throw new CliError(
          `--${name} requires a value and the SPACE form is not accepted. ` +
            `Use --${name}=<value>. A flag whose value was swallowed used to ` +
            `read as "not passed", which for --limit and --to means the WHOLE ` +
            `population. ${usage}`,
        );
      }
      flags.add(name);
      continue;
    }

    if (spec.bare.includes(name)) {
      throw new CliError(
        `--${name} is a BARE flag: spell it exactly "--${name}". "${token}" ` +
          "is not accepted. MONEY-1252 — a wrapper that rewrote --apply as " +
          '--apply=true had it silently ignored, and a 54-minute "apply" run ' +
          "wrote nothing and exited 0.",
      );
    }

    const raw = token.slice(eq + 1);
    if (raw.trim() === "") {
      throw new CliError(
        `--${name}= was given with an EMPTY value. Refusing rather than ` +
          "treating it as absent — an absent --symbols or --limit is the " +
          "whole population.",
      );
    }
    const bucket = values.get(name);
    if (bucket) bucket.push(raw);
    else values.set(name, [raw]);
  }

  for (const name of spec.numeric) {
    for (const raw of values.get(name) ?? []) {
      // A POSITIVE integer, matched on the STRING — see the module header for
      // why `Number()` cannot be trusted here.
      if (!/^[1-9]\d*$/.test(raw.trim())) {
        throw new CliError(
          `--${name}=${raw} is not a positive integer. Refusing to run: the ` +
            "old parser turned an unparseable value into 0, and 0 is the " +
            "sentinel for NO LIMIT — so a typo silently widened the run to " +
            "the entire population.",
        );
      }
    }
  }

  return {
    has: (flag) => flags.has(flag),
    value: (flag) => values.get(flag)?.[0],
    all: (flag) => [...(values.get(flag) ?? [])],
    number: (flag, fallback) => {
      const raw = values.get(flag)?.[0];
      return raw === undefined ? fallback : Number(raw.trim());
    },
  };
}

/**
 * Parse, or print the reason and exit 1 BEFORE any work starts.
 *
 * Module-scope in every caller, so a bad argument costs nothing: no database
 * connection, no vendor request, no money. The alternative — validating inside
 * `main()` — spends the boot before it refuses.
 */
export function parseCliArgsOrExit(
  argv: readonly string[],
  spec: Parameters<typeof parseCliArgs>[1],
  scriptName: string,
): CliArgs {
  try {
    return parseCliArgs(argv, spec);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`[${scriptName}] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
