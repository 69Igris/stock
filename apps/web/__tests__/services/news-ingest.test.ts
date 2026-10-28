import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dedupNewsBatch,
  parseRssChannel,
  decodeXmlEntities,
} from "../../../../packages/services/src/news-ingest";

test("parseRssChannel extracts title + link + summary from RSS 2.0", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Reliance beats Q3 consensus</title>
      <link>https://example.com/reliance-q3</link>
      <description><![CDATA[Retail EBITDA +24% YoY]]></description>
      <pubDate>Mon, 12 May 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>HDFC Bank approves bonus</title>
      <link>https://example.com/hdfc-bonus</link>
      <pubDate>Mon, 12 May 2026 09:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;
  const result = parseRssChannel(xml, "test");
  assert.equal(result.length, 2);
  assert.equal(result[0]!.title, "Reliance beats Q3 consensus");
  assert.equal(result[0]!.source, "test");
  assert.equal(result[0]!.summary, "Retail EBITDA +24% YoY");
  assert.equal(result[1]!.summary, null);
});

test("parseRssChannel drops items missing title or link", () => {
  const xml = `<rss><channel>
    <item><link>https://x.com/no-title</link></item>
    <item><title>No link</title></item>
    <item><title>Good</title><link>https://x.com/good</link><pubDate>2026-05-12</pubDate></item>
  </channel></rss>`;
  const result = parseRssChannel(xml, "test");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.title, "Good");
});

test("dedupNewsBatch removes exact-URL duplicates", () => {
  const items = [
    {
      url: "https://x.com/a",
      title: "A",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
    {
      url: "https://x.com/a",
      title: "Same URL different title",
      summary: null,
      source: "y",
      publishedAt: new Date(),
    },
    {
      url: "https://x.com/b",
      title: "B",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
  ];
  const out = dedupNewsBatch(items);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((i) => i.url),
    ["https://x.com/a", "https://x.com/b"]
  );
});

test("dedupNewsBatch removes near-duplicate titles across outlets", () => {
  const items = [
    {
      url: "https://et.com/x",
      title: "Reliance beats Q3 consensus by 8 percent on retail strength",
      summary: null,
      source: "ET",
      publishedAt: new Date(),
    },
    {
      url: "https://mc.com/x",
      title: "Reliance beats Q3 consensus by 8 percent on retail strength",
      summary: null,
      source: "MC",
      publishedAt: new Date(),
    },
  ];
  const out = dedupNewsBatch(items);
  assert.equal(out.length, 1);
});

test("dedupNewsBatch honors knownUrls and knownTitles from storage", () => {
  const items = [
    {
      url: "https://x.com/a",
      title: "Fresh news today",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
    {
      url: "https://x.com/b",
      title: "Reliance beats Q3 consensus on retail strength",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
  ];
  const out = dedupNewsBatch(
    items,
    new Set(["https://x.com/a"]),
    // Same content tokens - Jaccard ≥ 0.85 → dedup
    ["Reliance beats Q3 consensus on retail strength"]
  );
  assert.equal(out.length, 0);
});

test("dedupNewsBatch keeps unrelated headlines from the same outlet", () => {
  const items = [
    {
      url: "https://x.com/a",
      title: "RBI policy meeting outcome",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
    {
      url: "https://x.com/b",
      title: "Tata Motors launches new EV model",
      summary: null,
      source: "x",
      publishedAt: new Date(),
    },
  ];
  const out = dedupNewsBatch(items);
  assert.equal(out.length, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// XML/HTML entity decoding (MONEY-620 bug fix).
//
// Real Indian RSS feeds (ET, Mint, BS, Moneycontrol) deliver entity-encoded
// titles/summaries — "&amp;", "&#8377;" (₹), "&gt;". Before the fix
// `parseRssChannel` stored them VERBATIM, so `NewsArticle.title` persisted the
// literal "Reliance &amp; HDFC"; the discover/news feed renders that title into
// a plain JSX text node and React does NOT decode entities in text content, so
// users saw the raw "&amp;"/"&#8377;". It also polluted the dedup tokenizer
// (`[^\w\s]` strips "&"/";", leaving a junk "amp" token in every such headline).
// `decodeXmlEntities` is the real exported fix; assert it directly AND through
// `parseRssChannel` (the live worker path).
// ───────────────────────────────────────────────────────────────────────────

test("decodeXmlEntities resolves the five predefined XML entities", () => {
  assert.equal(decodeXmlEntities("Reliance &amp; HDFC"), "Reliance & HDFC");
  assert.equal(decodeXmlEntities("oil &gt; $90 &lt;ok&gt;"), "oil > $90 <ok>");
  assert.equal(decodeXmlEntities("&quot;hi&quot; &apos;x&apos;"), `"hi" 'x'`);
  assert.equal(decodeXmlEntities("it&#39;s a deal"), "it's a deal");
});

test("decodeXmlEntities resolves decimal and hex numeric refs (₹)", () => {
  assert.equal(decodeXmlEntities("Rupee at &#8377;83"), "Rupee at ₹83");
  assert.equal(decodeXmlEntities("Rupee at &#x20B9;83"), "Rupee at ₹83");
});

test("decodeXmlEntities normalises &nbsp; to a plain ASCII space", () => {
  const out = decodeXmlEntities("a&nbsp;b");
  assert.equal(out, "a b");
  assert.equal(out.charCodeAt(1), 32, "must be ASCII space, not U+00A0");
});

test("decodeXmlEntities resolves &amp; LAST (no double-decode)", () => {
  // A correctly single-escaped "&amp;amp;" means a literal "&amp;": decode once.
  assert.equal(decodeXmlEntities("a &amp;amp; b"), "a &amp; b");
  // "&amp;#39;" is a literal "&#39;", NOT an apostrophe.
  assert.equal(decodeXmlEntities("&amp;#39;"), "&#39;");
});

test("decodeXmlEntities leaves unknown / malformed entities untouched", () => {
  assert.equal(decodeXmlEntities("AT&T merger"), "AT&T merger");
  assert.equal(decodeXmlEntities("&foo; &bar;"), "&foo; &bar;");
  // Out-of-range numeric ref must NOT become U+FFFD — keep the raw text.
  assert.equal(decodeXmlEntities("&#99999999999999;"), "&#99999999999999;");
  assert.equal(decodeXmlEntities("&#x110000;"), "&#x110000;");
});

test("decodeXmlEntities is a no-op for entity-free / empty input", () => {
  assert.equal(decodeXmlEntities("plain headline"), "plain headline");
  assert.equal(decodeXmlEntities(""), "");
});

test("parseRssChannel decodes entities in title and summary, NOT in the URL", () => {
  const xml = `<rss><channel><item>
    <title>Q3: Reliance &amp; HDFC beat; oil &gt; &#8377;90</title>
    <link>https://example.com/q3?a=1&amp;b=2</link>
    <description><![CDATA[Profit up 5% &amp; margins strong]]></description>
    <pubDate>Mon, 12 May 2026 10:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const [item] = parseRssChannel(xml, "ET");
  assert.ok(item);
  assert.equal(item!.title, "Q3: Reliance & HDFC beat; oil > ₹90");
  assert.equal(item!.summary, "Profit up 5% & margins strong");
  // A URL must stay byte-exact: "&amp;" in a query string is part of the link.
  assert.equal(item!.url, "https://example.com/q3?a=1&amp;b=2");
});

test("dedupNewsBatch does not conflate unrelated entity-bearing headlines", () => {
  // Both titles share the literal "&" — pre-fix they shared a junk "amp" token.
  const items = [
    {
      url: "https://x.com/a",
      title: "Reliance & Jio post record profit",
      summary: null,
      source: "ET",
      publishedAt: new Date(),
    },
    {
      url: "https://x.com/b",
      title: "Adani & Wilmar announce merger",
      summary: null,
      source: "MC",
      publishedAt: new Date(),
    },
  ];
  assert.equal(dedupNewsBatch(items).length, 2);
});
