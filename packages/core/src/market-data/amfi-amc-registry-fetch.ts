/**
 * The I/O half of `amfi-amc-registry.ts` — MONEY-1405 (D2).
 *
 * That module is 417 lines of parser with a committed fixture, a full test
 * suite, a barrel export and, until this file, **zero runtime callers**. It was
 * merged and never wired, which is the shape this repo has paid for before: a
 * capability that exists in the tree, is counted as shipped, and has never once
 * run against the live page it was written for.
 *
 * The split is the same one every feed here uses. The parser takes HTML and
 * returns records; this file owns the fetch, the archive and the one error type
 * a caller has to be able to distinguish. Nothing about the parser changes, so
 * its fixture stays the authority on the page's escaping.
 *
 * ## It goes through `getFeedAsset`, like every other scraped page
 *
 * `www.amfiindia.com` is in `FEED_HOSTS`, so a raw `fetch()` here would fail
 * `no-feed-fetch-bypass.test.ts` by file and line. That guard is right and this
 * feed is a good fit for it: the page is 240 KB of server-rendered HTML that
 * AMFI rewrites in place, so prod archives the bytes and QA replays them
 * instead of scraping AMFI a second time.
 *
 * **The descriptor carries NO `date`, deliberately.** The page is "the industry
 * as it stands now" — there is no as-of parameter and no dated URL — so it keys
 * under `current/` and overwrites each run, exactly like the instrument
 * masters. That also removes the mirror race the DATED feeds have: an undated
 * key is always present after the first prod run, so a QA replay at worst
 * serves yesterday's registry, which is what an undated feed means.
 *
 * ## `null` is not an outcome this function returns
 *
 * `parseAmfiAmcRegistry` returns `null` for an unrecognised page and NEVER `[]`,
 * so that "AMFI restructured the page" cannot be read as "AMFI lists no AMCs".
 * Preserving that distinction across the I/O boundary means throwing rather
 * than returning null: a caller that treats a fetch-shaped null as "no AMCs"
 * would log a healthy run over a dead parser, which is the same defect one
 * layer out. The NAV feed next door reached exactly that state and held it for
 * 26 nights (MONEY-1403).
 */

import { getFeedAsset } from "./feed-archive";
import {
  AMFI_AMC_REGISTRY_URL,
  parseAmfiAmcRegistry,
  type AmfiAmcRegistry,
} from "./amfi-amc-registry";

/** AMFI expects its own origin as the referer on the public site. */
const AMFI_REFERER = "https://www.amfiindia.com/";

/**
 * The registry could not be read — MONEY-1405.
 *
 * Distinct from a bare `Error` for the reason `AmfiNavGrammarError` is: a caller
 * has to tell "AMFI moved the page" apart from "the fetch failed" apart from
 * "we read it and it lists nobody", and only the first two are real. Thrown,
 * never returned, so no caller can accidentally treat an unreadable page as an
 * empty industry.
 */
export class AmfiAmcRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmfiAmcRegistryError";
  }
}

/**
 * Fetch AMFI's portfolio-disclosure page and parse it into AMC records.
 *
 * @throws {AmfiAmcRegistryError} on a transport failure, a 404, or a page whose
 * shape the parser no longer recognises. Never resolves to `null` or to an
 * empty registry.
 */
export async function fetchAmfiAmcRegistry(
  timeoutMs?: number,
): Promise<AmfiAmcRegistry> {
  const res = await getFeedAsset(
    AMFI_AMC_REGISTRY_URL,
    AMFI_REFERER,
    {
      exchange: "AMFI",
      feed: "amc-registry",
      // No `date`: see the header. Undated -> `current/`, overwritten in place.
      basename: "portfolio-disclosure.html",
    },
    undefined,
    timeoutMs === undefined ? undefined : { timeoutMs },
  ).catch((error: unknown) => {
    throw new AmfiAmcRegistryError(
      `Failed to fetch the AMFI AMC registry: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  if (res === null) {
    throw new AmfiAmcRegistryError(
      "Failed to fetch the AMFI AMC registry: 404 — AMFI serves this page " +
        "continuously, so a 404 means the URL moved, not that there is " +
        "nothing to read today.",
    );
  }

  const html = await res.text();
  const registry = parseAmfiAmcRegistry(html);
  if (registry === null) {
    throw new AmfiAmcRegistryError(
      `AMFI AMC registry UNRECOGNISED — the page shape changed. ` +
        `Read ${html.length} bytes from ${AMFI_AMC_REGISTRY_URL} and found no ` +
        `parseable "members" payload. The parser keys on the literal ` +
        `'"members":[' inside the Next.js RSC chunks; see ` +
        `amfi-amc-registry.ts. This is a parse failure, NOT an empty registry.`,
    );
  }

  return registry;
}
