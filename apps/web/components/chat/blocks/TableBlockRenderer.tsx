"use client";

import type { TableBlock } from "@usemoney/types";
import { formatCellValue } from "@/lib/chat/format-utils";
import "./chat-blocks.css";

interface TableBlockRendererProps {
  block: TableBlock;
}

export default function TableBlockRenderer({ block }: TableBlockRendererProps) {
  const maxRows = block.maxRows ?? 10;
  const displayRows = block.rows.slice(0, maxRows);
  const hasMore = block.rows.length > maxRows;

  return (
    <div style={{ margin: "6px 0" }}>
      {block.title && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "var(--ink)",
            }}
          >
            {block.title}
          </span>
        </div>
      )}

      {/* cb-table-scroll is the ONLY block allowed to scroll horizontally */}
      <div
        className="cb-card cb-table-scroll"
        style={{ padding: 0, overflow: "hidden" }}
      >
        <table className="cb-tbl">
          <thead>
            <tr>
              {block.columns.map((col) => (
                <th
                  key={col.key}
                  style={{
                    textAlign:
                      col.align === "right"
                        ? "right"
                        : col.align === "center"
                          ? "center"
                          : "left",
                  }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.columns.map((col) => {
                  const { text, colorClass } = formatCellValue(
                    row[col.key],
                    col.format
                  );
                  const isPos = colorClass?.includes("emerald");
                  const isNeg =
                    colorClass?.includes("red") ||
                    colorClass?.includes("destructive");
                  return (
                    <td
                      key={col.key}
                      style={{
                        textAlign:
                          col.align === "right"
                            ? "right"
                            : col.align === "center"
                              ? "center"
                              : "left",
                        color: isPos
                          ? "var(--emerald-text)"
                          : isNeg
                            ? "var(--pop-1-text)"
                            : undefined,
                      }}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <p className="cb-tbl-more">
          Showing {maxRows} of {block.rows.length} rows
        </p>
      )}
    </div>
  );
}
