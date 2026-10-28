import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVideoId } from "../../../../packages/research/src/data-sources/youtube-transcript";
import { fetchYoutubeTranscriptTool } from "../../../../packages/research/src/tools/fetch-youtube-transcript";

// MONEY-785 (P4) — YouTube transcript ingestion. `parseVideoId` is the pure,
// network-free surface; the live `fetchYoutubeTranscript` hits the network and
// is intentionally NOT unit-tested here. The tool's invalid-input degrade path
// (no network) is also covered.

const VALID_ID = "dQw4w9WgXcQ"; // canonical 11-char id

test("parses a bare 11-char video id", () => {
  assert.equal(parseVideoId(VALID_ID), VALID_ID);
});

test("parses watch?v= URLs", () => {
  assert.equal(
    parseVideoId(`https://www.youtube.com/watch?v=${VALID_ID}`),
    VALID_ID
  );
  assert.equal(
    parseVideoId(`http://youtube.com/watch?v=${VALID_ID}`),
    VALID_ID
  );
  // extra query params + a different order
  assert.equal(
    parseVideoId(
      `https://www.youtube.com/watch?list=PL123&v=${VALID_ID}&t=42s`
    ),
    VALID_ID
  );
});

test("parses youtu.be/ short links", () => {
  assert.equal(parseVideoId(`https://youtu.be/${VALID_ID}`), VALID_ID);
  assert.equal(parseVideoId(`https://youtu.be/${VALID_ID}?t=30`), VALID_ID);
});

test("parses /embed/ URLs", () => {
  assert.equal(
    parseVideoId(`https://www.youtube.com/embed/${VALID_ID}`),
    VALID_ID
  );
});

test("parses /shorts/ URLs", () => {
  assert.equal(
    parseVideoId(`https://www.youtube.com/shorts/${VALID_ID}`),
    VALID_ID
  );
});

test("parses /live/ URLs", () => {
  assert.equal(
    parseVideoId(`https://www.youtube.com/live/${VALID_ID}`),
    VALID_ID
  );
});

test("parses /v/ URLs", () => {
  assert.equal(parseVideoId(`https://www.youtube.com/v/${VALID_ID}`), VALID_ID);
});

test("parses m. / music. / nocookie hosts", () => {
  assert.equal(
    parseVideoId(`https://m.youtube.com/watch?v=${VALID_ID}`),
    VALID_ID
  );
  assert.equal(
    parseVideoId(`https://music.youtube.com/watch?v=${VALID_ID}`),
    VALID_ID
  );
  assert.equal(
    parseVideoId(`https://www.youtube-nocookie.com/embed/${VALID_ID}`),
    VALID_ID
  );
});

test("trims surrounding whitespace", () => {
  assert.equal(parseVideoId(`   https://youtu.be/${VALID_ID}  `), VALID_ID);
  assert.equal(parseVideoId(`  ${VALID_ID}  `), VALID_ID);
});

test("loose fallback: v= fragment anywhere in a non-URL string", () => {
  assert.equal(parseVideoId(`junk&v=${VALID_ID}&more`), VALID_ID);
});

test("returns null for invalid / non-YouTube inputs", () => {
  assert.equal(parseVideoId(""), null);
  assert.equal(parseVideoId("   "), null);
  assert.equal(parseVideoId("not a url"), null);
  assert.equal(parseVideoId("https://vimeo.com/12345678"), null);
  assert.equal(parseVideoId("https://www.youtube.com/watch?v=short"), null); // too short
  assert.equal(
    parseVideoId("https://www.youtube.com/feed/subscriptions"),
    null
  );
  assert.equal(parseVideoId("https://example.com/embed/dQw4w9WgXcQ"), null); // wrong host
  assert.equal(parseVideoId("dQw4w9WgX"), null); // 9 chars, not 11
});

test("tool degrades to available:false on an unparseable url (no network)", async () => {
  const r = await fetchYoutubeTranscriptTool.execute({
    url: "not a youtube url",
  });
  assert.equal(r.success, true);
  const data = r.data as {
    available: boolean;
    videoId: string | null;
    reason?: string;
  };
  assert.equal(data.available, false);
  assert.equal(data.videoId, null);
  assert.ok(typeof data.reason === "string" && data.reason.length > 0);
});

test("tool errors when url param is missing/blank", async () => {
  const r = await fetchYoutubeTranscriptTool.execute({ url: "   " });
  assert.equal(r.success, false);
});
