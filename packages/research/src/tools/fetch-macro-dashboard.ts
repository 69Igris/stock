/**
 * Fetch Macro Dashboard — DB-FIRST, live RBI fallback (MONEY-1204 / 14e.2).
 *
 * Indian macro snapshot: repo rate, CPI, WPI, forex reserves, IIP, G-Sec yield.
 *
 * ## Why the order flipped
 *
 * The tool hit the RBI DBIE pages live with a STATIC fallback baked into the
 * client, and had ZERO Prisma references — which means when the scrape failed
 * it confidently returned hard-coded numbers with no marker saying so. We now
 * ingest the same observations into `MacroSeries`, keyed
 * `@@unique([seriesId, period])`, with the unit and frequency stored PER ROW
 * because one RBI page mixes PERCENT, INDEX, INR_CRORE and USD_MILLION and a
 * bare float is uninterpretable without them.
 *
 * Two properties of `MacroSeries` the live path cannot offer, and the reason
 * the DB is primary:
 *
 *   * `period` is what the observation is ABOUT, not when we fetched it. Every
 *     one of these pages shows several past periods at once, so conflating the
 *     two is the wrong-granularity trap that made the F&O summaries report
 *     success over a 456-day hole (MONEY-1189).
 *   * `label` is the upstream row text VERBATIM, base-year parenthetical
 *     included ("Wholesale Price Index (2022-23=100)"), which is what makes a
 *     REBASE discontinuity discoverable instead of invisible.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  fetchMacroSnapshot,
  type MacroSnapshot,
} from "../data-sources/rbi-client";
import {
  dbFirstWithLiveFallback,
  latestPerSeries,
  newestAsOf,
  num,
  type CitedRows,
  type MacroRow,
} from "../data-sources/market-structure-logic";

/** Canonical `MacroSeries.seriesId`s the dashboard reads. Stable forever — the
 *  id is half the unique key, so renaming one FORKS the series in place. */
export const MACRO_DASHBOARD_SERIES = [
  "RBI_REPO_RATE",
  "MOSPI_CPI_COMBINED",
  "OEA_WPI_ALL_COMMODITIES",
  "RBI_FOREX_RESERVES_TOTAL_USD_MN",
  "RBI_FOREX_RESERVES_TOTAL_INR_CR",
  "MOSPI_IIP_GENERAL",
  "RBI_GSEC_10Y_YIELD",
] as const;

/** ISO instant for a period the live snapshot describes only loosely. */
function periodIso(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * The live RBI snapshot → the same `MacroRow` shape the DB returns.
 *
 * `period` falls back to null-safe parsing of the snapshot's own date string.
 * A live row whose period cannot be parsed is DROPPED rather than stamped with
 * the fetch day — stamping it would assert that today's reading describes
 * today, which for a monthly CPI print is false by up to six weeks.
 */
export function snapshotToMacroRows(
  snapshot: MacroSnapshot | null,
): MacroRow[] {
  if (!snapshot) return [];
  const out: MacroRow[] = [];
  const push = (
    seriesId: string,
    value: unknown,
    unit: string,
    frequency: string,
    label: string,
    rawPeriod: unknown,
  ): void => {
    const v = num(value);
    const period = periodIso(rawPeriod);
    if (v === null || period === null) return;
    out.push({
      seriesId,
      period,
      value: v,
      unit,
      frequency,
      label,
      releasedOn: null,
      source: "rbi-live",
    });
  };

  push(
    "RBI_REPO_RATE",
    snapshot.repoRate?.value,
    "PERCENT",
    "MONTHLY",
    "Repo Rate",
    snapshot.repoRate?.date,
  );
  push(
    "MOSPI_CPI_COMBINED",
    snapshot.cpi?.value,
    "PERCENT",
    "MONTHLY",
    "CPI (Combined)",
    snapshot.cpi?.date,
  );
  push(
    "RBI_FOREX_RESERVES_TOTAL_USD_MN",
    snapshot.forexReserves?.value,
    snapshot.forexReserves?.unit ?? "USD_MILLION",
    "WEEKLY",
    "Forex Reserves",
    snapshot.forexReserves?.date,
  );
  if (snapshot.iip) {
    push(
      "MOSPI_IIP_GENERAL",
      snapshot.iip.value,
      "PERCENT",
      "MONTHLY",
      "IIP (General)",
      snapshot.iip.date,
    );
  }
  return out;
}

/**
 * DB-first resolution, exported so the ordering is unit-testable against the
 * SAME code `execute` runs.
 */
export async function resolveMacroDashboard(
  dbFetch: () => Promise<CitedRows<MacroRow> | null>,
  liveFetch: () => Promise<MacroSnapshot | null>,
): Promise<CitedRows<MacroRow>> {
  return dbFirstWithLiveFallback<MacroRow>(
    dbFetch,
    async () => {
      const rows = snapshotToMacroRows(await liveFetch());
      return {
        rows,
        asOf: newestAsOf(rows),
        provenance: { origin: "LIVE", source: "RBI DBIE + MOSPI (live)" },
      };
    },
    {
      source: "MacroSeries",
      emptyNote:
        "Neither the synced `MacroSeries` table nor the live RBI pages returned an observation.",
    },
  );
}

export const fetchMacroDashboardTool: ResearchToolDef = {
  name: "fetch_macro_dashboard",
  description:
    "Fetch Indian macro-economic dashboard - repo rate, CPI, WPI, forex reserves, IIP, G-Sec yield - DB-first from MacroSeries, live RBI as fallback",
  category: "data",
  parameters: {
    seriesIds: {
      type: "string[]",
      description:
        "Optional MacroSeries ids to restrict to (e.g. RBI_REPO_RATE). Omit for the standard dashboard set.",
      required: false,
    },
    history: {
      type: "boolean",
      description:
        "Return the full period history instead of only the latest observation per series",
      required: false,
      default: false,
    },
  },
  cacheTTL: 86_400, // 24 hours
  execute: async (params): Promise<ToolOutput> => {
    const requested = Array.isArray(params.seriesIds)
      ? (params.seriesIds as unknown[]).filter(
          (s): s is string => typeof s === "string" && s.trim() !== "",
        )
      : [];
    const seriesIds =
      requested.length > 0 ? requested : [...MACRO_DASHBOARD_SERIES];
    const history = params.history === true;

    const cited = await resolveMacroDashboard(
      // Lazy import inside the thunk — see the MONEY-1060 note in
      // fetch-fii-dii-flows.ts.
      async () => {
        const { getMacroFromDb } =
          await import("../data-sources/market-structure-store");
        return getMacroFromDb({ seriesIds });
      },
      () => fetchMacroSnapshot(),
    );

    const rows = history ? cited.rows : latestPerSeries(cited.rows);

    return {
      success: true,
      data: {
        rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        summary: buildMacroSummary(rows),
      },
      metadata: {
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        fallback: cited.provenance.fallback === true,
        recordCount: rows.length,
        seriesIds,
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};

/**
 * Human-readable summary of the macro environment.
 *
 * Built ONLY from series that are actually present. The previous version read
 * `snapshot.repoRate.value` unconditionally, which meant a scrape failure fell
 * through to hard-coded constants and produced a confident sentence about a
 * repo rate nobody had read. A missing series now simply produces no sentence.
 */
function buildMacroSummary(rows: readonly MacroRow[]): string {
  const by = new Map(rows.map((r) => [r.seriesId, r]));
  const parts: string[] = [];

  const repo = by.get("RBI_REPO_RATE");
  if (repo) {
    parts.push(
      `RBI repo rate is ${repo.value}% (period ${repo.period.slice(0, 10)}).`,
    );
  }

  const cpi = by.get("MOSPI_CPI_COMBINED");
  if (cpi) {
    if (cpi.value <= 4) {
      parts.push(
        `CPI inflation at ${cpi.value}% is within RBI's 4% target - accommodative policy likely.`,
      );
    } else if (cpi.value <= 6) {
      parts.push(
        `CPI inflation at ${cpi.value}% is within the RBI tolerance band (2-6%) - status quo likely.`,
      );
    } else {
      parts.push(
        `CPI inflation at ${cpi.value}% exceeds the upper tolerance band (6%) - tightening risk.`,
      );
    }
  }

  const wpi = by.get("OEA_WPI_ALL_COMMODITIES");
  if (wpi) {
    parts.push(`WPI stands at ${wpi.value} (${wpi.label}).`);
  }

  const forexUsd = by.get("RBI_FOREX_RESERVES_TOTAL_USD_MN");
  if (forexUsd) {
    parts.push(
      `Forex reserves stand at ${forexUsd.value} ${forexUsd.unit === "USD_MILLION" ? "USD million" : forexUsd.unit}.`,
    );
  }

  const iip = by.get("MOSPI_IIP_GENERAL");
  if (iip) parts.push(`IIP (general) reads ${iip.value}.`);

  const gsec = by.get("RBI_GSEC_10Y_YIELD");
  if (gsec) {
    parts.push(`10-year G-Sec yield (risk-free rate) is ${gsec.value}%.`);
  }

  if (parts.length === 0) {
    return "No macro observations are available for the requested series.";
  }
  return parts.join(" ");
}
