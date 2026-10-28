"use client";

interface PfFireNumInputProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  hint?: string;
  min?: number;
}

export function PfFireNumInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  hint,
  min,
}: PfFireNumInputProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: "var(--ink-3)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          background: "var(--rule-softer)",
          border: "1.5px solid var(--ink)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {prefix && (
          <span
            className="mono"
            style={{
              padding: "9px 4px 9px 10px",
              fontSize: 13,
              color: "var(--ink-3)",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            {prefix}
          </span>
        )}
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min}
          style={{
            flex: 1,
            background: "transparent",
            border: 0,
            color: "var(--ink)",
            padding: "9px 10px",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 13.5,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            outline: "none",
            minWidth: 0,
            width: "100%",
          }}
        />
        {suffix && (
          <span
            className="mono"
            style={{
              padding: "9px 10px 9px 4px",
              fontSize: 12,
              color: "var(--ink-3)",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            {suffix}
          </span>
        )}
      </div>
      {hint && (
        <span style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
    </label>
  );
}
