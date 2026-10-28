"use client";

import { useState, useEffect, useCallback } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { SetSection, SetRow, SetToggle } from "./primitives";
import {
  getCurrencyPreferenceAction,
  updateCurrencyPreferenceAction,
  getDefaultPagePreferenceAction,
  updateDefaultPagePreferenceAction,
} from "@/lib/actions/user";

interface PreferencesTabProps {
  isDemoMode: boolean;
}

interface ThemeOption {
  id: "dark" | "light" | "system";
  label: string;
  sub: string;
  colors: [string, string, string];
}

const THEMES: ThemeOption[] = [
  {
    id: "dark",
    label: "Deep Ink",
    sub: "Dark theme",
    colors: ["#16140e", "#1f1c14", "#34d399"],
  },
  {
    id: "light",
    label: "Cream Paper",
    sub: "Light · default",
    colors: ["#f7f3e6", "#efe7d0", "#16a34a"],
  },
  {
    id: "system",
    label: "System",
    sub: "Match OS",
    colors: ["#16140e", "#f7f3e6", "#34d399"],
  },
];

const CURRENCY_OPTIONS = ["INR (₹)", "USD ($)", "EUR (€)", "GBP (£)"];

const DEFAULT_PAGE_OPTIONS = [
  { value: "dashboard" as const, label: "Dashboard" },
  { value: "stocksage" as const, label: "StockSage" },
];

export default function PreferencesTab({ isDemoMode }: PreferencesTabProps) {
  const { theme, setTheme } = useTheme();
  const [currency, setCurrency] = useState("INR (₹)");
  // Matches the server-side default in `getDefaultPagePreferenceAction`. If
  // these two disagree, the toggle renders the wrong option as selected until
  // `loadPrefs` resolves and then visibly flips — which reads as the setting
  // having changed by itself.
  const [defaultPage, setDefaultPage] = useState<"dashboard" | "stocksage">(
    "stocksage"
  );
  const [hideBalances, setHideBalances] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  // Whether `loadPrefs` has resolved. Until it has, `defaultPage` above holds
  // the OPTIMISTIC default rather than the user's stored value, and the two
  // can disagree — see `handleDefaultPageSelect`.
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const loadPrefs = useCallback(async () => {
    if (isDemoMode) return;
    try {
      const [currencyResult, defaultPageResult] = await Promise.all([
        getCurrencyPreferenceAction(),
        getDefaultPagePreferenceAction(),
      ]);
      if (currencyResult?.success && currencyResult?.data) {
        const code = currencyResult.data.currency;
        const match = CURRENCY_OPTIONS.find((o) => o.startsWith(code));
        if (match) setCurrency(match);
      }
      if (defaultPageResult?.success) {
        setDefaultPage(defaultPageResult.value);
      }
    } catch {
      // Silent fail - use defaults
    } finally {
      setPrefsLoaded(true);
    }
  }, [isDemoMode]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  // Select a specific page (explicit choice — not a click-to-flip). No-op when
  // it's already active. Optimistic, reverts on failure. /launch reads this.
  //
  // The `prefsLoaded` guard on the no-op is load-bearing. `defaultPage` starts
  // at the optimistic default ("stocksage"), so a user whose STORED value is
  // "dashboard" sees StockSage rendered as active for as long as `loadPrefs` is
  // in flight. Without the guard, clicking StockSage in that window matches the
  // `next === defaultPage` no-op and returns silently — no write, no toast —
  // and then the pill visibly jumps to Dashboard when `loadPrefs` lands, which
  // reads as the click having done the opposite of what was asked. Before the
  // default flipped to StockSage this window only affected users who had
  // already chosen StockSage (for whom the no-op was correct); now it lands on
  // the dashboard-preferring cohort, i.e. everyone who ever touched this
  // setting. Until the real value is known, honour the click.
  const handleDefaultPageSelect = useCallback(
    async (next: "dashboard" | "stocksage") => {
      if (isDemoMode) return;
      if (prefsLoaded && next === defaultPage) return;
      const prev = defaultPage;
      setDefaultPage(next);
      try {
        const result = await updateDefaultPagePreferenceAction(next);
        if (result?.success) {
          const label =
            DEFAULT_PAGE_OPTIONS.find((o) => o.value === next)?.label ?? next;
          toast.success(`Default page set to ${label}`);
        } else {
          toast.error("Failed to update default page");
          setDefaultPage(prev);
        }
      } catch {
        toast.error("Failed to update default page");
        setDefaultPage(prev);
      }
    },
    [defaultPage, isDemoMode, prefsLoaded]
  );

  const handleCurrencyChange = useCallback(async () => {
    if (isDemoMode) return;
    const idx = CURRENCY_OPTIONS.indexOf(currency);
    const next = CURRENCY_OPTIONS[(idx + 1) % CURRENCY_OPTIONS.length];
    const code = next.split(" ")[0];
    setCurrency(next);
    try {
      const result = await updateCurrencyPreferenceAction(code);
      if (result?.success) {
        toast.success(`Currency set to ${code}`);
      } else {
        toast.error("Failed to update currency");
        setCurrency(currency);
      }
    } catch {
      toast.error("Failed to update currency");
      setCurrency(currency);
    }
  }, [currency, isDemoMode]);

  const activeTheme = (theme || "light") as "dark" | "light" | "system";

  return (
    <div className="flex flex-col gap-4">
      {/* Appearance */}
      <SetSection title="Appearance">
        <div style={{ padding: 22 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1.2,
              color: "var(--ink-4)",
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            Theme
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
            {THEMES.map((t) => {
              const active = activeTheme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => !isDemoMode && setTheme(t.id)}
                  disabled={isDemoMode}
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    textAlign: "left",
                    cursor: isDemoMode ? "not-allowed" : "pointer",
                    opacity: isDemoMode ? 0.55 : 1,
                    background: active ? "var(--emerald-bg)" : "var(--paper)",
                    border: `1.5px solid ${active ? "var(--emerald)" : "var(--ink)"}`,
                    transition: "box-shadow .12s, transform .12s",
                  }}
                >
                  <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                    {t.colors.map((c, i) => (
                      <span
                        key={i}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          background: c,
                          border: "1.5px solid var(--ink)",
                        }}
                      />
                    ))}
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      fontWeight: 700,
                      color: active ? "var(--emerald-text)" : "var(--ink)",
                    }}
                  >
                    {t.label}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      marginTop: 2,
                    }}
                  >
                    {t.sub}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </SetSection>

      {/* Defaults & locale */}
      <SetSection title="Defaults & locale">
        {/* Default page — explicit Dashboard | StockSage choice (was a
            click-to-flip row that read as broken). /launch honors this on every
            sign-in path. */}
        <div
          className="set-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 22px",
            borderBottom: "1px dashed var(--rule-soft)",
            opacity: isDemoMode ? 0.55 : 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}
            >
              Default page
            </div>
            <div
              style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}
            >
              Where you land after signing in.
            </div>
          </div>
          <div
            role="radiogroup"
            aria-label="Default page"
            style={{
              display: "inline-flex",
              gap: 4,
              padding: 3,
              borderRadius: 10,
              background: "var(--paper-2)",
              border: "1px solid var(--rule-soft)",
            }}
          >
            {DEFAULT_PAGE_OPTIONS.map((o) => {
              const active = defaultPage === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isDemoMode}
                  onClick={() => handleDefaultPageSelect(o.value)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 7,
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: isDemoMode ? "not-allowed" : "pointer",
                    background: active ? "var(--emerald-bg)" : "transparent",
                    color: active ? "var(--emerald-text)" : "var(--ink-2)",
                    border: active
                      ? "1.5px solid var(--emerald)"
                      : "1.5px solid transparent",
                    transition:
                      "background .12s, color .12s, border-color .12s",
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        <SetRow
          label="Currency"
          value={currency}
          mono
          onClick={handleCurrencyChange}
          locked={isDemoMode}
        />
        <SetRow
          label="Default broker"
          value="Zerodha"
          mono
          onClick={() => {}}
          locked={isDemoMode}
        />
        <SetRow
          label="Timezone"
          value="Asia/Kolkata · IST"
          mono
          onClick={() => {}}
          locked={isDemoMode}
        />
        <SetRow
          label="Language"
          value="English (India)"
          onClick={() => {}}
          locked={isDemoMode}
        />
        <SetRow
          label="Number format"
          value="1,23,456.78 (Indian)"
          mono
          onClick={() => {}}
          locked={isDemoMode}
          last
        />
      </SetSection>

      {/* Privacy */}
      <SetSection title="Privacy">
        <SetToggle
          label="Hide balances"
          hint="Mask P/L and holdings totals as ●●●."
          on={hideBalances}
          onChange={setHideBalances}
          locked={isDemoMode}
        />
        <SetToggle
          label="Anonymized analytics"
          hint="Help us improve. No PII shared."
          on={analytics}
          onChange={setAnalytics}
          locked={isDemoMode}
          last
        />
      </SetSection>
    </div>
  );
}
