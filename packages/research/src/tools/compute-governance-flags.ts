/**
 * Governance Flags Aggregator
 *
 * PURE compute tool. Composes already-fetched governance inputs
 * (shareholding pattern, promoter pledging, promoter holding,
 * corporate actions, related-party data) into a single set of
 * factual governance flags + a 0-100 governanceScore and A-F grade.
 *
 * No network/db/io: every input is injected by the executor from
 * upstream fetch results. Emits OBSERVATIONS / SCORES / FLAGS only -
 * no buy/sell/hold/target-price language (SEBI: UseMoney is not a
 * registered Research Analyst).
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Result Interface ───────────────────────────────────────

export type GovernanceFlagSeverity = "red" | "amber" | "green";

export type GovernanceFlagCategory =
  | "promoter_pledging"
  | "promoter_holding"
  | "promoter_trend"
  | "institutional_flow"
  | "equity_dilution"
  | "related_party"
  | "public_float"
  | "board_audit";

export interface GovernanceFlag {
  severity: GovernanceFlagSeverity;
  category: GovernanceFlagCategory;
  message: string;
  source: string;
}

export interface GovernanceFlagsResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** 0-100; starts at 70, penalised for reds/ambers, rewarded for clean signals */
  governanceScore: number;
  /** A (>=85) … F (<40) */
  grade: "A" | "B" | "C" | "D" | "F";
  redCount: number;
  amberCount: number;
  greenCount: number;
  flags: GovernanceFlag[];
  /** which named inputs the executor actually supplied */
  inputsUsed: string[];
}

// ─── Narrowing helpers (pure) ───────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read a finite number from a record by trying multiple keys; undefined if none parse. */
function readNum(
  rec: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  if (!rec) return undefined;
  for (const key of keys) {
    const raw = rec[key];
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Tool ───────────────────────────────────────────────────

export const computeGovernanceFlagsTool: ResearchToolDef = {
  name: "compute_governance_flags",
  description:
    "Aggregate factual governance flags (pledging, promoter holding/trend, dilution, related-party, float, board/audit) into a 0-100 score and A-F grade",
  category: "computation",
  parameters: {
    shareholding: {
      type: "object",
      description:
        "Shareholding pattern result from fetch_shareholding_pattern (promoter/fii/dii/public trend, pledgedPercent, quarters)",
    },
    promoterPledging: {
      type: "object",
      description:
        "Promoter pledging result from fetch_promoter_pledging (promoterHolding, pledgedPercent, riskLevel)",
    },
    promoterHolding: {
      type: "object",
      description:
        "Promoter holding result from fetch_promoter_holding (current/previous holding %, share-count history for dilution)",
    },
    corporateActions: {
      type: "object",
      description:
        "Corporate actions from fetch_corporate_actions (array, or { data: [] }) - scanned for board/auditor changes, bonus/split dilution",
    },
    relatedParty: {
      type: "object",
      description:
        "Related-party result from fetch_related_party (presence/count/materiality of related-party transactions)",
    },
    symbol: {
      type: "string",
      description: "Optional stock symbol for labelling the result",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol = readString(params.symbol)?.toUpperCase();

      const shareholding = asRecord(params.shareholding);
      const promoterPledging = asRecord(params.promoterPledging);
      const promoterHolding = asRecord(params.promoterHolding);
      const relatedParty = asRecord(params.relatedParty);

      // corporateActions may arrive as an array directly or wrapped { data: [] }.
      const corpRec = asRecord(params.corporateActions);
      const corporateActions: unknown[] = Array.isArray(params.corporateActions)
        ? (params.corporateActions as unknown[])
        : corpRec
          ? asArray(corpRec.data ?? corpRec.actions)
          : [];

      const inputsUsed: string[] = [];
      if (shareholding) inputsUsed.push("shareholding");
      if (promoterPledging) inputsUsed.push("promoterPledging");
      if (promoterHolding) inputsUsed.push("promoterHolding");
      if (corporateActions.length) inputsUsed.push("corporateActions");
      if (relatedParty) inputsUsed.push("relatedParty");

      // Graceful degradation: no governance inputs at all.
      if (inputsUsed.length === 0) {
        const empty: GovernanceFlagsResult = {
          available: false,
          reason: "No governance inputs supplied",
          symbol,
          governanceScore: 0,
          grade: "F",
          redCount: 0,
          amberCount: 0,
          greenCount: 0,
          flags: [],
          inputsUsed: [],
        };
        return { success: true, data: empty };
      }

      const flags: GovernanceFlag[] = [];

      // ── 1. Promoter pledging ──────────────────────────────
      // Prefer dedicated pledging input, fall back to shareholding.pledgedPercent.
      const pledgedPercent =
        readNum(promoterPledging, ["pledgedPercent", "pledgedPercentage"]) ??
        readNum(shareholding, ["pledgedPercent"]);
      const pledgeSource = promoterPledging
        ? "fetch_promoter_pledging"
        : "fetch_shareholding_pattern";

      if (pledgedPercent != null) {
        if (pledgedPercent > 50) {
          flags.push({
            severity: "red",
            category: "promoter_pledging",
            message: `${round2(pledgedPercent)}% of promoter holding is pledged (>50%)`,
            source: pledgeSource,
          });
        } else if (pledgedPercent > 30) {
          flags.push({
            severity: "amber",
            category: "promoter_pledging",
            message: `${round2(pledgedPercent)}% of promoter holding is pledged (>30%)`,
            source: pledgeSource,
          });
        } else if (pledgedPercent > 0) {
          flags.push({
            severity: "amber",
            category: "promoter_pledging",
            message: `${round2(pledgedPercent)}% of promoter holding is pledged`,
            source: pledgeSource,
          });
        } else {
          flags.push({
            severity: "green",
            category: "promoter_pledging",
            message: "No promoter pledging reported",
            source: pledgeSource,
          });
        }
      }

      // ── 2. Promoter holding level (skin in the game) ──────
      // Try dedicated holding input, then pledging input, then shareholding trend.
      const promoterLevel =
        readNum(promoterHolding, [
          "promoterHolding",
          "current",
          "holding",
          "promoterPercent",
        ]) ??
        readNum(promoterPledging, ["promoterHolding", "promoterPercentage"]) ??
        readNum(asRecord(shareholding?.promoter), ["current"]);
      const holdingSource = promoterHolding
        ? "fetch_promoter_holding"
        : promoterPledging
          ? "fetch_promoter_pledging"
          : "fetch_shareholding_pattern";

      if (promoterLevel != null) {
        if (promoterLevel < 26) {
          flags.push({
            severity: "amber",
            category: "promoter_holding",
            message: `Low promoter holding (${round2(promoterLevel)}%, <26%) - limited skin in the game`,
            source: holdingSource,
          });
        } else if (promoterLevel >= 50) {
          flags.push({
            severity: "green",
            category: "promoter_holding",
            message: `Strong promoter holding (${round2(promoterLevel)}%)`,
            source: holdingSource,
          });
        }
      }

      // ── 3. Promoter QoQ trend (falling stake) ─────────────
      // shareholding.promoter.change is current - previous (positive = rising).
      const promoterChange =
        readNum(asRecord(shareholding?.promoter), ["change"]) ??
        readNum(promoterHolding, ["change", "qoqChange"]);
      if (promoterChange != null) {
        if (promoterChange <= -1) {
          flags.push({
            severity: "amber",
            category: "promoter_trend",
            message: `Promoter stake fell ${round2(Math.abs(promoterChange))}% QoQ`,
            source: "fetch_shareholding_pattern",
          });
        } else if (promoterChange > 0) {
          flags.push({
            severity: "green",
            category: "promoter_trend",
            message: `Promoter stake rose ${round2(promoterChange)}% QoQ`,
            source: "fetch_shareholding_pattern",
          });
        }
      }

      // ── 4. FII/DII institutional flow ─────────────────────
      const fiiChange = readNum(asRecord(shareholding?.fii), ["change"]);
      const diiChange = readNum(asRecord(shareholding?.dii), ["change"]);
      const instFlow =
        (fiiChange ?? 0) + (diiChange ?? 0);
      if (fiiChange != null || diiChange != null) {
        if (instFlow > 0.5) {
          flags.push({
            severity: "green",
            category: "institutional_flow",
            message: `Institutions added stake QoQ (FII ${round2(fiiChange ?? 0)}%, DII ${round2(diiChange ?? 0)}%)`,
            source: "fetch_shareholding_pattern",
          });
        } else if (instFlow < -0.5) {
          flags.push({
            severity: "amber",
            category: "institutional_flow",
            message: `Institutions reduced stake QoQ (FII ${round2(fiiChange ?? 0)}%, DII ${round2(diiChange ?? 0)}%)`,
            source: "fetch_shareholding_pattern",
          });
        }
      }

      // ── 5. Equity dilution (rising share count) ───────────
      // Look for a share-count history on promoterHolding/shareholding.
      const shareHistory = (
        asArray(
          promoterHolding?.shareCountHistory ??
            promoterHolding?.sharesOutstandingHistory ??
            shareholding?.shareCountHistory,
        )
          .map((v) => (typeof v === "number" ? v : Number(v)))
          .filter((n) => Number.isFinite(n) && n > 0)
      ) as number[];
      if (shareHistory.length >= 2) {
        const first = shareHistory[0]!;
        const last = shareHistory[shareHistory.length - 1]!;
        const dilutionPct = first > 0 ? ((last - first) / first) * 100 : 0;
        if (dilutionPct > 20) {
          flags.push({
            severity: "amber",
            category: "equity_dilution",
            message: `Share count rose ${round2(dilutionPct)}% over the window - frequent equity dilution`,
            source: "fetch_promoter_holding",
          });
        } else if (dilutionPct <= 5) {
          flags.push({
            severity: "green",
            category: "equity_dilution",
            message: "Share count broadly stable - minimal dilution",
            source: "fetch_promoter_holding",
          });
        }
      }

      // ── 6. Related-party presence ─────────────────────────
      if (relatedParty) {
        const rptCount = readNum(relatedParty, [
          "count",
          "transactionCount",
          "rptCount",
        ]);
        const rptPresent =
          relatedParty.present === true ||
          relatedParty.hasRelatedParty === true ||
          asArray(relatedParty.transactions).length > 0 ||
          (rptCount != null && rptCount > 0);
        const rptValue = readNum(relatedParty, [
          "materialityPercent",
          "rptToRevenuePercent",
          "percentOfRevenue",
        ]);
        if (rptValue != null && rptValue > 10) {
          flags.push({
            severity: "amber",
            category: "related_party",
            message: `Related-party transactions are material (${round2(rptValue)}% of revenue)`,
            source: "fetch_related_party",
          });
        } else if (rptPresent) {
          flags.push({
            severity: "amber",
            category: "related_party",
            message: rptCount
              ? `${rptCount} related-party transaction(s) disclosed - review for fairness`
              : "Related-party transactions disclosed - review for fairness",
            source: "fetch_related_party",
          });
        } else {
          flags.push({
            severity: "green",
            category: "related_party",
            message: "No material related-party transactions reported",
            source: "fetch_related_party",
          });
        }
      }

      // ── 7. Low public float ───────────────────────────────
      const publicLevel =
        readNum(asRecord(shareholding?.public), ["current"]) ??
        readNum(shareholding, ["publicPercent"]);
      if (publicLevel != null && publicLevel < 15) {
        flags.push({
          severity: "amber",
          category: "public_float",
          message: `Low public float (${round2(publicLevel)}%, <15%) - thin free float`,
          source: "fetch_shareholding_pattern",
        });
      }

      // ── 8. Board / auditor changes (from corporate actions) ─
      if (corporateActions.length) {
        const boardAuditPattern =
          /auditor|director|board|management|resignation|appointment|chairman|managing\s*director|cfo|company\s*secretary/i;
        for (const action of corporateActions) {
          const rec = asRecord(action);
          if (!rec) continue;
          const purpose =
            readString(rec.purpose) ??
            readString(rec.details) ??
            readString(rec.subject);
          if (purpose && boardAuditPattern.test(purpose)) {
            const exDate = readString(rec.exDate) ?? readString(rec.date);
            flags.push({
              severity: "amber",
              category: "board_audit",
              message: `Board/auditor change noted${exDate ? ` (${exDate})` : ""}: ${purpose}`,
              source: "fetch_corporate_actions",
            });
            break; // one flag is enough to surface the observation
          }
        }
      }

      // ── Scoring ───────────────────────────────────────────
      const redCount = flags.filter((f) => f.severity === "red").length;
      const amberCount = flags.filter((f) => f.severity === "amber").length;
      const greenCount = flags.filter((f) => f.severity === "green").length;

      let governanceScore = 70;
      governanceScore -= redCount * 25;
      governanceScore -= amberCount * 8;
      governanceScore += greenCount * 5;
      governanceScore = Math.max(0, Math.min(100, Math.round(governanceScore)));

      const grade: GovernanceFlagsResult["grade"] =
        governanceScore >= 85
          ? "A"
          : governanceScore >= 70
            ? "B"
            : governanceScore >= 55
              ? "C"
              : governanceScore >= 40
                ? "D"
                : "F";

      const result: GovernanceFlagsResult = {
        available: true,
        symbol,
        governanceScore,
        grade,
        redCount,
        amberCount,
        greenCount,
        flags,
        inputsUsed,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Governance flags aggregation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
