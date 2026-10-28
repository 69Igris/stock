"use client";

import { Calendar } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";

interface FYSelectorProps {
  selectedFY: string;
  onFYChange: (fy: string) => void;
}

/**
 * Generate the current FY in "YYYY-YY" format.
 * FY runs Apr 1 to Mar 31.
 */
function getCurrentFY(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const fyStartYear = month >= 3 ? year : year - 1;
  const fyEndYear = fyStartYear + 1;
  return `${fyStartYear}-${String(fyEndYear).slice(-2)}`;
}

/**
 * Generate last N FY options (current + previous).
 * Returns array of { value: "2025-26", label: "FY 2025-26" }
 */
function generateFYOptions(
  count: number
): Array<{ value: string; label: string }> {
  const currentFY = getCurrentFY();
  const [startStr] = currentFY.split("-");
  const currentStartYear = parseInt(startStr!);

  const options: Array<{ value: string; label: string }> = [];
  for (let i = 0; i < count; i++) {
    const startYear = currentStartYear - i;
    const endYear = startYear + 1;
    const value = `${startYear}-${String(endYear).slice(-2)}`;
    options.push({
      value,
      label: `FY ${startYear}-${String(endYear).slice(-2)}`,
    });
  }
  return options;
}

export default function FYSelector({
  selectedFY,
  onFYChange,
}: FYSelectorProps) {
  const fyOptions = generateFYOptions(5);

  return (
    <div className="flex items-center gap-2">
      <Calendar className="h-4 w-4 text-[var(--ink-3)]" />
      <Select value={selectedFY} onValueChange={onFYChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Select FY" />
        </SelectTrigger>
        <SelectContent>
          {fyOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { getCurrentFY };
