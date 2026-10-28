"use client";

interface PfFireSliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  accentColor?: string;
}

export function PfFireSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  accentColor = "var(--emerald)",
}: PfFireSliderProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
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
        <span
          className="mono"
          style={{ fontSize: 14, fontWeight: 800, color: accentColor }}
        >
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="pf-fire-slider"
        style={{ accentColor }}
      />
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "var(--ink-4)",
          fontSize: 10,
          marginTop: -4,
        }}
      >
        <span>
          {min}
          {suffix}
        </span>
        <span>
          {max}
          {suffix}
        </span>
      </div>
    </label>
  );
}
