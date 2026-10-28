/**
 * Chat Format Utilities
 *
 * Formatting helpers for currency (INR), PnL coloring, percentages, and dates.
 */

/**
 * Format a number as INR currency
 */
export function formatChatCurrency(value: number | string): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Format a PnL value with +/- prefix and color class
 */
export function formatChatPnL(value: number | string): {
  text: string;
  colorClass: string;
} {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return { text: String(value), colorClass: "text-slate-400" };

  const formatted = formatChatCurrency(Math.abs(num));
  const isPositive = num >= 0;

  return {
    text: isPositive ? `+${formatted}` : `-${formatted.replace("₹", "₹")}`,
    colorClass: isPositive ? "text-emerald-500" : "text-red-500",
  };
}

/**
 * Format a percentage with +/- prefix and color class
 */
export function formatChatPercentage(value: number | string): {
  text: string;
  colorClass: string;
} {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return { text: String(value), colorClass: "text-slate-400" };

  return {
    text: `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`,
    colorClass: num >= 0 ? "text-emerald-500" : "text-red-500",
  };
}

/**
 * Format a number with Indian numbering system
 */
export function formatChatNumber(value: number | string): string {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return String(value);
  return new Intl.NumberFormat("en-IN").format(num);
}

/**
 * Format a compact number (1.5L, 2.3Cr)
 */
export function formatCompact(value: number): string {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)}Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(2)}L`;
  if (value >= 1000) return `₹${(value / 1000).toFixed(1)}K`;
  return `₹${value}`;
}

/**
 * Format a date in Indian locale
 */
export function formatChatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Format a cell value based on format type
 */
export function formatCellValue(
  value: unknown,
  format?: string
): { text: string; colorClass?: string } {
  if (value === null || value === undefined) {
    return { text: "-" };
  }

  switch (format) {
    case "currency":
      return { text: formatChatCurrency(value as number) };
    case "pnl":
      return formatChatPnL(value as number);
    case "percentage":
      return formatChatPercentage(value as number);
    case "number":
      return { text: formatChatNumber(value as number) };
    case "date":
      return { text: formatChatDate(value as string) };
    default:
      if (typeof value === "object") {
        return { text: JSON.stringify(value) };
      }
      return { text: String(value) };
  }
}
