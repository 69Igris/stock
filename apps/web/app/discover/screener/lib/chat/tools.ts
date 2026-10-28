import { Type, type FunctionDeclaration, type Schema } from "@google/genai";
import {
  STOCK_FIELDS,
  MF_FIELDS,
  ETF_FIELDS,
  STOCK_SORTS,
  FUND_SORTS,
  type FieldSpec,
} from "./filters";

/* =====================================================================
   Screener chat — Gemini tool schema  (MONEY-1078)
   ---------------------------------------------------------------------
   Function declarations handed to Gemini. Each `name` must have a
   matching case in `toolExecutor.ts`.

   The per-mode filter properties are GENERATED from the FieldSpec vocab
   in ./filters.ts, so the schema the model reads and the executor's
   allowlist/clamps share ONE source of truth (the same pattern as
   FIRE_BOUNDS interpolation in the FIRE tools).

   Gemini gotcha (inherited from the FIRE tools): an OBJECT schema with
   EMPTY `properties` is rejected with 400 INVALID_ARGUMENT — so no-arg
   tools like `clearFilters` must omit `parameters` entirely.
   ===================================================================== */

function specToSchema(spec: FieldSpec): Schema {
  if (spec.kind === "number") {
    return {
      type: Type.NUMBER,
      description: `${spec.unit}, allowed ${spec.min}–${spec.max}. Bare number.`,
    };
  }
  if (spec.kind === "enum") {
    return {
      type: Type.STRING,
      description: `One of: ${spec.values.map((v) => `"${v}"`).join(", ")}`,
    };
  }
  return {
    type: Type.STRING,
    description: `Free text, max ${spec.maxLen} chars`,
  };
}

function filterProps(
  fields: Record<string, FieldSpec>
): Record<string, Schema> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, spec]) => [key, specToSchema(spec)])
  );
}

const filterTool = (
  name: string,
  modeLabel: string,
  fields: Record<string, FieldSpec>
): FunctionDeclaration => ({
  name,
  description:
    `Merge filter criteria into the ${modeLabel} screen (switches to the ` +
    `${modeLabel} tab if not already active). Send ONLY the keys to change; ` +
    `existing filters are kept. Set a key to null to unset just that key.`,
  parameters: {
    type: Type.OBJECT,
    properties: filterProps(fields),
    // Deliberately no `required`: every criterion is optional; the model
    // sends whichever subset the user asked for.
  },
});

export const SCREENER_TOOLS: FunctionDeclaration[] = [
  filterTool("setStockFilters", "stocks", STOCK_FIELDS),
  filterTool("setMfFilters", "mutual funds", MF_FIELDS),
  filterTool("setEtfFilters", "ETFs", ETF_FIELDS),
  {
    name: "removeFilters",
    description:
      "Unset specific filter keys on the ACTIVE mode's screen, keeping the rest.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        keys: {
          type: Type.ARRAY,
          description:
            "Filter keys to unset (from the active mode's vocabulary)",
          items: { type: Type.STRING },
        },
      },
      required: ["keys"],
    },
  },
  {
    // No `parameters`: Gemini rejects an OBJECT schema with empty properties.
    name: "clearFilters",
    description:
      "Remove ALL filters from the ACTIVE mode's screen (search query and sort are kept).",
  },
  {
    name: "setSearchQuery",
    description:
      "Set the free-text search box (symbol/name search). Pass an empty string to clear it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search text, e.g. "RELIANCE" or "bluechip". "" clears.',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "setSort",
    description:
      "Change the result ordering of the ACTIVE mode. Valid keys — stocks: " +
      `${STOCK_SORTS.join(", ")}. MF/ETF: ${FUND_SORTS.join(", ")}.`,
    parameters: {
      type: Type.OBJECT,
      properties: {
        sort: {
          type: Type.STRING,
          description: "Sort key valid for the active mode",
        },
      },
      required: ["sort"],
    },
  },
  {
    name: "switchMode",
    description:
      "Switch the active screener tab WITHOUT changing filters. (The set*Filters tools already switch mode themselves — only use this to just look at another tab.)",
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: 'One of: "stocks", "mf", "etf"',
        },
      },
      required: ["mode"],
    },
  },
];
