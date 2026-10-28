/**
 * `fetch_us_filings` — the SEC filing ledger for one company (MONEY-979, T10).
 *
 * DB-only, no egress. Rows come from `us_filings`, which is fed by the
 * detection loop and reconciled nightly against `submissions.zip`.
 *
 * ## Two timestamps, and only one of them can measure anything
 *
 * `filedAt` is the FILING DATE — a calendar day at SEC. `acceptedAt` is the
 * acceptance TIMESTAMP. A filing accepted at 21:53 ET is DATED the next
 * business day once it lands after the 17:30/22:00 ET cutoffs, so a latency
 * computed from `filedAt` would be NEGATIVE roughly every evening. Both are
 * returned; the description says which is which so a model does not subtract
 * the wrong one.
 *
 * ## `status` is not decoration
 *
 * `INDEXED` means the nightly ledger knows about a filing that no live detector
 * saw — the gap that proves the detection loop missed something. `WITHDRAWN` is
 * set by the weekly full-index reconcile, because SEC's DAILY index files are
 * never corrected and post-acceptance deletions appear only in the Saturday
 * rebuild. A withdrawn filing presented as a live one is a real misstatement.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { usToolMetadata, type UsToolResult } from "./fetch-us-financials";

/** Forms a research plan usually wants, by name. */
export const US_FORM_PRESETS: Readonly<Record<string, readonly string[]>> = {
  annual: ["10-K", "10-K/A", "20-F", "40-F"],
  quarterly: ["10-Q", "10-Q/A"],
  results: ["10-K", "10-Q", "8-K"],
  events: ["8-K", "8-K/A"],
  insider: ["3", "4", "5"],
  ownership: ["SC 13D", "SC 13G", "SCHEDULE 13D", "SCHEDULE 13G"],
  institutional: ["13F-HR", "13F-HR/A"],
};

/**
 * A `forms` parameter → the concrete form list.
 *
 * Accepts a preset name, a comma-separated string, or an array. BOTH 13D
 * spellings are in the `ownership` preset on purpose: filings before the
 * 2024-12-18 XML mandate are `SC 13D` and after it `SCHEDULE 13D`, and a filter
 * that knows only one spelling silently drops half the history.
 */
export function resolveUsForms(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : String(value).split(",");
  const out = new Set<string>();
  for (const item of raw) {
    const token = item.trim();
    if (token === "") continue;
    const preset = US_FORM_PRESETS[token.toLowerCase()];
    if (preset) {
      for (const form of preset) out.add(form);
    } else {
      out.add(token.toUpperCase());
    }
  }
  return [...out];
}

/** The pure half: a repository result → a `ToolOutput`. */
export function buildUsFilingsOutput(args: {
  symbol: string | null;
  cik10: string | null;
  forms: readonly string[];
  result: UsToolResult<Record<string, unknown>>;
}): ToolOutput {
  return {
    success: true,
    data: {
      symbol: args.symbol,
      cik10: args.cik10,
      forms: [...args.forms],
      rows: args.result.rows,
      asOf: args.result.asOf,
      note: "`filedAt` is SEC's filing DATE (a calendar day); `acceptedAt` is the acceptance TIMESTAMP. Only acceptedAt can measure how long ago a filing landed - a filing accepted after the evening cutoff is dated the next business day. A row with status WITHDRAWN was deleted post-acceptance and must not be cited as live.",
    },
    metadata: usToolMetadata(args.result, {
      symbol: args.symbol,
      cik10: args.cik10,
      forms: [...args.forms],
    }),
  };
}

export const fetchUsFilingsTool: ResearchToolDef = {
  name: "fetch_us_filings",
  description:
    "List a US company's SEC filings (10-K, 10-Q, 8-K, Forms 3/4/5, 13D/G, 13F) with accession, filing date, acceptance timestamp, 8-K item numbers and parse status. Accepts form presets: annual, quarterly, results, events, insider, ownership, institutional.",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "US ticker, e.g. AAPL. Either symbol or cik10 is required.",
      required: false,
    },
    cik10: {
      type: "string",
      description: "SEC Central Index Key. Either symbol or cik10 is required.",
      required: false,
    },
    forms: {
      type: "string",
      description:
        "Form list or preset name (annual | quarterly | results | events | insider | ownership | institutional). Omit for all forms.",
      required: false,
    },
    from: {
      type: "string",
      description: "ISO date lower bound on filedAt",
      required: false,
    },
    to: {
      type: "string",
      description: "ISO date upper bound on filedAt",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum filings to return (default: 50)",
      required: false,
      default: 50,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol ? String(params.symbol).trim() : null;
    const cik10 = params.cik10 ? String(params.cik10).trim() : null;
    if (!symbol && !cik10) {
      return { success: false, error: "symbol or cik10 is required" };
    }

    const forms = resolveUsForms(params.forms);
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 50;

    const { getFilings } = await import("@usemoney/core/us-fundamentals");
    const result = await getFilings({
      symbol,
      cik10,
      forms,
      from: params.from ? String(params.from) : null,
      to: params.to ? String(params.to) : null,
      limit,
    });

    return buildUsFilingsOutput({
      symbol,
      cik10,
      forms,
      result: result as unknown as UsToolResult<Record<string, unknown>>,
    });
  },
};
