/**
 * The registry's I/O half — MONEY-1405 (D2).
 *
 * `amfi-amc-registry.test.ts` next door pins the PARSER against the committed
 * page bytes: the escaping, the `?tab=members` decoy, the five link-less AMCs.
 * None of that moves here, and this file deliberately re-asserts none of it.
 *
 * What it covers is the seam the parser never had: for the whole life of that
 * module `parseAmfiAmcRegistry` had zero runtime callers, so its careful
 * `null`-not-`[]` contract had nowhere to be honoured or broken. These cases
 * drive the real `fetchAmfiAmcRegistry` and assert that the contract survives
 * the crossing.
 *
 * That crossing is where this repo has lost feeds before, twice in the same
 * shape. `getFeedAsset` maps 404 -> `null`, meaning "not published yet" — right
 * for a bhavcopy on a market holiday, wrong for a page AMFI serves
 * continuously. And the parser's own `null` means "AMFI restructured the page",
 * which is a different thing again from "AMFI lists no AMCs". Collapse either
 * one into an empty result and the caller logs a healthy run over a dead
 * parser; that is MONEY-1403 exactly, and it held for 26 nights.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  fetchAmfiAmcRegistry,
  AmfiAmcRegistryError,
} from "../../src/market-data/amfi-amc-registry-fetch";
import {
  AMFI_AMC_REGISTRY_URL,
  amcsWithMonthlyDisclosure,
} from "../../src/market-data/amfi-amc-registry";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "amfi",
  "portfolio-disclosure.trimmed.html",
);
const HTML = readFileSync(FIXTURE, "utf8");

/**
 * Run `fn` with `globalThis.fetch` replaced, always restoring it.
 *
 * No archive store is registered anywhere in this file, so `getFeedAsset` runs
 * in passthrough and lands on exactly this stub. That also means
 * `validateFeedPayload` never runs — it is gated on the archive and replay
 * paths — so the 19 KB trimmed fixture is not measured against the 64 KB floor
 * the live 240 KB page is sized for.
 */
async function withFetch<T>(
  impl: (url: string) => Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) =>
    impl(String(input))) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });

describe("fetchAmfiAmcRegistry — the happy path is the parser's", () => {
  it("reads the served page and returns what the parser returns", async () => {
    // MUTATION: return `{ amcs: [] }` instead of the parse result -> RED here.
    let asked: string | null = null;
    const registry = await withFetch(
      async (url) => {
        asked = url;
        return ok(HTML);
      },
      () => fetchAmfiAmcRegistry(),
    );

    assert.equal(asked, AMFI_AMC_REGISTRY_URL);
    assert.ok(
      registry.amcs.length > 0,
      "the committed fixture parses — if this is 0 the seam dropped the body",
    );
    // The join the whole module exists for, reached through the fetcher rather
    // than by handing the parser a string.
    assert.ok(
      amcsWithMonthlyDisclosure(registry).length > 0,
      "monthly links must survive the crossing",
    );
  });
});

describe("an unreadable page is NEVER an empty industry", () => {
  it("a page the parser rejects THROWS, naming the shape change", async () => {
    // The defect this file exists for. `parseAmfiAmcRegistry` returns null for
    // an unrecognised page precisely so that "AMFI moved the page" and "AMFI
    // lists no AMCs" cannot be one value — and the second is impossible. A
    // fetcher that returned `{ amcs: [] }` here would throw that distinction
    // away at the one boundary where it matters.
    //
    // MUTATION: `if (registry === null) throw` -> `return { amcs: [] }`.
    // RED here; every other case in this file stays green, which is what makes
    // it worth asserting separately.
    const body = "<html><body>AMFI is down for maintenance</body></html>";
    await withFetch(
      async () => ok(body),
      async () => {
        await assert.rejects(
          () => fetchAmfiAmcRegistry(),
          (err: unknown) => {
            assert.ok(err instanceof AmfiAmcRegistryError);
            assert.match(err.message, /UNRECOGNISED/);
            // The byte count is in the message on purpose: "0 bytes" and
            // "240,000 bytes we could not read" are different incidents and
            // the operator should not have to re-fetch to tell them apart.
            assert.match(
              err.message,
              new RegExp(`\\b${body.length} bytes\\b`),
            );
            return true;
          },
        );
      },
    );
  });

  it("the `?tab=members` decoy alone is a parse failure, not a registry", async () => {
    // Same page shape the parser's own decoy case uses, driven through the
    // fetcher. A loose `members` match would find this and report an empty
    // industry at HTTP 200.
    const decoy =
      'self.__next_f.push([1,"b:[\\"$\\",\\"$L16\\",null,' +
      '{\\"links\\":[{\\"URL\\":\\"/aboutamfi?tab=members\\"}]}]"])';
    await withFetch(
      async () => ok(decoy),
      () =>
        assert.rejects(
          () => fetchAmfiAmcRegistry(),
          AmfiAmcRegistryError,
        ) as Promise<void>,
    );
  });
});

describe("a fetch that did not happen is not a fetch that found nothing", () => {
  it("404 THROWS — AMFI serves this page continuously", async () => {
    // `getFeedAsset` maps 404 -> null as "not published yet". There is no
    // publication schedule here: a 404 means the URL moved.
    // MUTATION: `if (res === null) throw` -> `return { amcs: [] }` -> RED.
    await withFetch(
      async () => new Response("", { status: 404 }),
      async () => {
        await assert.rejects(
          () => fetchAmfiAmcRegistry(),
          (err: unknown) => {
            assert.ok(err instanceof AmfiAmcRegistryError);
            assert.match(err.message, /404/);
            return true;
          },
        );
      },
    );
  });

  it("a transport failure THROWS, rewrapped, with the cause preserved", async () => {
    await withFetch(
      () => Promise.reject(new Error("ECONNRESET")),
      async () => {
        await assert.rejects(
          () => fetchAmfiAmcRegistry(),
          (err: unknown) => {
            assert.ok(
              err instanceof AmfiAmcRegistryError,
              "every failure of this call must arrive as ONE type, so a " +
                "caller cannot accidentally handle the transport case and " +
                "miss the parse case",
            );
            assert.match(err.message, /ECONNRESET/);
            return true;
          },
        );
      },
    );
  });
});
