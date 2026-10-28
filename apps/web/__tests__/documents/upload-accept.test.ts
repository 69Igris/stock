/**
 * Upload acceptance + mime resolution (MONEY-1167).
 *
 * Regression cover for MONEY-1154 bug #5 — "upload document doesnt work".
 *
 * Two stacked defects produced "nothing happens":
 *   1. UploadZone filtered on the browser-reported `file.type` alone and
 *      `return`ed when nothing survived — no error, no toast, no state change.
 *   2. The server's gate keyed off the same `file.type`, so it would have
 *      rejected the file anyway.
 *
 * `.csv` is the case that breaks both: its `type` is "" on macOS and
 * `application/vnd.ms-excel` on Windows. Neither is `text/csv`.
 *
 * Source: apps/web/lib/documents/upload-accept.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveUploadMimeType,
  partitionUploadFiles,
  describeRejections,
  fileExtension,
} from "@/lib/documents/upload-accept";

const f = (name: string, type: string) => ({ name, type });

describe("resolveUploadMimeType — the reported bug", () => {
  it("a macOS CSV (empty file.type) resolves via its extension", () => {
    // The exact case that silently vanished before.
    assert.equal(resolveUploadMimeType(f("Tradebook.csv", "")), "text/csv");
  });

  it("a Windows CSV (reported as ms-excel) is still accepted", () => {
    const resolved = resolveUploadMimeType(
      f("Tradebook.csv", "application/vnd.ms-excel")
    );
    assert.ok(resolved, "must not be rejected");
  });

  it("a correctly-typed file trusts the browser", () => {
    assert.equal(
      resolveUploadMimeType(f("a.pdf", "application/pdf")),
      "application/pdf"
    );
  });

  it("an unsupported type is still rejected — the fallback is not a bypass", () => {
    assert.equal(resolveUploadMimeType(f("virus.exe", "")), null);
    assert.equal(
      resolveUploadMimeType(f("archive.zip", "application/zip")),
      null
    );
  });

  it("an extensionless file with an unusable type is rejected", () => {
    assert.equal(resolveUploadMimeType(f("README", "")), null);
  });

  it("extension matching is case-insensitive", () => {
    assert.equal(resolveUploadMimeType(f("REPORT.PDF", "")), "application/pdf");
  });
});

describe("partitionUploadFiles", () => {
  it("NEVER silently drops: a rejected file comes back with a reason", () => {
    const { accepted, rejected } = partitionUploadFiles(
      [f("virus.exe", "")],
      10
    );
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 1, "the rejection must be reported");
    assert.ok(rejected[0].reason.length > 0, "must carry a reason");
    assert.equal(rejected[0].name, "virus.exe");
  });

  it("accepts the CSV that used to disappear", () => {
    const { accepted, rejected } = partitionUploadFiles(
      [f("Tradebook.csv", "")],
      10
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].mimeType, "text/csv");
    assert.equal(rejected.length, 0);
  });

  it("splits a mixed selection instead of failing whole", () => {
    const { accepted, rejected } = partitionUploadFiles(
      [f("a.pdf", "application/pdf"), f("b.exe", ""), f("c.csv", "")],
      10
    );
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].name, "b.exe");
  });

  it("files beyond the cap are reported, not dropped in silence", () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      f(`doc${i}.pdf`, "application/pdf")
    );
    const { accepted, rejected } = partitionUploadFiles(files, 10);
    assert.equal(accepted.length, 10);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((r) => /10 files/.test(r.reason)));
  });

  it("an empty selection yields no accepted and no spurious rejection", () => {
    const { accepted, rejected } = partitionUploadFiles([], 10);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 0);
  });
});

describe("describeRejections", () => {
  it("empty for no rejections (nothing shown to the user)", () => {
    assert.equal(describeRejections([]), "");
  });

  it("names the file and the reason for a single rejection", () => {
    const msg = describeRejections([{ name: "a.exe", reason: "nope" }]);
    assert.ok(msg.includes("a.exe"));
    assert.ok(msg.includes("nope"));
  });

  it("summarises multiple rejections with a count", () => {
    const msg = describeRejections([
      { name: "a.exe", reason: "r1" },
      { name: "b.zip", reason: "r2" },
    ]);
    assert.ok(msg.includes("2 files"));
    assert.ok(msg.includes("a.exe") && msg.includes("b.zip"));
  });
});

describe("fileExtension", () => {
  it("lowercases and strips the dot", () => {
    assert.equal(fileExtension("Report.PDF"), "pdf");
  });
  it("empty for no extension, and for a dotfile", () => {
    assert.equal(fileExtension("README"), "");
    assert.equal(fileExtension(".gitignore"), "");
  });
  it("uses the LAST dot", () => {
    assert.equal(fileExtension("a.b.c.csv"), "csv");
  });
});
