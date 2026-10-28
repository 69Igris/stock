import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredReportBlocks } from "../../lib/chat/research-blocks";

/**
 * MONEY-676 / MONEY-678 (P8): the chat-inline report must render through the
 * SAME <ResearchReport> as /analysis. buildStructuredReportBlocks() is the seam
 * — it extracts the StructuredReport into ONE `structured-report` block (and
 * falls back to summary blocks when the result isn't structured).
 */

type ResultArg = Parameters<typeof buildStructuredReportBlocks>[0];

function makeResult(overrides: Record<string, unknown>): ResultArg {
  return {
    sessionId: "sess-1",
    symbols: ["INFY.NS"],
    summary: "",
    tokensUsed: 0,
    ...overrides,
  } as unknown as ResultArg;
}

test("wraps a structured report in ONE structured-report block", () => {
  const blocks = buildStructuredReportBlocks(
    makeResult({
      report: {
        score: 72,
        summary: "Solid franchise.",
        sections: [{ title: "Business", type: "text", content: "..." }],
      },
    })
  );
  assert.equal(blocks.length, 1);
  const b = blocks[0] as { type: string; symbol: string; sessionId?: string };
  assert.equal(b.type, "structured-report");
  assert.equal(b.symbol, "INFY");
  assert.equal(b.sessionId, "sess-1");
});

test("builds an 'X vs Y' symbol for multi-symbol comparison runs", () => {
  const blocks = buildStructuredReportBlocks(
    makeResult({
      symbols: ["INFY.NS", "TCS.NS"],
      report: { score: 60, sections: [] },
    })
  );
  assert.equal((blocks[0] as { symbol: string }).symbol, "INFY vs TCS");
});

test("unwraps a report nested under .content", () => {
  const blocks = buildStructuredReportBlocks(
    makeResult({ report: { content: { recommendation: "N/A", sections: [] } } })
  );
  assert.equal(blocks[0]?.type, "structured-report");
});

test("falls back to summary blocks when the result isn't a structured report", () => {
  const blocks = buildStructuredReportBlocks(
    makeResult({ report: { summary: "just prose, no score" } })
  );
  // No score/recommendation → not structured → must NOT emit a report block.
  assert.ok(blocks.every((b) => b.type !== "structured-report"));
});

/* ──────────────────────────────────────────────────────────────────────────
 * MONEY-670 carry fields: the single `structured-report` block must carry the
 * run's sources (news + dataSources + stripped symbols) so the Sources rail
 * still works after completion. The private helpers extractReportNews /
 * extractRunTools are asserted THROUGH the block output below.
 * ────────────────────────────────────────────────────────────────────────── */

interface CarriedNewsItem {
  headline: string;
  source?: string;
  domain?: string;
  url?: string;
  at?: string;
  sentiment?: "positive" | "neutral" | "negative";
}

interface CarriedDataSource {
  tool: string;
  label: string;
  status: string;
}

interface CarryBlock {
  type: string;
  news: CarriedNewsItem[];
  dataSources: CarriedDataSource[];
  symbols: string[];
  symbol: string;
}

function carryBlock(overrides: Record<string, unknown>): CarryBlock {
  const blocks = buildStructuredReportBlocks(makeResult(overrides));
  assert.equal(blocks.length, 1, "must emit exactly one block");
  const b = blocks[0] as unknown as CarryBlock;
  assert.equal(b.type, "structured-report");
  return b;
}

test("MONEY-670: news lifted from newsHighlights AND sections[type=news].items, deduped by URL, url-less dropped", () => {
  const b = carryBlock({
    report: {
      score: 70,
      newsHighlights: [
        {
          title: "Highlight A",
          url: "https://www.example.com/a",
          source: "ET",
        },
        // No url at all → dropped.
        { headline: "No URL item" },
      ],
      sections: [
        { title: "Business", type: "text", content: "..." },
        {
          title: "News",
          type: "news",
          items: [
            // Comes from the news SECTION (second source of items).
            { headline: "Section B", link: "https://news.example.org/b" },
            // Same URL as Highlight A → deduped (first occurrence wins).
            { title: "A duplicate", url: "https://www.example.com/a" },
            // Empty-string url → treated as missing → dropped.
            { title: "Empty url", url: "" },
          ],
        },
      ],
    },
  });
  assert.equal(b.news.length, 2);
  // newsHighlights are pushed before the news-section items.
  assert.equal(b.news[0].headline, "Highlight A");
  assert.equal(b.news[0].url, "https://www.example.com/a");
  assert.equal(b.news[1].headline, "Section B");
  assert.equal(b.news[1].url, "https://news.example.org/b");
});

test("MONEY-670: news field fallback chains — title>headline>'Untitled', url>link>sourceUrl, source>publisher>domain, date>pubDate, www-stripped domain", () => {
  const b = carryBlock({
    report: {
      score: 60,
      newsHighlights: [
        {
          // title wins over headline; explicit source wins; date wins.
          title: "Title wins",
          headline: "Headline ignored",
          url: "https://www.moneycontrol.com/news/x",
          source: "MC",
          publisher: "Ignored",
          date: "2026-06-01",
        },
        {
          // No title → headline; url absent → link; no source → publisher;
          // no date → pubDate.
          headline: "Headline used",
          link: "https://news.example.org/b",
          publisher: "Pub",
          pubDate: "2026-05-02",
        },
        {
          // Bare sourceUrl only → headline "Untitled", source falls all the
          // way through to the parsed domain.
          sourceUrl: "https://plain.org/c",
        },
      ],
    },
  });
  assert.equal(b.news.length, 3);

  assert.equal(b.news[0].headline, "Title wins");
  // www. prefix is stripped from the parsed hostname.
  assert.equal(b.news[0].domain, "moneycontrol.com");
  assert.equal(b.news[0].source, "MC");
  assert.equal(b.news[0].at, "2026-06-01");

  assert.equal(b.news[1].headline, "Headline used");
  assert.equal(b.news[1].url, "https://news.example.org/b");
  assert.equal(b.news[1].domain, "news.example.org");
  assert.equal(b.news[1].source, "Pub");
  assert.equal(b.news[1].at, "2026-05-02");

  assert.equal(b.news[2].headline, "Untitled");
  assert.equal(b.news[2].url, "https://plain.org/c");
  assert.equal(b.news[2].domain, "plain.org");
  assert.equal(b.news[2].source, "plain.org");
  assert.equal(b.news[2].at, undefined);
});

test("MONEY-670: invalid URL keeps the item but yields undefined domain (and source falls through to undefined)", () => {
  const b = carryBlock({
    report: {
      score: 50,
      newsHighlights: [{ headline: "Busted link", url: "not a real url" }],
    },
  });
  assert.equal(b.news.length, 1);
  assert.equal(b.news[0].headline, "Busted link");
  // The raw string is carried as-is; new URL() throws → domain undefined.
  assert.equal(b.news[0].url, "not a real url");
  assert.equal(b.news[0].domain, undefined);
  // source > publisher > domain — all absent/undefined here.
  assert.equal(b.news[0].source, undefined);
});

test("MONEY-670: sentiment maps pos/bull→positive, neg/bear→negative, neu→neutral, other/missing→undefined", () => {
  const b = carryBlock({
    report: {
      score: 65,
      newsHighlights: [
        { title: "p1", url: "https://e.com/1", sentiment: "positive" },
        { title: "p2", url: "https://e.com/2", sentiment: "Bullish" },
        { title: "n1", url: "https://e.com/3", sentiment: "negative" },
        { title: "n2", url: "https://e.com/4", sentiment: "BEARISH" },
        { title: "u1", url: "https://e.com/5", sentiment: "neutral" },
        { title: "x1", url: "https://e.com/6", sentiment: "mixed" },
        { title: "x2", url: "https://e.com/7" },
      ],
    },
  });
  assert.deepEqual(
    b.news.map((n) => n.sentiment),
    [
      "positive",
      "positive",
      "negative",
      "negative",
      "neutral",
      undefined,
      undefined,
    ]
  );
});

test("MONEY-670: dataSources from report.plan.tasks — deduped by tool, humanized labels, status defaults to completed", () => {
  const b = carryBlock({
    report: {
      score: 70,
      plan: {
        tasks: [
          { tool: "fetch_price_history", status: "completed" },
          // No status → defaults to "completed".
          { tool: "compute_dcf" },
          // Duplicate tool → dropped (first occurrence's status wins).
          { tool: "fetch_price_history", status: "failed" },
          // Hyphens humanize too; explicit non-completed status is carried.
          { tool: "web-search", status: "running" },
          // Non-string status → defaults to "completed".
          { tool: "compute_var", status: 5 },
          // No tool / non-string tool → skipped.
          { status: "completed" },
          { tool: 42, status: "completed" },
        ],
      },
    },
  });
  assert.deepEqual(b.dataSources, [
    {
      tool: "fetch_price_history",
      label: "Fetch price history",
      status: "completed",
    },
    { tool: "compute_dcf", label: "Compute dcf", status: "completed" },
    { tool: "web-search", label: "Web search", status: "running" },
    { tool: "compute_var", label: "Compute var", status: "completed" },
  ]);
});

test("MONEY-670: dataSources falls back to flattening plan.segments[].tasks (plan read off the wrapper of a .content-nested report)", () => {
  const b = carryBlock({
    report: {
      // Structured report nested under .content; the plan lives on the
      // wrapper (the worker's persistence shape) — extractRunTools must
      // still find it there.
      content: { score: 55 },
      plan: {
        segments: [
          { tasks: [{ tool: "fetch_news", status: "completed" }] },
          // Segment without tasks contributes nothing.
          { name: "empty segment" },
          { tasks: [{ tool: "compute_drawdown" }] },
        ],
      },
    },
  });
  assert.deepEqual(b.dataSources, [
    { tool: "fetch_news", label: "Fetch news", status: "completed" },
    {
      tool: "compute_drawdown",
      label: "Compute drawdown",
      status: "completed",
    },
  ]);
});

test("MONEY-670: dataSources falls back to the result-level plan when the report carries none", () => {
  const b = carryBlock({
    report: { score: 40 },
    plan: { tasks: [{ tool: "fetch_earnings", status: "completed" }] },
  });
  assert.deepEqual(b.dataSources, [
    { tool: "fetch_earnings", label: "Fetch earnings", status: "completed" },
  ]);
});

test("MONEY-670: block symbols are stripped of .NS/.BO suffixes; no news/plan → empty carry arrays", () => {
  const b = carryBlock({
    symbols: ["INFY.NS", "TCS.BO", "AAPL"],
    report: { score: 10 },
  });
  assert.deepEqual(b.symbols, ["INFY", "TCS", "AAPL"]);
  assert.equal(b.symbol, "INFY vs TCS vs AAPL");
  // Absent newsHighlights/news-section/plan → empty arrays, not undefined.
  assert.deepEqual(b.news, []);
  assert.deepEqual(b.dataSources, []);
});
