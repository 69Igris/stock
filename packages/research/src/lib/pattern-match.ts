/**
 * Historical Analog Pattern Matching
 *
 * Finds historical periods with similar price patterns to the current window.
 * Uses normalized correlation to measure similarity, then reports what happened
 * after each matched period to inform forward expectations.
 */

// ─── Types ──────────────────────────────────────────────────

export interface HistoricalAnalog {
  /** Start/end date indices (or date strings if available) */
  period: { start: string; end: string };
  /** Similarity score: 0-100 (Pearson correlation × 100) */
  similarity: number;
  /** What happened in the subsequent period - return % */
  subsequentReturn: number;
  /** Duration of the matched pattern window in trading days */
  durationDays: number;
}

// ─── Normalization ──────────────────────────────────────────

/**
 * Normalize a price series to 0-100 scale.
 * Maps the minimum value to 0 and maximum to 100.
 */
function normalize(prices: number[]): number[] {
  if (prices.length === 0) return [];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  if (range === 0) return prices.map(() => 50);
  return prices.map((p) => ((p - min) / range) * 100);
}

// ─── Pearson Correlation ────────────────────────────────────

/**
 * Compute Pearson correlation coefficient between two equal-length arrays.
 * Returns value between -1 and 1.
 */
function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;

  let sumA = 0;
  let sumB = 0;
  let sumAB = 0;
  let sumA2 = 0;
  let sumB2 = 0;

  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
    sumAB += a[i]! * b[i]!;
    sumA2 += a[i]! * a[i]!;
    sumB2 += b[i]! * b[i]!;
  }

  const numerator = n * sumAB - sumA * sumB;
  const denominator = Math.sqrt(
    (n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB),
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

// ─── Pattern Matching ───────────────────────────────────────

/**
 * Find historical periods with similar price patterns to the current window.
 *
 * Algorithm:
 * 1. Extract the current pattern (last `lookbackWindow` days) and normalize to 0-100
 * 2. Slide a window of the same size through historical data (excluding the current window)
 * 3. For each window position: normalize, compute Pearson correlation
 * 4. Track what happened in the `lookbackWindow` days AFTER each matched period
 * 5. Return top N matches sorted by similarity (descending)
 *
 * @param prices          - Full price history (oldest first)
 * @param lookbackWindow  - Size of the current pattern (e.g., 60 days)
 * @param searchWindow    - How far back in history to search (e.g., 1000 days)
 * @param topN            - Number of top matches to return (default 5)
 * @returns               - Array of historical analogs sorted by similarity
 */
export function findHistoricalAnalogs(
  prices: number[],
  lookbackWindow: number,
  searchWindow: number,
  topN: number = 5,
): HistoricalAnalog[] {
  if (prices.length < lookbackWindow + lookbackWindow) {
    // Need at least 2x the lookback: one for pattern, one for comparison
    return [];
  }

  // Step 1: Extract and normalize current pattern
  const currentPattern = prices.slice(-lookbackWindow);
  const normalizedCurrent = normalize(currentPattern);

  // Step 2: Determine search range
  // Search ends before the current pattern starts so we don't match against itself.
  // We also need `lookbackWindow` days AFTER each candidate to measure subsequent return.
  const currentPatternStart = prices.length - lookbackWindow;
  const searchStart = Math.max(0, currentPatternStart - searchWindow);
  // The last valid candidate window must end at least `lookbackWindow` days before current pattern
  // so we can compute the subsequent return.
  const lastCandidateEnd = currentPatternStart - lookbackWindow;

  if (lastCandidateEnd < searchStart + lookbackWindow) {
    // Not enough room in the search space
    return [];
  }

  // Step 3: Slide window and compute correlations
  const candidates: {
    startIdx: number;
    endIdx: number;
    similarity: number;
    subsequentReturn: number;
  }[] = [];

  // Step size: use 1 for accuracy (could increase for performance)
  const step = Math.max(1, Math.floor(lookbackWindow / 10));

  for (
    let windowEnd = searchStart + lookbackWindow;
    windowEnd <= lastCandidateEnd;
    windowEnd += step
  ) {
    const windowStart = windowEnd - lookbackWindow;
    const candidateWindow = prices.slice(windowStart, windowEnd);
    const normalizedCandidate = normalize(candidateWindow);

    // Compute correlation
    const corr = pearsonCorrelation(normalizedCurrent, normalizedCandidate);

    // Only consider positive correlations above a threshold
    if (corr < 0.6) continue;

    // Step 4: Measure what happened after the candidate window
    const afterStart = windowEnd;
    const afterEnd = Math.min(afterStart + lookbackWindow, currentPatternStart);
    const priceAtEnd = prices[windowEnd - 1]!;
    const priceAfter = prices[afterEnd - 1]!;
    const subsequentReturn =
      priceAtEnd > 0
        ? Math.round(((priceAfter - priceAtEnd) / priceAtEnd) * 10000) / 100
        : 0;

    candidates.push({
      startIdx: windowStart,
      endIdx: windowEnd,
      similarity: Math.round(corr * 10000) / 100, // 0-100 scale
      subsequentReturn,
    });
  }

  // Step 5: Sort by similarity descending and take top N
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Remove overlapping windows: if two candidates overlap significantly,
  // keep the one with higher similarity
  const filtered: typeof candidates = [];
  for (const candidate of candidates) {
    const overlaps = filtered.some(
      (existing) =>
        Math.abs(candidate.startIdx - existing.startIdx) < lookbackWindow / 2,
    );
    if (!overlaps) {
      filtered.push(candidate);
    }
    if (filtered.length >= topN) break;
  }

  // Step 6: Convert to output format
  return filtered.map((c) => ({
    period: {
      start: `Day ${c.startIdx + 1}`,
      end: `Day ${c.endIdx}`,
    },
    similarity: c.similarity,
    subsequentReturn: c.subsequentReturn,
    durationDays: lookbackWindow,
  }));
}
