"use client";

import { useState } from "react";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@usemoney/ui/popover";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

interface PaginationControlsProps {
  /** 0-indexed current page */
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  totalItems: number;
  label?: string;
}

/**
 * Generates visible page numbers (0-indexed) with ellipsis gaps.
 * Always shows first, last, and up to 3 around current.
 */
function getPageNumbers(
  current: number,
  total: number,
): Array<number | "ellipsis-before" | "ellipsis-after"> {
  if (total <= 1) return [0];
  if (total <= 5) return Array.from({ length: total }, (_, i) => i);

  const pages = new Set<number>();
  pages.add(0);
  pages.add(total - 1);
  for (let i = current - 1; i <= current + 1; i++) {
    if (i >= 0 && i < total) pages.add(i);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const result: Array<number | "ellipsis-before" | "ellipsis-after"> = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1];
    if (i > 0 && prev !== undefined && cur - prev > 1) {
      result.push(
        i <= sorted.indexOf(current) ? "ellipsis-before" : "ellipsis-after",
      );
    }
    result.push(cur);
  }

  return result;
}

function GotoPopover({
  min,
  max,
  onGoto,
}: {
  min: number;
  max: number;
  onGoto: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-8 h-8 p-0">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-32 p-2">
        <Input
          type="number"
          min={min}
          max={max}
          placeholder="Page"
          className="h-8 text-center"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const val = parseInt((e.target as HTMLInputElement).value);
              if (val >= min && val <= max) {
                onGoto(val - 1);
                setOpen(false);
              }
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function PaginationControls({
  currentPage,
  totalPages,
  onPageChange,
  pageSize,
  totalItems,
  label = "posts",
}: PaginationControlsProps) {
  if (totalItems === 0) return null;

  const start = currentPage * pageSize + 1;
  const end = Math.min((currentPage + 1) * pageSize, totalItems);
  const pageNumbers = getPageNumbers(currentPage, totalPages);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3">
      <span className="text-sm text-muted-foreground">
        Showing {start}–{end} of {totalItems} {label}
      </span>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(Math.max(0, currentPage - 1))}
            disabled={currentPage === 0}
            className="w-8 h-8 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {pageNumbers.map((item, idx) => {
            if (item === "ellipsis-before") {
              const firstVisible = pageNumbers.find(
                (p) => typeof p === "number" && p > 0,
              ) as number;
              return (
                <GotoPopover
                  key={`eb-${idx}`}
                  min={2}
                  max={firstVisible}
                  onGoto={onPageChange}
                />
              );
            }
            if (item === "ellipsis-after") {
              const numbersBeforeEllipsis = pageNumbers
                .slice(0, idx)
                .filter((p): p is number => typeof p === "number");
              const lastBeforeEllipsis =
                numbersBeforeEllipsis[numbersBeforeEllipsis.length - 1] ?? 0;
              return (
                <GotoPopover
                  key={`ea-${idx}`}
                  min={lastBeforeEllipsis + 2}
                  max={totalPages - 1}
                  onGoto={onPageChange}
                />
              );
            }

            const isActive = item === currentPage;
            return (
              <Button
                key={item}
                variant={isActive ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(item)}
                className="w-8 h-8 p-0"
              >
                {item + 1}
              </Button>
            );
          })}

          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onPageChange(Math.min(totalPages - 1, currentPage + 1))
            }
            disabled={currentPage >= totalPages - 1}
            className="w-8 h-8 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
