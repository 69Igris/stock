"use client";

import { FormEvent, useState } from "react";
import {
  X,
  Check,
  Info,
  PieChart,
  Repeat2,
  PlusCircle,
  Activity,
} from "lucide-react";

import { Dropdown, TerminalInput, DropdownOption } from "./primitives";
import { InstrumentAutocomplete } from "./InstrumentAutocomplete";
import { PfDatePicker } from "../playful/PfDatePicker";

export type ManualEntryKind = "holding" | "fund" | "trade" | "position";

export interface ManualEntrySubmission {
  kind: ManualEntryKind;
  ticker: string;
  qty: string;
  price: string;
  side: "BUY" | "SELL";
  broker: string;
  date: string;
  time: string;
  product: string;
  segment: string;
  notes: string;
  folio: string;
  scheme: string;
  /** mutual-fund scheme code captured when a scheme is picked from search */
  schemeCode: string;
}

const TITLES: Record<ManualEntryKind, string> = {
  holding: "Add manual holding",
  fund: "Add mutual fund holding",
  trade: "Add manual trade",
  position: "Add manual position",
};
const SUBS: Record<ManualEntryKind, string> = {
  holding:
    "For stocks not synced from a broker (e.g. legacy demat, off-market transfer).",
  fund: "Track SIPs, lump-sums, or AMC-direct mutual fund units.",
  trade: "Useful for off-market deals or imports your broker missed.",
  position: "An open paper-trading position you want to track manually.",
};

interface BrokerOption {
  /** Internal value used by server actions (e.g. "ZERODHA"). */
  value: string;
  /** Display label (e.g. "Personal · Zerodha"). */
  label: string;
  /** Description (e.g. broker user id). */
  desc?: string;
}

export function ManualEntryModal({
  open,
  onClose,
  onSave,
  kind = "holding",
  brokerOptions = [],
  isSubmitting = false,
}: {
  open: boolean;
  onClose: () => void;
  onSave?: (data: ManualEntrySubmission) => Promise<void> | void;
  kind?: ManualEntryKind;
  brokerOptions?: BrokerOption[];
  isSubmitting?: boolean;
}) {
  const [form, setForm] = useState<ManualEntrySubmission>(() => ({
    kind,
    ticker: "",
    qty: "",
    price: "",
    side: "BUY",
    broker: brokerOptions[0]?.value ?? "manual",
    date: new Date().toISOString().slice(0, 10),
    time: "10:30",
    product: "CNC",
    segment: "NSE-EQ",
    notes: "",
    folio: "",
    scheme: "",
    schemeCode: "",
  }));

  if (!open) return null;

  const isFund = kind === "fund";
  const isTrade = kind === "trade";
  const isPosition = kind === "position";

  const set = <K extends keyof ManualEntrySubmission>(
    k: K,
    v: ManualEntrySubmission[K]
  ) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (onSave) await onSave({ ...form, kind });
  };

  const brokerDropdownOptions: DropdownOption[] =
    brokerOptions.length > 0
      ? brokerOptions.map((b) => ({
          value: b.value,
          label: b.label,
          desc: b.desc,
        }))
      : [
          {
            value: "manual",
            label: "Manual / Off-market",
            desc: "No broker linked",
          },
        ];

  const TitleIcon = isFund
    ? PieChart
    : isTrade
      ? Repeat2
      : isPosition
        ? Activity
        : PlusCircle;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,.6)",
          backdropFilter: "blur(4px)",
          zIndex: 100,
          animation: "um-fade-in .15s ease",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%,-50%)",
          width: "min(540px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 60px)",
          overflow: "auto",
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          zIndex: 101,
          boxShadow: "6px 6px 0 var(--ink)",
          animation: "um-fade-in .18s ease",
        }}
      >
        <div
          style={{
            padding: "18px 20px",
            borderBottom: "1px solid var(--rule-soft)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: "var(--emerald-bg)",
              color: "var(--emerald)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <TitleIcon style={{ width: 17, height: 17 }} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="um-section-label" style={{ marginBottom: 4 }}>
              Manual entry
            </div>
            <h3
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: "-.3px",
                color: "var(--ink)",
              }}
            >
              {TITLES[kind]}
            </h3>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 12.5,
                color: "var(--ink-3)",
              }}
            >
              {SUBS[kind]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: "var(--rule-softer)",
              border: "1px solid var(--rule-soft)",
              color: "var(--ink-3)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <form onSubmit={submit} style={{ padding: 20 }}>
          {isTrade && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
                padding: 4,
                background: "var(--rule-softer)",
                borderRadius: 9,
                border: "1px solid var(--rule-soft)",
                marginBottom: 14,
              }}
            >
              {(["BUY", "SELL"] as const).map((s) => {
                const active = form.side === s;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set("side", s)}
                    style={{
                      padding: "8px 0",
                      borderRadius: 6,
                      border: 0,
                      cursor: "pointer",
                      background: !active
                        ? "transparent"
                        : s === "BUY"
                          ? "linear-gradient(135deg,#34d399,#10b981)"
                          : "linear-gradient(135deg,#f87171,#ef4444)",
                      color: !active
                        ? "var(--ink-3)"
                        : s === "BUY"
                          ? "#16140e"
                          : "#fff",
                      fontFamily:
                        "var(--font-jetbrains), ui-monospace, monospace",
                      fontWeight: 700,
                      letterSpacing: 1.5,
                      fontSize: 12,
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isFund ? "1fr" : "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            {isFund ? (
              <InstrumentAutocomplete
                label="Scheme name"
                kind="fund"
                mono={false}
                value={form.scheme}
                onChange={(v) =>
                  // free-typing invalidates a previously-picked schemeCode
                  setForm((f) => ({ ...f, scheme: v, schemeCode: "" }))
                }
                onSelect={(item) =>
                  setForm((f) => ({
                    ...f,
                    scheme: item.name,
                    schemeCode: item.symbol,
                  }))
                }
                placeholder="e.g. Parag Parikh Flexi Cap Direct Growth"
                required
              />
            ) : (
              <InstrumentAutocomplete
                label="Ticker"
                kind="stock"
                mono
                value={form.ticker}
                onChange={(v) => set("ticker", v.toUpperCase())}
                onSelect={(item) =>
                  setForm((f) => ({
                    ...f,
                    ticker: item.symbol.toUpperCase(),
                    segment: item.exchange === "BSE" ? "BSE-EQ" : "NSE-EQ",
                  }))
                }
                placeholder="RELIANCE"
                required
              />
            )}
            {!isFund && (
              <Dropdown
                label="Segment"
                value={form.segment}
                onChange={(v) => set("segment", v)}
                options={[
                  {
                    value: "NSE-EQ",
                    label: "NSE · Equity",
                    desc: "Cash market, NSE listed",
                  },
                  {
                    value: "BSE-EQ",
                    label: "BSE · Equity",
                    desc: "Cash market, BSE listed",
                  },
                  {
                    value: "NSE-FO",
                    label: "NSE · F&O",
                    desc: "Futures & options",
                  },
                  {
                    value: "MCX",
                    label: "MCX · Commodity",
                    desc: "Commodities exchange",
                  },
                ]}
              />
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isFund ? "1fr 1fr 1fr" : "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <TerminalInput
              label={isFund ? "Units" : "Quantity"}
              mono
              type="number"
              step={isFund ? "0.001" : "1"}
              value={form.qty}
              onChange={(e) => set("qty", e.target.value)}
              placeholder="0"
              required
            />
            <TerminalInput
              label={isFund ? "NAV" : isTrade ? "Trade price" : "Avg buy price"}
              mono
              type="number"
              step="0.01"
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              placeholder="0.00"
              required
            />
            {isFund && (
              <TerminalInput
                label="Folio"
                mono
                value={form.folio}
                onChange={(e) => set("folio", e.target.value)}
                placeholder="-"
              />
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: isTrade ? "1fr 1fr 1fr" : "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <PfDatePicker
              label="Date"
              id="manual-entry-date"
              aria-label="Trade date"
              value={form.date}
              onChange={(iso) => set("date", iso)}
            />
            {isTrade && (
              <TerminalInput
                label="Time"
                type="time"
                mono
                value={form.time}
                onChange={(e) => set("time", e.target.value)}
              />
            )}
            <Dropdown
              label={isFund ? "AMC / Source" : "Broker / Source"}
              value={form.broker}
              onChange={(v) => set("broker", v)}
              options={brokerDropdownOptions}
            />
          </div>

          {(isTrade || isPosition) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <Dropdown
                label="Product"
                value={form.product}
                onChange={(v) => set("product", v)}
                options={[
                  { value: "CNC", label: "CNC · Delivery", desc: "Buy & hold" },
                  {
                    value: "MIS",
                    label: "MIS · Intraday",
                    desc: "Square off same day",
                  },
                  {
                    value: "NRML",
                    label: "NRML · Carry-fwd",
                    desc: "F&O overnight",
                  },
                ]}
              />
              <TerminalInput
                label="Tag (optional)"
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="e.g. swing"
              />
            </div>
          )}

          {!isTrade && !isPosition && (
            <TerminalInput
              label="Notes (optional)"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Any context to remember"
            />
          )}

          <div
            style={{
              marginTop: 18,
              padding: 12,
              background: "var(--rule-softer)",
              border: "1px solid var(--rule-soft)",
              borderRadius: 8,
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
            }}
          >
            <Info
              style={{
                width: 13,
                height: 13,
                color: "var(--pop-5-text)",
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <span
              style={{
                fontSize: 11.5,
                color: "var(--ink-2)",
                lineHeight: 1.5,
              }}
            >
              Manual entries are tagged{" "}
              <span
                className="pf-pill violet"
                style={{
                  fontSize: 10.5,
                  padding: "1px 5px",
                  borderRadius: 4,
                }}
              >
                MANUAL
              </span>{" "}
              and won&apos;t be overwritten by broker syncs. You can edit or
              delete them anytime.
            </span>
          </div>

          <div
            style={{
              marginTop: 18,
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
            }}
          >
            {/* Cancel — flat/outline playful button */}
            <button
              type="button"
              className="pf-bf"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                opacity: isSubmitting ? 0.5 : 1,
                cursor: isSubmitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            {/* Save — solid emerald playful button */}
            <button
              type="submit"
              className="pf-bs"
              disabled={isSubmitting}
              style={{
                background: isSubmitting
                  ? "var(--rule-soft)"
                  : "var(--emerald)",
                borderColor: isSubmitting ? "var(--rule-soft)" : "var(--ink)",
                color: isSubmitting ? "var(--ink-3)" : "var(--paper)",
                cursor: isSubmitting ? "not-allowed" : "pointer",
              }}
            >
              <Check style={{ width: 13, height: 13 }} /> Save{" "}
              {isFund
                ? "fund"
                : isTrade
                  ? "trade"
                  : isPosition
                    ? "position"
                    : "holding"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
