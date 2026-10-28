"use client";

import type { ErrorBlock } from "@usemoney/types";
import { RefreshCw } from "lucide-react";
import "./chat-blocks.css";

interface ErrorBlockRendererProps {
  block: ErrorBlock;
  /** MONEY-778: when provided, render a Retry affordance (design #48). */
  onRetry?: () => void;
}

export default function ErrorBlockRenderer({
  block,
  onRetry,
}: ErrorBlockRendererProps) {
  const sev = block.severity;

  /* Inline SVG icons — keeps the component self-contained */
  const Icon = () => {
    if (sev === "error") {
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="cb-error-icon"
          aria-hidden
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
      );
    }
    if (sev === "warning") {
      return (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="cb-error-icon"
          aria-hidden
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    }
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="cb-error-icon"
        aria-hidden
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  };

  return (
    <div className={`cb-error ${sev}`} style={{ margin: "6px 0" }}>
      <Icon />
      <div>
        <div className="cb-error-title">{block.title}</div>
        {block.message && <div className="cb-error-msg">{block.message}</div>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginTop: 8,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: 7,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={12} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
