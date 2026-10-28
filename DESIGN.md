---
name: UseMoney Playful
version: 1.0.0
updated: 2026-09-23
source: docs/design/v2-bundle/styles/colors_and_type.css (spec) · apps/web/app/playful-app.css (live)
colors:
  light:
    paper: "#f7f3e6"
    paper-2: "#efe7d0"
    paper-3: "#fbf8eb"
    ink: "#1d1d1b"
    ink-2: "#3a3a35"
    ink-3: "#6b6b62"
    ink-4: "#74746b"
    rule: "#1d1d1b"
    rule-soft: "rgba(29,29,27,0.14)"
    rule-softer: "rgba(29,29,27,0.08)"
    emerald: "#16a34a"
    emerald-text: "#0f7a34"
    pop-1: "#ff6b35"
    pop-1-text: "#b23c0a"
    pop-2: "#fbbf24"
    pop-2-text: "#8a5e00"
    pop-3: "#3b82f6"
    pop-3-text: "#1d4ed8"
    pop-4: "#ff77b9"
    pop-4-text: "#be185d"
    pop-5: "#a78bfa"
    pop-5-text: "#6d28d9"
    gain: "#16a34a"
    loss: "#b91c1c"
    on-pop: "#1d1d1b"
  dark:
    paper: "#16140e"
    paper-2: "#1f1c14"
    paper-3: "#1a1810"
    ink: "#f4ede0"
    ink-2: "#d8d1c4"
    ink-3: "#a09a8d"
    ink-4: "#8a8478"
    rule: "#f4ede0"
    emerald: "#34d399"
    pop-1: "#ff8a5b"
    pop-2: "#fcd34d"
    pop-3: "#60a5fa"
    pop-4: "#f9a8d4"
    pop-5: "#c4b5fd"
    gain: "#34d399"
    loss: "#ff8a5b"
    on-pop: "#1d1d1b"
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 14px
  pill: 999px
shadow:
  hard: "4px 4px 0 var(--ink)" # dark: 4px 4px 0 #000
  soft: "3px 3px 0 var(--ink)" # dark: 3px 3px 0 #000
border:
  strong: "2px solid var(--rule)"
  hairline: "1px solid var(--rule-soft)"
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 20px
  6: 24px
  8: 32px
  10: 40px
  12: 48px
  gutter-mobile: 18px
typography:
  ui: "DM Sans (next/font)"
  accent: "Instrument Serif, italic only"
  mono: "JetBrains Mono (numbers, labels, meta)"
  scale:
    hero: "clamp(40px, 7vw, 96px)"
    h1: 38px
    h2: "clamp(34px, 5vw, 64px)"
    h3: 22px
    lede: 24px
    body: 15px
    sm: 13px
    meta: 11px
motion:
  press: "transform + shadow 4px→0, ease-out, ≤200ms"
  progress: "ProgressSteps step advance, ease-out, ≤200ms"
  count-up: "Ready-screen total, ease-out, ≤800ms"
  reduced-motion: "all disabled"
---

# UseMoney design system: Playful

This is the one written source for how UseMoney looks and behaves. The visual spec is the
Claude Design v2 bundle (`docs/design/v2-bundle/`), and the live implementation is
`apps/web/app/playful-app.css`. When they disagree, this file wins and one of them gets fixed.
Every rule below traces to a decision recorded in
`docs/gstack/ceo-review-2026-09-23-product-roadmap/product-plan-and-roadmap.md` (IDs starting DS- and D).

Direction: **editorial, playful, trustworthy**. Cream paper, ink, hard offset shadows, one gold
highlighter, mono numbers, an italic serif flourish. The discarded Terminal Luxe look (navy, neon
emerald `#34d399` on dark) is not coming back outside dark mode.

## 1. Color

- **Use tokens, never hex.** Write `var(--ink)`, never `#1d1d1b`. New code must not add hex
  literals; the sweep of the 853 existing literals is tracked in `TODOS.md`.
- **Fill vs text.** `--pop-N` and `--emerald` are for fills, borders and icons only. Text in an
  accent color uses the `-text` twin (`--pop-2-text`, `--emerald-text`, …). Every `-text` twin
  clears WCAG AA (≥4.5:1) on paper. A lint rule flags `var(--pop-N)` / `var(--emerald)` used as a
  text color (DS-A11Y1).
- **Muted text** is `--ink-3`. `--ink-4` is decorative meta only (near-AA). The legacy
  `--text-muted` (#9a9a92, 2.55:1) is retired to `--ink-3` (DS-A11Y1).
- **On a pop fill**, text is `--on-pop` (constant ink in both themes).
- **Ink-dark bands that must not flip in dark mode** (stat strips, tickers, code, the StockSage
  card) use `--code-bg` / `--code-fg` / `--code-dim`, not `var(--ink)` + `var(--paper)`.
- **Gold sticker surfaces** use `--sticker-bg` / `--sticker-fg` / `--sticker-dim`.
- **Gain / loss**: `--emerald-text` for gains, `--neg-text` for losses in running text. Never pair
  red/green as the only signal: always add a sign (+/−) or an arrow.
- **One accent per surface.** Gold is the brand highlighter; the other pops are for categories and
  charts. No gradients, and no purple/blue as a brand surface (the blue demo banner and purple
  Premium label are replaced; DS-SLOP1).

## 2. Type

- UI and body: **DM Sans** via `next/font` (as shipped). Numbers, tickers, labels and meta:
  **JetBrains Mono** with tabular numerals. Flourish: **Instrument Serif, italic only**, one word
  or phrase per heading at most ("Every rupee, _accounted for._").
- Known debt (founder decision D13, "keep current"): `playful-app.css` also `@import`s Inter and a
  second JetBrains Mono from Google Fonts. v2 lists Inter as the UI font. Shipped reality is DM
  Sans. Do not add new Inter usage.
- Body text is never below 15px; meta labels (11px mono, +1.5 letter-spacing, uppercase) are the
  only small type.
- Headings sit closer to what follows than to what precedes (more space above than below).

## 3. Shape, border, elevation

- Radius: `sm 6 · md 8 · lg 12 · xl 14 · pill 999`. Buttons and inputs `md`, panels `lg`,
  chips `pill`.
- Borders: interactive and primary elements get `2px solid var(--rule)`; data panels get a
  hairline `1px solid var(--rule-soft)`.
- **The hard shadow is rationed** (DS OV-12 / D31). `--shadow-hard` goes only on buttons, primary
  path blocks (e.g. "Connect Zerodha" on /start) and hero numbers. Data panels, tables and
  lists get **no shadow**. The shadow means "you can press this" or "this is the headline".
- Offset shadows stay black in dark mode (the tokens handle it).

## 4. Spacing

v2 had no spacing tokens; these are new and apply to new code: `4 · 8 · 12 · 16 · 20 · 24 · 32 ·
40 · 48`. Mobile side gutter is 18px. Don't invent in-between values; use the nearest step.

## 5. Motion (D30)

Only three motions exist:

1. **Press-down**: buttons shift by the shadow offset and the shadow drops 4px → 0 on press.
2. **ProgressSteps**: step advance on first sync and roast runs.
3. **Count-up**: the total on the "Portfolio ready" screen.

All ease-out, ≤200ms (count-up ≤800ms). `prefers-reduced-motion` disables all three. Nothing else
animates: no entrance animations, no hover effects that carry no information, no pulsing dots.

## 6. Focus and accessibility (D15, D14)

- Every interactive element shows a visible `:focus-visible` ring: `2px solid var(--ink)`, 2px
  offset (gold `--pop-2` in dark mode). Bare `outline: none` without a replacement is not allowed.
- Touch targets ≥44px on mobile.
- Dialogs (/start overlay, /upgrade checkout confirm, share sheet) use `role="dialog"`, trap focus,
  close on Esc, and return focus to the trigger.
- Selectable cards/chips expose `aria-pressed` or are real radio inputs.
- Status changes users must notice (broker failures, payment state) use `role="alert"` or
  `aria-live="polite"`.

## 7. Components (use these, don't re-invent)

| Need               | Use                                                                                 | Notes                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Buttons            | `.pf-bf` (filled, primary) · `.pf-bs` (secondary)                                   | Converging all buttons onto these (TODO sweep). New code must not add shadcn `<Button>` or inline-styled buttons |
| Primary path block | `.pf-bf` + `--shadow-hard`, full width on mobile                                    | One per screen                                                                                                   |
| Demo banner        | v2 `DemoBanner` gold strip: "DEMO DATA: exploring as a guest · Make this mine →"    | Replaces the blue banner (DS-SLOP1, D26)                                                                         |
| Broker freshness   | Inline chip beside "last synced": "Data from yesterday's close · Refresh"           | Routine daily Zerodha expiry (D20)                                                                               |
| Broker failure     | `BrokerReauthBanner` (`role=alert`) at dashboard top + holdings/positions/tradebook | Only when the grant is revoked or refresh has failed 2+ days (D20)                                               |
| Tier gate          | `GateInline` card in place of the locked control, CTA → `/upgrade`                  | Never a modal (DS-UNRES1)                                                                                        |
| Stale FX           | `DataGapBanner` "FX rate from {date} · values approximate"                          |                                                                                                                  |
| Empty state        | `EmptyState` (v2 kit2.jsx) with one primary action                                  | Never show ₹0 tiles as an empty state (DS-ST1)                                                                   |
| Mobile nav         | v2 `TabBarV2`: Home · Portfolio · Sage (raised centre) · Discover · You             | Brokers lives under Portfolio (D29)                                                                              |

## 8. Screen rules (build spec = named v2 screen)

| Screen                | v2 spec                                 | Rules                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start` first run    | `app/s-firstrun.jsx` ConnectIntroScreen | Order: headline → **primary** "Connect Zerodha" → secondary "Upload statement/CSV" → text link "Just look around →" (demo) → "coming soon · notify me" row for other brokers. Desktop keeps the vertical order, max-width 640 (D21). Terms modal shows once, before /start (D26)               |
| First sync / Ready    | FirstSyncScreen, FirstReadyScreen       | Centred 560px card; ≥1024px steps left, totals right. Ready primary CTA **"Roast my portfolio"**, secondary "Take me to my money" (D26)                                                                                                                                                        |
| Dashboard (no data)   | none; new                               | Hero "Your money isn't here yet." + the same primary/secondary order as /start + StockSage chips. Server decides has-data; skeleton never flashes into the hero                                                                                                                                |
| `/upgrade`            | `app/s-account.jsx` PlanScreenV2        | Blurred preview of the user's own result; with no result, a blurred demo roast tagged "Example" (D24). Recommended plan: **Premium**; price currency by IP (D25). Pending payment: header chip "Payment confirming · we'll email you", and /upgrade shows the pending card, not checkout (D23) |
| Roast + share         | `app/s-roast.jsx` RoastShareSheet       | Works for any holdings source (D9). Share actions in order: WhatsApp · Download image · Copy link (X under more). The shared link opens a public page: score + one-liner only, CTA "Roast yours" with referral code (D27). Desktop: 480px modal                                                |
| Referral              | `InviteScreenV2`                        | Reward on the friend's activation (broker connect or first roast), cap 10/month (D11.2)                                                                                                                                                                                                        |
| US connect / holdings | `app/s-us.jsx`                          | Desktop 2-column (choices / trust + consent copy). Free users see `GateInline` → `/upgrade?market=US`                                                                                                                                                                                          |

The binding loading / empty / error / success / partial copy for every new screen is the state
table in the roadmap plan (DS-ST3, D22, D28). Build to it; don't invent error UI.

## 9. Copy voice

- Utility language in the app: say what it is, its status, and the action. No hype.
- Be honest about brokers: Zerodha is live today and any broker works by statement. Never claim
  "every broker" or show a broker as connectable before it is (DS-ST2, DS-JRN2).
- Trust line wherever money or broker access appears: "Read-only · we can never place orders."
- Errors say what happened and what to do, and that nothing was lost or charged when true
  ("Couldn't roast right now · no credit used").

## 10. What not to do

- No hex literals, no new inline `style={{}}` colors, no Inter, no purple/blue brand surfaces.
- No hard shadow on data panels, no card mosaics, no three-equal-cards first impressions.
- No modal paywalls; gates are inline.
- No animation outside section 5.
- No placeholder-as-label inputs; labels stay visible.
