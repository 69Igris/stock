/**
 * The SA provisioner must grant accessor on EVERY secret the specs mount.
 *
 * MONEY-1466. `setup-market-data-sa.sh` kept a hand-written list of three
 * secrets. The cloudbuild specs mount FOUR — the fourth, `DD_API_KEY_{ENV}`,
 * belongs to the `datadog-agent` SIDECAR rather than the app container, which
 * is precisely the one a human reading the app's env block does not notice.
 *
 * ## WHY THIS IS EXPENSIVE RATHER THAN UNTIDY
 *
 * Nothing catches it until the deploy, and the deploy catches it LAST:
 *
 *   1. `setup-market-data-sa.sh qa` — exits 0, reports every grant it made
 *   2. `gcloud builds submit` — uploads 778 MiB of source context
 *   3. docker build (~6 min) — succeeds
 *   4. docker push — succeeds
 *   5. `gcloud run services replace` — REFUSES the revision:
 *        Permission denied on secret: .../DD_API_KEY_QA ... The service
 *        account used must be granted 'Secret Manager Secret Accessor'
 *
 * The provisioner whose entire job is to make step 5 possible reported success
 * at step 1. That is the same shape as the BLOCKERS defect this script already
 * fixed — a partial run exiting 0 — one level up: there the list was checked
 * and a missing SECRET was reported, here the LIST ITSELF was missing an entry,
 * so it was checked completely and was still wrong.
 *
 * A hand-kept list mirroring another file rots. This is the check.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SA_SCRIPT = readFileSync(
  join(ROOT, "scripts", "ops", "setup-market-data-sa.sh"),
  "utf8",
);

/**
 * The specs write PLACEHOLDER tokens and `sed` them to `<NAME>_{QA,PROD}`, so
 * the placeholder stem IS the secret's family name. Reading the stems rather
 * than the post-sed names keeps this independent of which env is being read.
 */
function mountedSecretStems(spec: string): string[] {
  const src = readFileSync(join(ROOT, "apps", "market-data", spec), "utf8");
  // `secretKeyRef.name` only — never `valueFrom` blocks in general, and never
  // the service NAME placeholder, which is not a secret.
  const stems = new Set<string>();
  const re =
    /secretKeyRef:\s*\n\s*key:[^\n]*\n\s*name:\s*([A-Z0-9_]+)_PLACEHOLDER/g;
  const alt = /name:\s*([A-Z0-9_]+)_PLACEHOLDER/g;
  for (const m of src.matchAll(re)) stems.add(m[1]!);
  if (stems.size === 0) {
    // Key/name order differs between specs; fall back to every placeholder that
    // sits inside a secretKeyRef block, minus the service name.
    for (const m of src.matchAll(alt)) {
      if (m[1] !== "SERVICE_NAME") stems.add(m[1]!);
    }
  }
  return [...stems].sort();
}

describe("setup-market-data-sa.sh grants every secret the specs mount", () => {
  for (const spec of ["cloudbuild.qa.yaml", "cloudbuild.prod.yaml"]) {
    it(`[premise] ${spec} really mounts secrets`, () => {
      // A regex that matches nothing makes the assertion below a loop over an
      // empty array — it would pass forever and read as coverage.
      const stems = mountedSecretStems(spec);
      assert.ok(
        stems.length >= 3,
        `${spec}: found ${stems.length} mounted secrets`,
      );
      assert.ok(
        stems.includes("DD_API_KEY"),
        `${spec}: the sidecar's DD_API_KEY mount is the one this test exists for`,
      );
    });

    it(`every secret ${spec} mounts is granted by the SA script`, () => {
      const missing = mountedSecretStems(spec).filter(
        (stem) => !SA_SCRIPT.includes(`"${stem}_\${UPPER}"`),
      );
      assert.deepEqual(
        missing,
        [],
        "these secrets are mounted by the Cloud Run spec but the service " +
          "account is never granted accessor on them, so `services replace` " +
          "REFUSES the revision — after the image has already built and " +
          "pushed, which is the most expensive place to learn it:\n  " +
          missing.join("\n  "),
      );
    });
  }

  it("the SA script grants nothing the specs do not mount", () => {
    // The other direction. A grant with no mount widens the service account's
    // reach for no reason, and nothing would ever fail to reveal it.
    const granted = [...SA_SCRIPT.matchAll(/"([A-Z0-9_]+)_\$\{UPPER\}"/g)].map(
      (m) => m[1]!,
    );
    const mounted = new Set([
      ...mountedSecretStems("cloudbuild.qa.yaml"),
      ...mountedSecretStems("cloudbuild.prod.yaml"),
    ]);
    const extra = [...new Set(granted)].filter((g) => !mounted.has(g)).sort();
    assert.deepEqual(
      extra,
      [],
      `granted but never mounted: ${extra.join(", ")} — a grant nobody needs is reach nobody reviewed`,
    );
  });
});
