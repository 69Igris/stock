import type { TourDefinition } from "@/components/walkthrough/types";
import { v1Core } from "./v1-core";
import { v1Documents } from "./v1-documents";
import { v1Fire } from "./v1-fire";
import { v1Holdings } from "./v1-holdings";
import { v1HoldingsFunds } from "./v1-holdings-funds";
import { v1HoldingsPositions } from "./v1-holdings-positions";
// TODO: paper-trading entry points removed 2026-05-28 per product decision — re-enable if it comes back.
// import { v1Paper } from "./v1-paper";
// import { v1PaperChat } from "./v1-paper-chat";
// import { v1PaperHistory } from "./v1-paper-history";
// import { v1PaperPositions } from "./v1-paper-positions";
// import { v1PaperTerminal } from "./v1-paper-terminal";
import { v1Roast } from "./v1-roast";
import { v1Screener } from "./v1-screener";
import { v1ScreenerEtf } from "./v1-screener-etf";
import { v1ScreenerMf } from "./v1-screener-mf";
import { v1Tradebook } from "./v1-tradebook";
import { v1TradebookExport } from "./v1-tradebook-export";
import { v1TradebookHistory } from "./v1-tradebook-history";
import { v1TradebookImport } from "./v1-tradebook-import";

export const CURRENT_WALKTHROUGH_VERSION = "v1-core";

export const KNOWN_WALKTHROUGH_VERSIONS = [
  "v1-core",
  "v1-roast",
  "v1-screener",
  "v1-screener-mf",
  "v1-screener-etf",
  "v1-fire",
  "v1-holdings",
  "v1-holdings-funds",
  "v1-holdings-positions",
  // TODO: paper-trading entry points removed 2026-05-28 per product decision — re-enable if it comes back.
  // "v1-paper",
  // "v1-paper-chat",
  // "v1-paper-terminal",
  // "v1-paper-positions",
  // "v1-paper-history",
  "v1-tradebook",
  "v1-tradebook-import",
  "v1-tradebook-history",
  "v1-tradebook-export",
  "v1-documents",
] as const;
export type KnownWalkthroughVersion =
  (typeof KNOWN_WALKTHROUGH_VERSIONS)[number];

export function isKnownWalkthroughVersion(
  v: string
): v is KnownWalkthroughVersion {
  return (KNOWN_WALKTHROUGH_VERSIONS as readonly string[]).includes(v);
}

export const TOUR_REGISTRY: Record<string, TourDefinition> = {
  "v1-core": v1Core,
  "v1-roast": v1Roast,
  "v1-screener": v1Screener,
  "v1-screener-mf": v1ScreenerMf,
  "v1-screener-etf": v1ScreenerEtf,
  "v1-fire": v1Fire,
  "v1-holdings": v1Holdings,
  "v1-holdings-funds": v1HoldingsFunds,
  "v1-holdings-positions": v1HoldingsPositions,
  // TODO: paper-trading entry points removed 2026-05-28 per product decision — re-enable if it comes back.
  // "v1-paper": v1Paper,
  // "v1-paper-chat": v1PaperChat,
  // "v1-paper-terminal": v1PaperTerminal,
  // "v1-paper-positions": v1PaperPositions,
  // "v1-paper-history": v1PaperHistory,
  "v1-tradebook": v1Tradebook,
  "v1-tradebook-import": v1TradebookImport,
  "v1-tradebook-history": v1TradebookHistory,
  "v1-tradebook-export": v1TradebookExport,
  "v1-documents": v1Documents,
};

export const TOUR_LIST: TourDefinition[] = Object.values(TOUR_REGISTRY);

export function getTourByVersion(version: string): TourDefinition | null {
  return TOUR_REGISTRY[version] ?? null;
}

export function getActionEventNames(): string[] {
  const names = new Set<string>();
  for (const tour of TOUR_LIST) {
    if (tour.trigger.kind === "action") {
      names.add(tour.trigger.eventName);
    }
  }
  return Array.from(names);
}

export {
  v1Core,
  v1Roast,
  v1Screener,
  v1ScreenerMf,
  v1ScreenerEtf,
  v1Fire,
  v1Holdings,
  v1HoldingsFunds,
  v1HoldingsPositions,
  // TODO: paper-trading entry points removed 2026-05-28 per product decision — re-enable if it comes back.
  // v1Paper,
  // v1PaperChat,
  // v1PaperTerminal,
  // v1PaperPositions,
  // v1PaperHistory,
  v1Tradebook,
  v1TradebookImport,
  v1TradebookHistory,
  v1TradebookExport,
  v1Documents,
};
