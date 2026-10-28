import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChatMessageWithBlocks,
  ContentBlock,
  TurnMeta,
} from "@usemoney/types";
import {
  deriveCitations,
  hasCitations,
} from "../../components/chat/CitationsRail";

/**
 * MONEY-490 / MONEY-670 (Sources rail): `deriveCitations` builds the grouped
 * Sources rail (Web → Database/Filings → Data tools run → Instruments →
 * Reports & pages) from an assistant message's real blocks — including the P6
 * path where research completion emits ONLY a structured-report block carrying
 * the run's sources (news / dataSources / symbols / sessionId).
 *
 * Pure function — no rendering, network, or timers.
 */

const NSE_BOARD_MEETINGS_PAGE =
  "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings";

function msg(
  blocks: ContentBlock[] | undefined,
  turnMeta?: TurnMeta,
  role: "user" | "assistant" = "assistant"
): ChatMessageWithBlocks {
  return {
    id: "m1",
    role,
    content: "",
    blocks,
    timestamp: new Date(0),
    turnMeta,
  };
}

type Groups = ReturnType<typeof deriveCitations>;

function group(groups: Groups, key: string): Groups[number] {
  const g = groups.find((x) => x.key === key);
  assert.ok(g, `expected group "${key}" in [${groups.map((x) => x.key)}]`);
  return g;
}

test("returns [] for undefined / non-assistant / empty assistant messages", () => {
  assert.deepEqual(deriveCitations(undefined), []);

  const news: ContentBlock = {
    type: "news",
    articles: [{ headline: "H", url: "https://x.com/a" }],
  };
  // Same blocks on a USER message derive nothing.
  assert.deepEqual(deriveCitations(msg([news], undefined, "user")), []);
  // Assistant message with no blocks and no turnMeta derives nothing.
  assert.deepEqual(deriveCitations(msg([], undefined)), []);
  assert.deepEqual(deriveCitations(msg(undefined, undefined)), []);

  assert.equal(hasCitations(undefined), false);
  assert.equal(hasCitations(msg([], undefined)), false);
  assert.equal(hasCitations(msg([news])), true);

  // Real semantics note: turnMeta.symbols ALONE (no blocks at all) still
  // yields an INSTRUMENTS group — "no blocks → []" only holds when turnMeta
  // carries no symbols either.
  const onlyMeta = deriveCitations(msg(undefined, { symbols: ["INFY"] }));
  assert.deepEqual(
    onlyMeta.map((g) => g.key),
    ["symbols"]
  );
});

test("structured-report news append to WEB, continue cite numbering, skip url-less entries", () => {
  const blocks: ContentBlock[] = [
    {
      type: "news",
      articles: [
        {
          headline: "A1",
          url: "https://www.reuters.com/a1",
          source: "Reuters",
        },
        { headline: "A2", url: "https://b.com/x" },
      ],
    },
    {
      type: "structured-report",
      report: {},
      symbol: "INFY",
      news: [
        {
          headline: "R1",
          url: "https://news.site.com/r1",
          at: "2026-06-02",
          sentiment: "negative",
        },
        { headline: "No URL — must be skipped" },
      ],
    },
  ];

  const groups = deriveCitations(msg(blocks));
  const web = group(groups, "web");

  assert.equal(web.rows.length, 3); // url-less report entry dropped
  assert.deepEqual(
    web.rows.map((r) => r.title),
    ["A1", "A2", "R1"]
  );
  // Cite numbering continues across the existing web rows: 1, 2 → report 3.
  assert.deepEqual(
    web.rows.map((r) => r.cite),
    [1, 2, 3]
  );

  const r1 = web.rows[2]!;
  assert.equal(r1.id, "web-r-2"); // report-sourced rows get the web-r- prefix
  assert.equal(r1.kind, "web");
  assert.equal(r1.href, "https://news.site.com/r1");
  assert.equal(r1.source, "news.site.com"); // derived from the URL host
  assert.equal(r1.domain, "news.site.com");
  assert.equal(r1.date, "2026-06-02");
  assert.equal(r1.sentiment, "negative");
});

test("structured-report dataSources become tool rows, deduped against task-progress tools by tool id", () => {
  const blocks: ContentBlock[] = [
    {
      type: "action",
      actionId: "a1",
      tool: "deep_research",
      description: "",
      params: {},
      status: "executed",
      taskProgress: [
        { id: "t1", tool: "fetch_news", type: "tool", status: "completed" },
        // Repeated completed tool → still a single row.
        { id: "t2", tool: "fetch_news", type: "tool", status: "completed" },
        // Not completed → no tool row (so its dataSource twin is NOT a dup).
        { id: "t3", tool: "compute_dcf", type: "tool", status: "running" },
        // Empty tool id falls back to the task type.
        { id: "t4", tool: "", type: "screener_scan", status: "completed" },
      ],
    },
    {
      type: "structured-report",
      report: {},
      symbol: "INFY",
      dataSources: [
        { tool: "fetch_news", label: "Live news", status: "done" }, // dup → skipped
        { tool: "compute_dcf", label: "DCF model", status: "done" }, // new → appended
      ],
    },
  ];

  const groups = deriveCitations(msg(blocks));
  const tools = group(groups, "tools");

  assert.deepEqual(
    tools.rows.map((r) => [r.id, r.title, r.source]),
    [
      ["tool-fetch_news", "Fetch news", "fetch_news"],
      ["tool-screener_scan", "Screener scan", "screener_scan"],
      // dataSource rows use the report label as the title + tool-r- id prefix.
      ["tool-r-compute_dcf", "DCF model", "compute_dcf"],
    ]
  );
  // Tool rows never carry an inline [n] cite.
  assert.ok(tools.rows.every((r) => r.cite == null && r.kind === "tool"));
});

test("symbols merge turnMeta + structured-report symbols without duplicates, dropping falsy", () => {
  const blocks: ContentBlock[] = [
    {
      type: "structured-report",
      report: {},
      symbol: "TCS",
      symbols: ["TCS", "WIPRO", ""],
    },
  ];

  const groups = deriveCitations(msg(blocks, { symbols: ["INFY", "TCS", ""] }));
  const symbols = group(groups, "symbols");

  // turnMeta first (filtered), then report-only additions; dups collapse.
  assert.deepEqual(
    symbols.rows.map((r) => r.title),
    ["INFY", "TCS", "WIPRO"]
  );
  assert.deepEqual(
    symbols.rows.map((r) => r.id),
    ["sym-0", "sym-1", "sym-2"]
  );
  assert.ok(symbols.rows.every((r) => r.kind === "symbol" && r.cite == null));
});

test("sessionId synthesizes a View Full Analysis row only when no report row exists", () => {
  const srb: ContentBlock = {
    type: "structured-report",
    report: {},
    symbol: "INFY",
    sessionId: "sess/42",
  };

  // (a) no navigation rows → synthesized self-row with encoded sessionId.
  let groups = deriveCitations(msg([srb]));
  let reports = group(groups, "reports");
  assert.equal(reports.rows.length, 1);
  assert.deepEqual(reports.rows[0], {
    id: "report-self",
    kind: "report",
    title: "View Full Analysis",
    snippet: "Open the detailed research report",
    href: "/analysis/sess%2F42",
  });

  // (b) a real navigation report row suppresses the synthesized one.
  const nav: ContentBlock = {
    type: "navigation",
    links: [
      {
        label: "Open report",
        href: "/analysis/abc",
        description: "Full report",
      },
    ],
  };
  groups = deriveCitations(msg([nav, srb]));
  reports = group(groups, "reports");
  assert.deepEqual(
    reports.rows.map((r) => [r.id, r.title, r.snippet, r.href]),
    [["report-0", "Open report", "Full report", "/analysis/abc"]]
  );

  // (c) hash-only navigation links are not source rows → still synthesized.
  const hashNav: ContentBlock = {
    type: "navigation",
    links: [{ label: "Load", href: "#load-report:xyz" }],
  };
  groups = deriveCitations(msg([hashNav, srb]));
  reports = group(groups, "reports");
  assert.deepEqual(
    reports.rows.map((r) => r.id),
    ["report-self"]
  );

  // (d) no sessionId → no reports group at all.
  const noSession: ContentBlock = {
    type: "structured-report",
    report: {},
    symbol: "INFY",
  };
  assert.equal(
    deriveCitations(msg([noSession])).find((g) => g.key === "reports"),
    undefined
  );
});

test("sentiment passthrough + source/domain fallbacks + URL/headline dedupe", () => {
  const blocks: ContentBlock[] = [
    {
      type: "news",
      articles: [
        {
          headline: "A",
          url: "https://www.moneycontrol.com/a",
          sentiment: "positive",
        },
        { headline: "B", domain: "www.livemint.com" },
        {
          headline: "C",
          source: "Mint",
          url: "https://www.livemint.com/c",
          sentiment: "neutral",
        },
        { headline: "D", url: "::://bad" },
        // Same URL as A → deduped even with a different headline.
        { headline: "A duplicate", url: "https://www.moneycontrol.com/a" },
        // No URL → dedupe key falls back to the headline → dup of B.
        { headline: "B" },
      ],
    },
  ];

  const groups = deriveCitations(msg(blocks));
  const web = group(groups, "web");

  assert.deepEqual(
    web.rows.map((r) => r.title),
    ["A", "B", "C", "D"]
  );
  assert.deepEqual(
    web.rows.map((r) => r.cite),
    [1, 2, 3, 4]
  );

  const [a, b, c, d] = web.rows;
  // A: no explicit source/domain → both derived from the URL, www stripped.
  assert.equal(a!.source, "moneycontrol.com");
  assert.equal(a!.domain, "moneycontrol.com");
  assert.equal(a!.sentiment, "positive");
  // B: domain-only article → source prettified, raw domain kept verbatim,
  // no href, no sentiment.
  assert.equal(b!.source, "livemint.com");
  assert.equal(b!.domain, "www.livemint.com");
  assert.equal(b!.href, undefined);
  assert.equal(b!.sentiment, undefined);
  // C: explicit source label wins over the URL-derived one.
  assert.equal(c!.source, "Mint");
  assert.equal(c!.domain, "livemint.com");
  assert.equal(c!.sentiment, "neutral");
  // D: unparseable "://" URL → no source/domain derivable; href kept as-is.
  assert.equal(d!.source, undefined);
  assert.equal(d!.domain, undefined);
  assert.equal(d!.href, "::://bad");
});

test("full pipeline: group order/titles, filing cites interleave, NSE board-meetings fallback href", () => {
  const blocks: ContentBlock[] = [
    {
      type: "news",
      articles: [
        {
          headline: "Q4 beat",
          url: "https://www.reuters.com/q4",
          source: "Reuters",
          at: "2026-06-01",
          sentiment: "positive",
        },
      ],
    },
    {
      type: "research-stream",
      sessionId: "s1",
      actionId: "a1",
      status: "completed",
      progress: 100,
      taskProgress: [
        {
          id: "t1",
          tool: "fetch_exchange_announcements",
          type: "tool",
          status: "completed",
          resultSummary: [
            {
              subject: "Dividend declared",
              url: "https://nsearchives.nseindia.com/f1.pdf",
              date: "2026-05-30",
              detail: "Final dividend Rs 22",
            },
          ],
        },
        {
          id: "t2",
          tool: "fetch_shareholder_meetings",
          type: "tool",
          status: "completed",
          // Summaries may wrap rows in { data: [...] }; meeting rows carry no
          // per-row URL → cite the official NSE board-meetings filing page.
          resultSummary: { data: [{ purpose: "AGM", date: "2026-06-20" }] },
        },
        {
          id: "t3",
          tool: "fetch_price_history",
          type: "tool",
          status: "failed",
        },
      ],
    },
    {
      type: "structured-report",
      report: {},
      symbol: "INFY",
      sessionId: "sess-42",
      news: [
        {
          headline: "Margin outlook",
          url: "https://www.moneycontrol.com/n2",
          sentiment: "neutral",
        },
      ],
      dataSources: [
        // Already ran as a task → dup, skipped.
        {
          tool: "fetch_shareholder_meetings",
          label: "Meetings",
          status: "done",
        },
        { tool: "peer_comparison", label: "Peer comparison", status: "done" },
      ],
      symbols: ["INFY"],
    },
  ];

  const groups = deriveCitations(msg(blocks, { symbols: ["TCS"] }));

  assert.deepEqual(
    groups.map((g) => g.key),
    ["web", "filings", "tools", "symbols", "reports"]
  );
  assert.deepEqual(
    groups.map((g) => g.title),
    [
      "WEB",
      "DATABASE / FILINGS",
      "DATA TOOLS RUN",
      "INSTRUMENTS",
      "REPORTS & PAGES",
    ]
  );

  // Cites: web 1 → filings 2,3 → report news continues at 4.
  const web = group(groups, "web");
  assert.deepEqual(
    web.rows.map((r) => [r.title, r.cite]),
    [
      ["Q4 beat", 1],
      ["Margin outlook", 4],
    ]
  );

  const filings = group(groups, "filings");
  assert.deepEqual(
    filings.rows.map((r) => [
      r.cite,
      r.title,
      r.href,
      r.date,
      r.snippet,
      r.source,
      r.kind,
    ]),
    [
      [
        2,
        "Dividend declared",
        "https://nsearchives.nseindia.com/f1.pdf",
        "2026-05-30",
        "Final dividend Rs 22",
        "NSE Corporate Filings",
        "filing",
      ],
      [
        3,
        "AGM",
        NSE_BOARD_MEETINGS_PAGE,
        "2026-06-20",
        "AGM",
        "NSE Corporate Filings",
        "filing",
      ],
    ]
  );

  // Filing tools also count as tools-run; failed tasks don't; report-only
  // dataSources append after.
  const tools = group(groups, "tools");
  assert.deepEqual(
    tools.rows.map((r) => r.source),
    [
      "fetch_exchange_announcements",
      "fetch_shareholder_meetings",
      "peer_comparison",
    ]
  );

  assert.deepEqual(
    group(groups, "symbols").rows.map((r) => r.title),
    ["TCS", "INFY"]
  );
  assert.deepEqual(
    group(groups, "reports").rows.map((r) => [r.id, r.href]),
    [["report-self", "/analysis/sess-42"]]
  );
});
