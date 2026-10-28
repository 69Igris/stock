/**
 * Paste-sideloading detection (real source:
 * apps/content/components/editor/sideload-logic.ts).
 *
 * The editor re-uploads any media block whose URL is external (a third-party
 * http(s) host or an inline base64 data URL) to GCS so published posts never
 * hot-link a foreign image. These tests assert the REAL detection used to decide
 * what gets re-hosted.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isExternalMediaUrl,
  collectExternalMedia,
} from "@/components/editor/sideload-logic";

describe("isExternalMediaUrl", () => {
  it("treats our GCS bucket URL as NOT external (already hosted)", () => {
    assert.equal(
      isExternalMediaUrl(
        "https://storage.googleapis.com/bucket/content/images/x.png",
      ),
      false,
    );
  });
  it("treats a third-party http(s) URL as external", () => {
    assert.equal(isExternalMediaUrl("https://cdn.othersite.com/a.jpg"), true);
    assert.equal(isExternalMediaUrl("http://example.com/a.png"), true);
  });
  it("treats a base64 data URL as external", () => {
    assert.equal(isExternalMediaUrl("data:image/png;base64,AAAA"), true);
  });
  it("ignores empty / blob / relative URLs", () => {
    assert.equal(isExternalMediaUrl(""), false);
    assert.equal(isExternalMediaUrl(null), false);
    assert.equal(isExternalMediaUrl(undefined), false);
    assert.equal(isExternalMediaUrl("blob:https://app/abc"), false);
    assert.equal(isExternalMediaUrl("/local/path.png"), false);
  });
});

describe("collectExternalMedia", () => {
  it("collects external image + video blocks, skips GCS + non-media", () => {
    const doc = [
      { id: "p1", type: "paragraph", content: [] },
      { id: "i1", type: "image", props: { url: "https://ext.com/a.jpg" } },
      {
        id: "i2",
        type: "image",
        props: { url: "https://storage.googleapis.com/b/x.png" },
      },
      { id: "v1", type: "video", props: { url: "data:video/mp4;base64,AA" } },
    ];
    const out = collectExternalMedia(doc);
    assert.deepEqual(
      out.map((m) => m.id),
      ["i1", "v1"],
    );
  });

  it("walks nested children", () => {
    const doc = [
      {
        id: "col",
        type: "column",
        props: {},
        children: [
          { id: "i9", type: "image", props: { url: "https://ext.com/n.png" } },
        ],
      },
    ];
    assert.deepEqual(
      collectExternalMedia(doc).map((m) => m.id),
      ["i9"],
    );
  });

  it("returns [] for empty / non-array input", () => {
    assert.deepEqual(collectExternalMedia([]), []);
    assert.deepEqual(collectExternalMedia(null), []);
    assert.deepEqual(collectExternalMedia(undefined), []);
  });
});
