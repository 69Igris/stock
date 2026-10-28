/**
 * Strategy Service
 *
 * AI-powered strategy generation (no DB, purely Gemini).
 * Source: apps/web/lib/actions/strategy.ts
 *
 * NOTE: This service is a thin wrapper since the actual logic depends on
 * Gemini AI which is configured per-app. The strategy action in apps/web
 * calls Gemini directly. For the API server, a similar setup is needed.
 * This file provides the type definitions and any shared utilities.
 */

import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export interface GeneratedStrategy {
  name: string;
  description: string;
  type: string;
  risk: string;
  timeframe: string;
  rules: {
    entry: string[];
    exit: string[];
    stopLoss: string[];
  };
  params?: Record<string, unknown>;
  overlays?: string[];
}

// Note: generateStrategy is intentionally NOT implemented here because it
// depends on Gemini model configuration which is app-specific (apps/web uses
// @/lib/gemini/models). The strategy action stays in apps/web for now.
// When the API server needs this, it should configure its own Gemini client.
