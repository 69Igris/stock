"use client";

/**
 * Embedded SIP / Lumpsum calculator for the Fund AND ETF detail pages
 * (MONEY-245; ETF consolidation MONEY-1211).
 *
 * Two modes via tab:
 *   - Monthly (SIP): future value of an annuity-due under monthly compounding.
 *       FV = P × ((1 + r)^n − 1) / r × (1 + r)
 *   - Lumpsum: future value of a single deposit under monthly compounding.
 *       FV = P × (1 + r)^n
 *
 * Defaults are seeded from the fund's recent CAGR if available so the
 * estimated value tracks how the fund has historically performed.
 *
 * ## ETF mode — MONEY-1211
 *
 * `components/etf/EtfSipCalculator.tsx` was a 520-line FORK of this file. It
 * had been untouched since 26 May and was still on pre-playful, dark-only
 * Tailwind: `bg-white/[0.06] accent-emerald-400` on the slider (an invisible
 * track and mint-on-cream values in LIGHT mode), `bg-white/[0.03]` /
 * `bg-white/[0.02]` panels, no dark result card, and a DOLLAR icon
 * (`CircleDollarSign`) captioning the "₹ amount" input of an India-only
 * product. It also carried two silent defects of its own: an inline
 * re-derivation of `computeLumpsumFutureValue`, and `clamp(0, 100, pct)`
 * against a `clamp(v, lo, hi)` signature — the arguments transposed, so the
 * invested/gain bar read 100% invested at every single input.
 *
 * Exactly three things there were genuinely ETF-specific, and all three are
 * folded in here behind OPTIONAL props, so the MF caller's behaviour is
 * unchanged when they are absent:
 *   1. `ltp` — ETFs trade at a market price, not NAV, so the instalment can be
 *      expressed as ₹X/month OR as N units/month (cost = units × LTP).
 *   2. Projected unit accumulation alongside the ₹ corpus.
 *   3. An asset-class-specific STCG/LTCG footnote.
 *
 * Everything else was duplication and is deleted with the fork.
 *
 * Design reference: "det-sip" section in Missing Modules - Playful design.
 * Playful re-skin: MONEY-489. Preserves all props / calculations / behaviour.
 */

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Hash, IndianRupee } from "lucide-react";
import {
  computeSipFutureValue,
  computeLumpsumFutureValue,
  formatInr,
  formatUnits,
  isUsableLtp,
  investedSplitPct,
  projectedUnitsFor,
  seedReturnFor,
  taxNoteFor,
} from "./sip-math";
import "./detail-playful.css";

// Re-export the pure math so existing importers of this component keep
// working. The formulas live in `./sip-math` (a CSS-free module) so they
// can be unit-tested under node:test without importing this `.tsx`.
export { computeSipFutureValue, computeLumpsumFutureValue } from "./sip-math";
export type { SipFutureValue } from "./sip-math";

export type SipMode = "monthly" | "lumpsum";
/** ETF mode only: express the instalment in rupees or in units. */
export type SipInputMode = "rupees" | "units";

interface SipCalculatorProps {
  /** Default expected annual return % (e.g., from 5Y CAGR). Falls back to 12. */
  defaultAnnualReturn?: number | null;
  /**
   * ETF only — current LTP, used to convert ₹ ↔ units and to project a unit
   * count. Absent (or non-positive) keeps the calculator in pure-₹ MF mode.
   */
  ltp?: number | null;
  /** ETF only — drives the tax-treatment footnote and the default return band. */
  assetClass?: string | null;
  /** Optional hook to surface the calculated value to the parent for chips/etc. */
  onChange?: (out: {
    invested: number;
    estimatedValue: number;
    gain: number;
  }) => void;
}

export function SipCalculator({
  defaultAnnualReturn,
  ltp,
  assetClass,
  onChange,
}: SipCalculatorProps) {
  // Seed default expected-return: prefer the fund's 5Y CAGR (passed in
  // by the page as `returns5Y ?? returns3Y ?? null`). Falls back to the
  // asset-class band, or 12% when there is no asset class - that's the
  // conventional long-run equity assumption used across mainstream MF
  // calculators (Groww, ETMoney, AMFI's own widgets) so users see a
  // familiar starting point.
  const seedReturn = seedReturnFor(assetClass, defaultAnnualReturn);

  // ETF affordances. `isUsableLtp` rejects 0/NaN/Infinity as ABSENCE of a
  // price rather than a price of zero — a 0 would send projected units to
  // Infinity, and `Number("")` is 0.
  const unitsUsable = isUsableLtp(ltp);
  const taxNote = taxNoteFor(assetClass);
  const etfMode = unitsUsable || taxNote !== null;

  const [mode, setMode] = useState<SipMode>("monthly");
  const [inputMode, setInputMode] = useState<SipInputMode>("rupees");
  const [monthly, setMonthly] = useState(10000);
  const [lumpsum, setLumpsum] = useState(500000);
  const [monthlyUnits, setMonthlyUnits] = useState(50);
  const [lumpsumUnits, setLumpsumUnits] = useState(2000);
  const [years, setYears] = useState(10);
  const [annualReturn, setAnnualReturn] = useState(seedReturn);

  // If `defaultAnnualReturn` arrives AFTER first mount (the MF page
  // sometimes derives 5Y CAGR client-side from NAV history when the
  // master record doesn't carry it), reflect it into the slider so the
  // user sees the fund's actual realized rate, not the fallback.
  // We only sync while the user hasn't manually moved the slider - once
  // they touch it we respect their input. We track that via a ref on
  // the seed value rather than a "dirty" boolean to keep the wiring
  // self-contained.
  useEffect(() => {
    if (defaultAnnualReturn == null || !Number.isFinite(defaultAnnualReturn)) {
      return;
    }
    const next = seedReturnFor(assetClass, defaultAnnualReturn);
    // Only update if the slider is still at the seed (i.e. user hasn't
    // dragged it). This is a coarse heuristic - close-enough match
    // (within 0.05) treats the slider as untouched.
    setAnnualReturn((prev) =>
      Math.abs(prev - seedReturn) < 0.05 ? next : prev
    );
    // We deliberately leave `seedReturn` out of the deps; the ref
    // captured at first render is what we compare against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultAnnualReturn]);

  // A units selection can never survive the LTP going away — otherwise the
  // instalment silently becomes `units × undefined`.
  const effectiveInputMode: SipInputMode = unitsUsable ? inputMode : "rupees";

  // Effective per-instalment ₹ amount, given the chosen input mode. In Units
  // mode we project the current LTP forward (constant-LTP simplification, which
  // the "indicative only" footnote covers).
  const perInstalment = useMemo(() => {
    const price = unitsUsable ? ltp : 0;
    if (mode === "lumpsum") {
      return effectiveInputMode === "rupees" ? lumpsum : lumpsumUnits * price;
    }
    return effectiveInputMode === "rupees" ? monthly : monthlyUnits * price;
  }, [
    mode,
    effectiveInputMode,
    monthly,
    monthlyUnits,
    lumpsum,
    lumpsumUnits,
    ltp,
    unitsUsable,
  ]);

  const result = useMemo(() => {
    return mode === "monthly"
      ? computeSipFutureValue(perInstalment, years, annualReturn)
      : computeLumpsumFutureValue(perInstalment, years, annualReturn);
  }, [mode, perInstalment, years, annualReturn]);

  // Surface to parent when value changes - `useEffect` (not `useMemo`)
  // because `onChange` is a side-effect, not a derived value.
  useEffect(() => {
    onChange?.(result);
  }, [result, onChange]);

  // Computed split for the stacked bar (% invested / % gain). Both
  // clamped so negative gains (rare on long horizons) still render.
  const investedPct = investedSplitPct(result.invested, result.estimatedValue);

  // Units the projected corpus buys at today's LTP. Null — never 0 — when the
  // conversion is unavailable.
  const projectedUnits = projectedUnitsFor(result.invested, ltp);

  const modeLabel =
    mode === "monthly"
      ? effectiveInputMode === "units"
        ? "What if you bought N units monthly?"
        : "What if you invested monthly?"
      : effectiveInputMode === "units"
        ? "What if you bought N units upfront?"
        : "What if you invested as a lumpsum?";

  const unitCost = unitsUsable ? ltp : 0;

  return (
    <div className="sip-card">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="sip-header">
        <div className="sip-title-block">
          <span className="sip-live-dot" aria-hidden="true" />
          <span className="sip-title">SIP CALCULATOR</span>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--ink-3)",
              marginLeft: 6,
              fontStyle: "italic",
            }}
          >
            {modeLabel}
          </span>
        </div>

        {/* Mode tab strip */}
        <div
          className="det-tab-strip"
          role="tablist"
          aria-label="Calculator mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "monthly"}
            className={`det-tab-btn${mode === "monthly" ? " is-active" : ""}`}
            onClick={() => setMode("monthly")}
          >
            <CalendarDays aria-hidden="true" width={11} height={11} />
            Monthly
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "lumpsum"}
            className={`det-tab-btn${mode === "lumpsum" ? " is-active" : ""}`}
            onClick={() => setMode("lumpsum")}
          >
            <IndianRupee aria-hidden="true" width={11} height={11} />
            Lumpsum
          </button>
        </div>
      </div>

      {/* Input-mode toggle: ₹ vs Units. ETF only — an MF has no traded unit
          price to convert against. Sits below the frequency toggle so the
          visual hierarchy is clear: frequency dominates, input-mode is a
          detail. */}
      {etfMode && (
        <div className="sip-submode">
          <span className="sip-submode-label">Input as</span>
          <div
            className="det-tab-strip"
            role="tablist"
            aria-label="Instalment input mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={effectiveInputMode === "rupees"}
              className={`det-tab-btn${
                effectiveInputMode === "rupees" ? " is-active" : ""
              }`}
              onClick={() => setInputMode("rupees")}
            >
              <IndianRupee aria-hidden="true" width={11} height={11} />
              amount
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveInputMode === "units"}
              className={`det-tab-btn${
                effectiveInputMode === "units" ? " is-active" : ""
              }`}
              onClick={() => setInputMode("units")}
              disabled={!unitsUsable}
              title={
                unitsUsable ? undefined : "LTP unavailable — switch to ₹ mode"
              }
            >
              <Hash aria-hidden="true" width={11} height={11} />
              Units
            </button>
          </div>
        </div>
      )}

      {/* ── Content grid ───────────────────────────────────────────── */}
      <div className="sip-grid">
        {/* Left: sliders */}
        <div className="sip-slider-group">
          {mode === "monthly" ? (
            effectiveInputMode === "rupees" ? (
              <SipKnob
                label="Monthly investment"
                value={monthly}
                onChange={setMonthly}
                min={500}
                max={200_000}
                step={500}
                format={formatInr}
              />
            ) : (
              <SipKnob
                label="Units per month"
                value={monthlyUnits}
                onChange={setMonthlyUnits}
                min={1}
                max={500}
                step={1}
                format={(v) =>
                  `${v} unit${v === 1 ? "" : "s"} · ${formatInr(v * unitCost)}`
                }
              />
            )
          ) : effectiveInputMode === "rupees" ? (
            <SipKnob
              label="Lumpsum amount"
              value={lumpsum}
              onChange={setLumpsum}
              min={5_000}
              max={10_000_000}
              step={5_000}
              format={formatInr}
            />
          ) : (
            <SipKnob
              label="Lumpsum units"
              value={lumpsumUnits}
              onChange={setLumpsumUnits}
              min={1}
              max={50_000}
              step={1}
              format={(v) =>
                `${v} unit${v === 1 ? "" : "s"} · ${formatInr(v * unitCost)}`
              }
            />
          )}
          <SipKnob
            label="Time period"
            value={years}
            onChange={setYears}
            min={1}
            max={40}
            step={1}
            format={(v) => `${v} yr${v === 1 ? "" : "s"}`}
          />
          <SipKnob
            label="Expected return"
            value={annualReturn}
            onChange={setAnnualReturn}
            min={1}
            max={30}
            step={0.5}
            format={(v) => `${v.toFixed(1)}% p.a.`}
          />
        </div>

        {/* Right: result */}
        <div className="sip-result-panel">
          {/* Projected corpus dark card */}
          <div className="sip-corpus-card">
            <div className="sip-corpus-eyebrow">YOU&apos;LL HAVE</div>
            <div className="sip-corpus-amount">
              {formatInr(result.estimatedValue)}
            </div>
            <div className="sip-corpus-meta">
              invested <strong>{formatInr(result.invested)}</strong>
              {" · "}
              gain <span className="gain">{formatInr(result.gain)}</span>
            </div>
          </div>

          {/* Stacked invested / gain bar */}
          <div>
            <div className="sip-bar-track" title="Invested vs gains split">
              <div
                className="sip-bar-invested"
                style={{ width: `${investedPct.toFixed(2)}%` }}
                title={`Invested: ${formatInr(result.invested)}`}
              />
              <div
                className="sip-bar-gain"
                title={`Gains: ${formatInr(result.gain)}`}
              />
            </div>

            <div className="sip-legend-grid" style={{ marginTop: 12 }}>
              <div className="sip-legend-row">
                <span
                  className="sip-legend-dot"
                  style={{ background: "var(--pop-3)" }}
                />
                <div>
                  <div className="sip-legend-label">Invested</div>
                  <div className="sip-legend-val">
                    {formatInr(result.invested)}
                  </div>
                </div>
              </div>
              <div className="sip-legend-row">
                <span
                  className="sip-legend-dot"
                  style={{ background: "var(--emerald)" }}
                />
                <div>
                  <div className="sip-legend-label">Est. gains</div>
                  <div className="sip-legend-val">{formatInr(result.gain)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Unit accumulation — ETF-specific. Held constant at current LTP
              for simplicity (the "indicative" footer covers this). */}
          {projectedUnits !== null && (
            <div className="sip-units-row">
              <span className="sip-units-label">Projected units</span>
              <span className="sip-units-val">
                {formatUnits(projectedUnits)}
              </span>
            </div>
          )}

          {/* Tax footnote tuned to asset class — ETF-specific. */}
          {taxNote && <p className="sip-taxnote">{taxNote}</p>}

          <p className="sip-disclaimer">
            {etfMode
              ? "Indicative only. Actual returns depend on tracking error, LTP at execution, and prevailing tax rules."
              : "Indicative only. Actual returns depend on market performance, exit load, and taxation."}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function SipKnob({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  return (
    <div className="sip-knob">
      <div className="sip-knob-row">
        <span className="sip-knob-label">{label}</span>
        <span className="sip-knob-value">{format(value)}</span>
      </div>
      <input
        type="range"
        className="sip-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={format(value)}
      />
      <div className="sip-range-limits">
        <span>{format(min)}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  );
}

export default SipCalculator;
