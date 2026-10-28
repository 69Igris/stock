/**
 * Chat Block Validation Schemas
 *
 * Zod schemas for validating JSON content blocks parsed from LLM responses.
 */

import { z } from "zod";

// ============== Table Block ==============

export const TableColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  align: z.enum(["left", "center", "right"]).optional(),
  format: z
    .enum(["currency", "pnl", "percentage", "number", "date", "text"])
    .optional(),
});

export const TableBlockSchema = z.object({
  title: z.string().optional(),
  columns: z.array(TableColumnSchema).min(1),
  rows: z.array(z.record(z.unknown())).min(1),
  maxRows: z.number().int().positive().optional(),
});

// ============== Card Block ==============

export const CardItemSchema = z.object({
  label: z.string(),
  value: z.string(),
  format: z.enum(["currency", "pnl", "percentage", "text"]).optional(),
});

export const CardBlockSchema = z.object({
  variant: z.enum(["metric", "stock", "mf", "info"]),
  title: z.string(),
  value: z.string().optional(),
  subtitle: z.string().optional(),
  change: z.number().optional(),
  changeLabel: z.string().optional(),
  icon: z.string().optional(),
  items: z.array(CardItemSchema).optional(),
});

// ============== Chart Block ==============

export const ChartYKeySchema = z.object({
  key: z.string(),
  label: z.string(),
  color: z.string().optional(),
  format: z.enum(["currency", "pnl", "percentage", "number"]).optional(),
});

export const ChartBlockSchema = z.object({
  chartType: z.enum(["area", "line", "bar", "pie"]),
  title: z.string().optional(),
  data: z.array(z.record(z.unknown())).min(1),
  xKey: z.string(),
  yKeys: z.array(ChartYKeySchema).min(1),
  height: z.number().int().positive().optional(),
});

// ============== Action Block ==============

export const ActionBlockSchema = z.object({
  actionId: z.string(),
  tool: z.string(),
  description: z.string(),
  params: z.record(z.unknown()),
  status: z
    .enum(["pending", "confirmed", "cancelled", "executed", "failed"])
    .default("pending"),
  result: z.string().optional(),
});

// ============== Navigation Block ==============

export const NavigationLinkSchema = z.object({
  label: z.string(),
  href: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
});

export const NavigationBlockSchema = z.object({
  links: z.array(NavigationLinkSchema).min(1),
});

// ============== Comparison Block ==============

export const ComparisonItemSchema = z.object({
  name: z.string(),
  subtitle: z.string().optional(),
  icon: z.string().optional(),
});

export const ComparisonMetricSchema = z.object({
  label: z.string(),
  values: z.array(z.string()),
  format: z.enum(["currency", "pnl", "percentage", "text"]).optional(),
  highlight: z.enum(["higher", "lower"]).optional(),
});

export const ComparisonBlockSchema = z.object({
  title: z.string().optional(),
  items: z.array(ComparisonItemSchema).min(2),
  metrics: z.array(ComparisonMetricSchema).min(1),
});

// ============== Error Block ==============

export const ErrorBlockSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  title: z.string(),
  message: z.string().optional(),
});

// ============== Block Type to Schema Map ==============

export const BLOCK_SCHEMAS: Record<string, z.ZodSchema> = {
  table: TableBlockSchema,
  card: CardBlockSchema,
  chart: ChartBlockSchema,
  action: ActionBlockSchema,
  navigation: NavigationBlockSchema,
  comparison: ComparisonBlockSchema,
  error: ErrorBlockSchema,
};

/**
 * Rich typed blocks from the StockSage design (MONEY-587). The LLM may emit
 * these directly via :::block:TYPE markers. They don't have a strict Zod schema
 * yet and their renderers (TypedFinancialBlocks) are defensive about missing
 * fields, so we pass them through after a minimal object-shape sanity check
 * rather than rejecting them as "unknown" (which renders raw JSON).
 */
export const PASSTHROUGH_BLOCK_TYPES = new Set<string>([
  "holdings",
  "portfolio",
  "tax",
  "risk",
  "mf",
  "fire",
  "sector",
  "technical",
  "news",
  "scorecard",
  "pnl",
  "dividend",
  "stock-list",
]);

/**
 * Validate a parsed block JSON against its schema
 */
export function validateBlockData(
  blockType: string,
  data: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  const schema = BLOCK_SCHEMAS[blockType];
  if (schema) {
    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      error: result.error.issues.map((i) => i.message).join(", "),
    };
  }

  if (PASSTHROUGH_BLOCK_TYPES.has(blockType)) {
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return { success: true, data };
    }
    return { success: false, error: `${blockType} block must be an object` };
  }

  return { success: false, error: `Unknown block type: ${blockType}` };
}
