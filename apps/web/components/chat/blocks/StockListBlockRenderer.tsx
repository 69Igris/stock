"use client";

import { useState } from "react";
import Link from "next/link";
import type { StockListBlock } from "@usemoney/types";
import { ChevronDown, ChevronUp, LineChart, Brain } from "lucide-react";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import "./chat-blocks.css";

interface StockListBlockRendererProps {
  block: StockListBlock;
  onResearch?: (symbol: string) => void;
}

/** Clean metric key labels for table headers */
const LABEL_MAP: Record<string, string> = {
  price: "Price",
  distanceFrom52WeekLow: "% 52W Low",
  distanceFrom52WeekHigh: "% 52W High",
  distanceFrom52weekLow: "% 52W Low",
  distanceFrom52weekHigh: "% 52W High",
  distance_52w_low: "% 52W Low",
  distance_52w_high: "% 52W High",
  fiftyTwoWeekHigh: "52W High",
  fiftyTwoWeekLow: "52W Low",
  pe: "PE",
  pb: "PB",
  roe: "ROE",
  roce: "ROCE",
  rsi14: "RSI",
  macd: "MACD",
  sma50: "SMA 50",
  sma200: "SMA 200",
  marketCap: "Mkt Cap",
  dividendYield: "Div Yield",
  debtToEquity: "D/E",
  volumeRatio: "Vol Ratio",
};

function cleanLabel(key: string): string {
  if (LABEL_MAP[key]) return LABEL_MAP[key];
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export default function StockListBlockRenderer({
  block,
  onResearch,
}: StockListBlockRendererProps) {
  const pageSize = block.pageSize ?? 10;
  const [visibleCount, setVisibleCount] = useState(pageSize);

  const visibleStocks = block.stocks.slice(0, visibleCount);
  const hasMore = visibleCount < block.stocks.length;
  const isExpanded = visibleCount > pageSize;

  // Collect metric keys from the first 5 rows, max 4 columns
  const metricKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const stock of block.stocks.slice(0, 5)) {
    for (const key of Object.keys(stock.metrics)) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        metricKeys.push(key);
      }
    }
  }
  const displayMetricKeys = metricKeys.slice(0, 4);

  return (
    <div className="cb-stock-list" style={{ margin: "6px 0" }}>
      {/* Header */}
      <div className="cb-stock-list-head">
        <span className="cb-stock-list-title">{block.title}</span>
        <span className="cb-stock-list-count">
          {block.total} stock{block.total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Description */}
      {block.description && (
        <div className="cb-stock-desc">
          {stripRecommendationLanguage(block.description)}
        </div>
      )}

      {/* Table — cb-stock-tbl-wrap is the horizontal scroll container */}
      <div className="cb-stock-tbl-wrap">
        <table className="cb-stock-tbl">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Stock</th>
              {displayMetricKeys.map((key) => (
                <th key={key}>{cleanLabel(key)}</th>
              ))}
              <th style={{ textAlign: "right" }}>Sector</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleStocks.map((stock: StockListBlock["stocks"][number]) => {
              const exchange = stock.exchange ?? "NSE";
              return (
                <tr key={`${stock.symbol}-${stock.name}`}>
                  {/* Symbol + Name */}
                  <td>
                    <span className="cb-stock-sym">{stock.symbol}</span>
                    {stock.name && (
                      <span className="cb-stock-name">{stock.name}</span>
                    )}
                  </td>

                  {/* Metric columns */}
                  {displayMetricKeys.map((key) => (
                    <td key={key} style={{ textAlign: "right" }}>
                      {stock.metrics[key] !== undefined
                        ? String(stock.metrics[key])
                        : "—"}
                    </td>
                  ))}

                  {/* Sector */}
                  <td style={{ textAlign: "right" }}>
                    {stock.sector ? (
                      <span className="cb-stock-sector">{stock.sector}</span>
                    ) : (
                      <span style={{ color: "var(--ink-4)" }}>—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td>
                    <div className="cb-stock-actions">
                      <Link
                        href={`/stock/${encodeURIComponent(stock.symbol)}?exchange=${exchange}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cb-stock-action-btn"
                      >
                        <LineChart style={{ width: 11, height: 11 }} />
                        Chart
                      </Link>
                      {onResearch && (
                        <button
                          type="button"
                          className="cb-stock-action-btn research"
                          onClick={() => onResearch(stock.symbol)}
                        >
                          <Brain style={{ width: 11, height: 11 }} />
                          Analyse
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {(hasMore || isExpanded) && (
        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px dashed var(--rule-soft)",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          {hasMore && (
            <button
              type="button"
              className="cb-show-more-btn"
              onClick={() => setVisibleCount((prev: number) => prev + pageSize)}
            >
              <ChevronDown style={{ width: 13, height: 13 }} />
              Show more ({block.stocks.length - visibleCount} remaining)
            </button>
          )}
          {isExpanded && (
            <button
              type="button"
              className="cb-show-less-btn"
              onClick={() => setVisibleCount(pageSize)}
            >
              <ChevronUp style={{ width: 13, height: 13 }} />
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}
