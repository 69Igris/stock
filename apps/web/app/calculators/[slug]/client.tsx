"use client";

/**
 * /calculators/[slug] client island - generic calculator form runner.
 *
 * Each calc config from `configs.ts` declares its inputs + result rows;
 * this component renders the form, calls the matching pure primitive
 * from `@usemoney/core/calc`, and shows the result card.
 *
 * The XIRR calculator (slug `mf-returns-xirr`) renders a custom
 * cashflow series builder instead of the generic form because its
 * input shape (CashFlow[]) doesn't fit the field-list model.
 */

import { useState, useMemo } from "react";
import {
  calcSip,
  calcLumpsum,
  calcStepUpSip,
  calcEmi,
  calcFd,
  calcRd,
  calcNps,
  calcGoalSip,
  calcInflationAdjustedSip,
  calcSwp,
  calcXirr,
  calcIncomeTax,
} from "@usemoney/core/calc";
import type { CalcConfig, FieldConfig, ResultRow } from "./configs";

const fmtCurrency = (n: number): string => {
  if (!Number.isFinite(n)) return "-";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
};

const fmtPct = (n: number): string => {
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}%`;
};

const fmtMonths = (n: number): string => {
  if (!Number.isFinite(n)) return "-";
  return `${n} mo`;
};

const fmt = (val: unknown, format: ResultRow["format"]): string => {
  if (val == null) return "-";
  const n = Number(val);
  if (!Number.isFinite(n)) return "-";
  if (format === "currency") return fmtCurrency(n);
  if (format === "pct") return fmtPct(n);
  if (format === "months") return fmtMonths(n);
  return n.toLocaleString("en-IN");
};

function runCalc(
  calcKey: CalcConfig["calcKey"],
  values: Record<string, number | string>
): Record<string, unknown> {
  // Calc primitives return strongly-typed result objects (SipResult,
  // EmiResult, etc.). The result keys are statically known and looked
  // up by the config's `results[].key` strings, so the cast through
  // `unknown` is safe - the calling code only does property access by
  // the string keys declared in configs.ts.
  const out = runInner() as unknown as Record<string, unknown>;
  return out;

  function runInner(): unknown {
    switch (calcKey) {
      case "sip":
        return calcSip({
          monthly: Number(values.monthly),
          annualReturnPct: Number(values.annualReturnPct),
          durationYears: Number(values.durationYears),
        });
      case "lumpsum":
        return calcLumpsum({
          principal: Number(values.principal),
          annualReturnPct: Number(values.annualReturnPct),
          durationYears: Number(values.durationYears),
        });
      case "stepUpSip":
        return calcStepUpSip({
          monthly: Number(values.monthly),
          annualReturnPct: Number(values.annualReturnPct),
          stepUpPct: Number(values.stepUpPct),
          durationYears: Number(values.durationYears),
        });
      case "emi":
        return calcEmi({
          principal: Number(values.principal),
          annualRatePct: Number(values.annualRatePct),
          durationYears: Number(values.durationYears),
        });
      case "fd":
        return calcFd({
          principal: Number(values.principal),
          annualRatePct: Number(values.annualRatePct),
          durationYears: Number(values.durationYears),
          compounding: values.compounding as never,
        });
      case "rd":
        return calcRd({
          monthly: Number(values.monthly),
          annualRatePct: Number(values.annualRatePct),
          durationYears: Number(values.durationYears),
        });
      case "nps":
        return calcNps({
          monthly: Number(values.monthly),
          currentAge: Number(values.currentAge),
          retirementAge: Number(values.retirementAge),
          preReturnPct: Number(values.preReturnPct),
          annuityPct: Number(values.annuityPct) / 100,
          annuityRatePct: Number(values.annuityRatePct),
        });
      case "goalSip":
        return calcGoalSip({
          goal: Number(values.goal),
          annualReturnPct: Number(values.annualReturnPct),
          durationYears: Number(values.durationYears),
        });
      case "inflationSip":
        return calcInflationAdjustedSip({
          monthly: Number(values.monthly),
          nominalReturnPct: Number(values.nominalReturnPct),
          inflationPct: Number(values.inflationPct),
          durationYears: Number(values.durationYears),
        });
      case "swp":
        return calcSwp({
          initialCorpus: Number(values.initialCorpus),
          monthlyWithdrawal: Number(values.monthlyWithdrawal),
          annualReturnPct: Number(values.annualReturnPct),
          durationYears: Number(values.durationYears),
        });
      case "incomeTax":
        return calcIncomeTax({
          income: Number(values.income),
          regime: values.regime as "old" | "new",
          deductions: Number(values.deductions),
        });
      case "xirr":
        return { xirr: NaN }; // Custom builder renders its own result
      default:
        return {};
    }
  }
}

export default function CalculatorClient({ config }: { config: CalcConfig }) {
  const initial = useMemo(() => {
    const m: Record<string, number | string> = {};
    for (const f of config.fields) m[f.key] = f.default;
    return m;
  }, [config]);

  const [values, setValues] = useState(initial);
  const [series, setSeries] = useState<{ date: string; amount: number }[]>([
    {
      date: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      amount: -100000,
    },
    { date: new Date().toISOString().slice(0, 10), amount: 110000 },
  ]);

  const result = useMemo(() => {
    if (config.calcKey === "xirr") {
      const flows = series.map((s) => ({
        date: new Date(s.date),
        amount: Number(s.amount),
      }));
      const xirr = calcXirr(flows);
      return { xirr: Number.isFinite(xirr) ? xirr * 100 : NaN };
    }
    return runCalc(config.calcKey, values);
  }, [config, values, series]);

  const handleField = (key: string, raw: string) => {
    const f = config.fields.find((x) => x.key === key);
    if (!f) return;
    const val = f.kind === "select" ? raw : Number(raw);
    setValues((prev) => ({ ...prev, [key]: val }));
  };

  // The hero result is the accent row (final/big number); the remaining
  // rows render as a supporting stat list. Falls back to the first row
  // when no row is flagged accent.
  const accentRow =
    config.results.find((r) => r.accent) ?? config.results[0] ?? null;
  const restRows = config.results.filter((r) => r !== accentRow);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-5 items-start">
      {/* Inputs */}
      <section className="pf-card" style={{ padding: 0 }}>
        <div
          style={{ padding: "14px 20px", borderBottom: "2px solid var(--ink)" }}
        >
          <div className="ttl">YOUR INPUTS</div>
        </div>
        <div style={{ padding: 20 }}>
          {config.calcKey === "xirr" ? (
            <CashflowBuilder series={series} onChange={setSeries} />
          ) : (
            <div className="flex flex-col gap-[18px]">
              {config.fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={values[f.key] as never}
                  onChange={(raw) => handleField(f.key, raw)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Result — dark hero stat + supporting rows (design: featured SIP) */}
      <section className="flex flex-col gap-[18px]">
        {accentRow && (
          <div
            className="pf-card tilt-r"
            style={{ background: "var(--ink)", color: "var(--paper)" }}
          >
            <div className="ttl" style={{ color: "var(--pop-2)" }}>
              {accentRow.label}
            </div>
            <div
              className="mono"
              style={{
                marginTop: 6,
                fontSize: 44,
                fontWeight: 800,
                letterSpacing: -1.5,
                color: "var(--pop-2)",
                lineHeight: 1,
              }}
            >
              {fmt(result[accentRow.key], accentRow.format)}
            </div>
          </div>
        )}
        {restRows.length > 0 && (
          <div className="pf-card" style={{ padding: 0 }}>
            <div
              style={{
                padding: "12px 18px",
                borderBottom: "1.5px dashed var(--rule-soft)",
              }}
            >
              <div className="ttl">BREAKDOWN</div>
            </div>
            <dl style={{ padding: "6px 18px 14px" }}>
              {restRows.map((r) => (
                <div
                  key={r.key}
                  className="flex items-baseline justify-between py-2.5"
                  style={{ borderBottom: "1px dashed var(--rule-soft)" }}
                >
                  <dt className="text-[12.5px] text-[var(--ink-3)]">
                    {r.label}
                  </dt>
                  <dd className="mono text-[14px] font-semibold text-[var(--ink)]">
                    {fmt(result[r.key], r.format)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldConfig;
  value: number | string;
  onChange: (raw: string) => void;
}) {
  const suffix =
    field.kind === "percent"
      ? "%"
      : field.kind === "years"
        ? "yrs"
        : field.kind === "months"
          ? "mo"
          : null;
  const prefix = field.kind === "currency" ? "₹" : null;

  if (field.kind === "select") {
    return (
      <div>
        <label className="block text-[12px] text-[var(--ink-2)] mb-1.5">
          {field.label}
        </label>
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="pf-input"
          style={{ padding: "8px 10px", fontSize: 13.5 }}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.hint && (
          <p className="mono mt-1 text-[11px] text-[var(--ink-3)]">
            {field.hint}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] text-[var(--ink-2)]">{field.label}</span>
        <span className="mono text-[13px] font-bold text-[var(--ink)]">
          {prefix}
          {value}
          {suffix && (
            <span style={{ color: "var(--ink-3)", marginLeft: 3 }}>
              {suffix}
            </span>
          )}
        </span>
      </div>
      <div className="relative">
        {prefix && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ink-3)] pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          min={field.min}
          max={field.max}
          step={field.step}
          className="pf-input"
          style={{
            padding: "8px 10px",
            fontSize: 13.5,
            paddingLeft: prefix ? 26 : undefined,
            paddingRight: suffix ? 44 : undefined,
          }}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ink-3)] pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {field.min != null && field.max != null && (
        <input
          type="range"
          value={Number(value)}
          onChange={(e) => onChange(e.target.value)}
          min={field.min}
          max={field.max}
          step={field.step}
          className="w-full mt-2.5 h-2 cursor-pointer"
          style={{ accentColor: "var(--emerald)" }}
        />
      )}
      {field.hint && (
        <p className="mono mt-1 text-[11px] text-[var(--ink-3)]">
          {field.hint}
        </p>
      )}
    </div>
  );
}

function CashflowBuilder({
  series,
  onChange,
}: {
  series: { date: string; amount: number }[];
  onChange: (next: { date: string; amount: number }[]) => void;
}) {
  const addRow = () =>
    onChange([
      ...series,
      { date: new Date().toISOString().slice(0, 10), amount: 0 },
    ]);
  const removeRow = (i: number) =>
    onChange(series.filter((_, idx) => idx !== i));
  const update = (
    i: number,
    patch: Partial<{ date: string; amount: number }>
  ) => onChange(series.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div>
      <p className="text-[12px] text-[var(--ink-3)] mb-3 leading-snug">
        Outflows (investments) negative · inflows (returns) positive.
        Newton-Raphson with bisection fallback - same algorithm as Excel XIRR.
      </p>
      <div className="space-y-2">
        {series.map((row, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input
              type="date"
              value={row.date}
              onChange={(e) => update(i, { date: e.target.value })}
              className="pf-input flex-1"
              style={{ padding: "7px 10px", fontSize: 12.5 }}
            />
            <input
              type="number"
              value={row.amount}
              onChange={(e) => update(i, { amount: Number(e.target.value) })}
              className="pf-input mono flex-1"
              style={{ padding: "7px 10px", fontSize: 12.5 }}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="px-2 text-[12px] text-[var(--ink-3)] hover:text-[var(--pop-1-text)] transition-colors"
              aria-label="Remove row"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={addRow} className="pf-bf sm mt-3">
        + Add cashflow
      </button>
    </div>
  );
}
