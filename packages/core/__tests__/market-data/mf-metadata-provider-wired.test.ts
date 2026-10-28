/**
 * The AMFI metadata provider must be TURNED ON in both deploy specs
 * — MONEY-1214.
 *
 * ## The failure this exists to stop
 *
 * `mf-metadata-weekly-prod` was ENABLED and firing every Sunday 21:00 IST while
 * `MF_METADATA_PROVIDER` was set NOWHERE — not on either Cloud Run service, not
 * in either cloudbuild spec. So `isAmfiFundMetadataEnabled()` returned false, no
 * provider registered, and every run logged "No MF metadata provider is
 * configured" and exited. Measured on prod 2026-08-19: all **14,225**
 * `mutual_fund_masters` rows carry 0 expenseRatio, 0 aum, 0 launchDate, 0
 * benchmarkName, 0 exitLoad. Identical on QA.
 *
 * That is the third instance this week of a scheduled job that runs, reports
 * success, and writes nothing — after MONEY-1211's tier selector (0 of 10,444
 * instruments) and MONEY-1210's feed-parse pinned to a stale image. The shape
 * is always the same: the SCHEDULE is healthy, so nothing alerts.
 *
 * A unit test cannot prove the env var reached the container, but it can prove
 * the deploy spec still asks for it — which is the part a refactor silently
 * drops.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import {
  AMFI_METADATA_PROVIDER_ID,
  isAmfiFundMetadataEnabled,
} from "../../src/market-data/instruments/amfi-fund-metadata-provider";

function repoRoot(): string {
  // Anchor on the workspace lockfile, never turbo.json — Turborepo supports
  // per-package configs, so a turbo.json walk stops inside packages/core and
  // every read returns "", making a source guard silently vacuous.
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

const SPECS = ["workers/cloudbuild.prod.yaml", "workers/cloudbuild.qa.yaml"];

describe("AMFI metadata provider is wired in the deploy specs", () => {
  it("both specs are readable (a blind read would pass vacuously)", () => {
    for (const s of SPECS) {
      const src = readFileSync(join(repoRoot(), s), "utf8");
      assert.ok(src.length > 1000, `${s} is empty or unreadable`);
    }
  });

  for (const spec of SPECS) {
    it(`${spec} sets MF_METADATA_PROVIDER`, () => {
      const src = readFileSync(join(repoRoot(), spec), "utf8");
      assert.match(
        src,
        /- name: MF_METADATA_PROVIDER\s*\n\s*value: "([^"]+)"/,
        `${spec} does not set MF_METADATA_PROVIDER — mf-metadata-weekly will ` +
          `run on schedule, find no provider, and write nothing while ` +
          `reporting success`,
      );
    });

    it(`${spec}'s value is the id the gate actually accepts`, () => {
      // The gate compares against AMFI_METADATA_PROVIDER_ID exactly (lowercased,
      // trimmed). A typo here is indistinguishable at runtime from the var being
      // absent — same silent no-op, so pin the value against the constant rather
      // than against a copy of the string.
      const src = readFileSync(join(repoRoot(), spec), "utf8");
      const m = src.match(
        /- name: MF_METADATA_PROVIDER\s*\n\s*value: "([^"]+)"/,
      );
      assert.ok(m, `${spec}: no MF_METADATA_PROVIDER value`);
      assert.equal(m[1], AMFI_METADATA_PROVIDER_ID);
    });
  }

  it("the gate accepts that exact value, and rejects near-misses", () => {
    const original = process.env.MF_METADATA_PROVIDER;
    try {
      process.env.MF_METADATA_PROVIDER = AMFI_METADATA_PROVIDER_ID;
      assert.equal(isAmfiFundMetadataEnabled(), true);

      // Case and whitespace are tolerated — the gate trims and lowercases.
      process.env.MF_METADATA_PROVIDER = `  ${AMFI_METADATA_PROVIDER_ID.toUpperCase()}  `;
      assert.equal(isAmfiFundMetadataEnabled(), true);

      // Anything else is OFF, including the empty string and a plausible typo.
      for (const bad of ["", "amfiindia", "AMFI_METADATA", "kuvera", "true"]) {
        process.env.MF_METADATA_PROVIDER = bad;
        assert.equal(
          isAmfiFundMetadataEnabled(),
          false,
          `${JSON.stringify(bad)} must not enable the provider`,
        );
      }

      delete process.env.MF_METADATA_PROVIDER;
      assert.equal(isAmfiFundMetadataEnabled(), false);
    } finally {
      if (original === undefined) delete process.env.MF_METADATA_PROVIDER;
      else process.env.MF_METADATA_PROVIDER = original;
    }
  });
});
