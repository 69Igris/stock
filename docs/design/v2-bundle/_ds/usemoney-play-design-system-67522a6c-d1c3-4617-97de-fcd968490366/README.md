# UseMoney — Design System

> **Use money. Intelligently.**
> The AI-native portfolio workspace for Indian retail investors — every broker,
> one workspace, ask AI anything.

This repository is a **design system + brand kit** for **UseMoney AI** (by DIS
Digital LLP). It gives any design agent everything needed to build on-brand
UseMoney interfaces, slides, and assets: the colour & type foundations, the real
brand assets, and two pixel-perfect UI kits (marketing site + the StockSage app)
recreated from the product's own source.

The visual direction is **"Playful"** — a warm, confident, neo-brutalist take on
fintech: **cream paper, ink-black borders, hard offset shadows, a gold
highlighter, and an Instrument-Serif italic flourish.** Editorial, not corporate.
(An earlier dark "Terminal Luxe" direction was **discarded** — ignore it.)

---

## What is UseMoney?

UseMoney unifies a retail investor's brokers into one AI workspace for the Indian
market (NSE & BSE). Core capabilities:

- **Multi-broker sync** — Zerodha, Groww, Angel One, Upstox, Dhan, Fyers, HDFC
  Sky, ICICI Direct. Read-only OAuth; **never places orders.**
- **StockSage** — the AI research & chat engine (Google Gemini 2.5 Pro + Flash).
  Cited, auditable, portfolio-aware. Free chat; deep research spends *credits*.
- **Portfolio Roast** — AI scores & critiques your holdings.
- **Holdings · Tradebook · Positions** — unified, reconciled, FIFO-paired.
- **Paper trading · Backtesting** on live NSE ticks.
- **FIRE Calculator** — retirement planning in ₹ (STCG/LTCG/PPF/EPF aware).
- **Discovery / Screener** across 7,000+ instruments & 14,000+ mutual funds.

Pricing anchors: **Free forever** (5 credits/mo) · **PRO ₹249/mo** · **Premium
₹1,499/mo** · Ultimate ₹4,999/mo.

### Products represented in this kit
1. **Marketing website** — `ui_kits/website/` (12 linked pages)
2. **Authenticated app** — `ui_kits/app/` (~60 screens: shell, dashboard, holdings, discover, tools, learning, settings, auth, dialogs, mobile, QA states)
3. **StockSage** — `ui_kits/stocksage/` (the deep AI research-chat surface)

---

## Sources

Built from materials the UseMoney team provided. The reader may not have access,
but they're recorded here so a future build can go deeper:

- **GitHub:** [`UseMoney-AI/stockbook-monorepo`](https://github.com/UseMoney-AI/stockbook-monorepo)
  — the production Next.js app (`apps/web`). Key files lifted:
  `app/playful-app.css` (authenticated app), `app/(marketing)/playful.css`
  (marketing), `public/brokers/*`, `public/icon-square.svg`, `tailwind.config.js`,
  `app/layout.tsx`. **Explore this repo to build production-grade UseMoney work.**
- **Landing-page design bundle** ("Landing Page from Claude.ai") — `shared/playful.css`,
  `shared/playful.js`, and the 12 marketing HTML pages. These are the canonical
  source for `ui_kits/website/`.
- **StockSage chat bundle** ("Streaming Data Chat Research Report") — the React
  source (`ss-bundle.jsx`, `ss.css`, `ss-blocks.css`) for `ui_kits/stocksage/`.
- **App-redesign bundle** ("New UI Changes" / "Missing Modules for Playful") — the
  full authenticated-app React source (`components/*.jsx`, `shared/playful*.css`,
  `web-index.html`, `mobile-index.html`, and a design canvas of ~60 screens) for
  `ui_kits/app/`. Includes the Tax & Risk modules.
- **Brand asset bundle (v3)** — social banners, favicons, the U brand mark.

---

## Index — what's in this folder

| Path | What |
|------|------|
| `README.md` | This file — context, content & visual foundations, iconography |
| `SKILL.md` | Agent-Skill manifest (for Claude Code etc.) |
| `colors_and_type.css` | **Start here.** Single source of truth: all colour + type tokens, base classes, both themes |
| `styles/playful.css` | Full marketing component CSS (nav, sections, buttons, tables, footer…) |
| `styles/playful-app.css` | Full authenticated-app shell CSS (`.pf-*`: sidebar, topbar, ticker, cards, stats, tables) |
| `assets/` | Brand mark (SVG + PNG), broker logos, AI logos, social banners (`assets/brand/`) |
| `preview/` | The Design System tab cards (colours, type, spacing, components, brand) |
| `ui_kits/website/` | Pixel-perfect marketing site — 12 clickable pages |
| `ui_kits/app/` | Pixel-perfect authenticated app — ~60 screens (start at `web-index.html`) |
| `ui_kits/stocksage/` | Pixel-perfect StockSage AI research-chat app (React) |

---

## CONTENT FUNDAMENTALS — how UseMoney writes

The voice is a **smart, slightly irreverent friend who actually trades** — plain-
spoken, confident, never salesy. It respects the reader's intelligence and time.

- **Person:** Second person ("**your** money", "ask **anything**"). The brand
  speaks as "we" with a founder's candour ("*We* started this because five broker
  tabs and a Google sheet…").
- **Casing:** **Sentence case** everywhere — headlines, buttons, nav. UPPERCASE is
  reserved for **mono labels/eyebrows** (`USE MONEY. INTELLIGENTLY.`, `01 / WHO`,
  `STEP 02`). Never title-case marketing copy.
- **Tone:** Direct and a little cheeky. Crosses out the old way (~~guesswork~~,
  ~~spreadsheets~~) and highlights the new in gold. Confident claims, immediately
  grounded ("Read-only — we can't place orders").
- **Punctuation rhythm:** The signature move is a **period mid-headline** to snap
  two ideas together — *"Every broker. One workspace. No more spreadsheets."* /
  *"Ask anything about your money. No more guesswork."* The second clause often
  drops into *italic serif*.
- **Numbers are concrete & Indian:** ₹ everywhere, Indian digit grouping
  (₹17,24,180 / ₹15-lakh), real tickers (INFY, RELIANCE), real metrics
  (XIRR, 340bps, PE 24.3×). Mono font, tabular figures.
- **Honesty as a feature:** "Not a hit-piece." "we read every email." "simple
  chats are free; deep research costs 1-3 credits." Plain about limits & pricing.
- **No emoji.** Accent glyphs do the work instead: `✦` (trust bullets), `●`
  (live/status), `›` `→` `↪` (mono arrows/prompts), `~~strike~~` for the old way.

**Examples to imitate**
> *Eyebrow:* `● USE MONEY. INTELLIGENTLY.`
> *Headline:* Ask anything about your **money.** <mark>No more</mark> ~~guesswork.~~
> *Lede:* "AI that's actually read your portfolio — every broker, every holding. Real answers, not generic tips."
> *Trust line:* ✦ Read-only · we can't place orders   ✦ 5 free credits / month, forever
> *Sticker:* "**actually shipped:** AI chat · roast · backtest"

---

## VISUAL FOUNDATIONS

### Palette
Cream paper + ink, one emerald brand accent, five "pop" accents used sparingly as
fills. Light is the default; deep-ink dark is a first-class mirror.

- **Surfaces (light):** `--paper #f7f3e6`, `--paper-2 #efe7d0`, `--paper-3 #fbf8eb`
- **Ink:** `--ink #1d1d1b`, `--ink-2 #3a3a35`, `--ink-3 #6b6b62`, `--ink-4 #74746b`
- **Emerald (brand):** `#16a34a` (light) / `#34d399` (dark) — gains, "live", eyebrows
- **Pops:** coral `#ff6b35` · **gold `#fbbf24`** (the highlighter) · blue `#3b82f6`
  · pink `#ff77b9` · violet `#a78bfa`. Use as fills/borders/icons, **not** body text.
- **Accent text:** use the darkened `*-text` tokens for coloured text on paper (AA).
- **Finance:** gain `#16a34a`, loss `#b91c1c` (→ coral in dark).
- **Dark:** paper `#16140e`, ink `#f4ede0` — see `colors_and_type.css`.

### Type
Three brand fonts (source-verified — only these render on playful surfaces),
each with a sharp role:
- **Instrument Serif** — *always italic, weight 400.* The display/accent serif: the
  editorial flourish on a word or two per headline (`.ser`), and for ledes / subs /
  stickers.
- **Inter** (400–800) — the primary body & UI face (`.pf-app`, sidebar, mobile sheet
  all list Inter first). Headlines are **800, very tight tracking**
  (−2 to −3px), line-height ~1.
- **JetBrains Mono** — all numbers, labels, eyebrows, tickers (tabular).
  Uppercase + letter-spaced for labels.
- *DM Sans is **not** a brand font* — only a stack fallback (a leftover Tailwind
  default from the discarded Terminal Luxe); it's not loaded and won't show on
  playful pages.
- **Two highlight devices:** gold marker (`.hl` / `.hl-gold`, gold bg + dark text,
  `box-decoration-break: clone`) and coral strike-through (`.strike`, a rotated
  coral bar — used to cross out the old way).

### The neo-brutalist signature
- **2px solid ink borders** on nearly everything (cards, buttons, inputs, nav).
- **Hard offset shadows** — `4px 4px 0 var(--ink)` (hard) / `3px 3px 0` (soft).
  No blur, no spread. In dark mode the offset goes **black**, not cream.
- **Playful rotation:** brand mark −3°, stickers +4–5°, section number tags −1°,
  small avatars/tiles ±3°. Just enough to feel hand-placed.
- **Cream-paper dot-grid texture** behind everything: two layered radial-gradient
  dot patterns at 7px and 11px.

### Backgrounds, surfaces & cards
- Page = paper + dot grid. Alternating sections use `--paper-2`. The big closing
  CTA is a **locked dark band** (ink bg + cream text) in *both* themes.
- **Cards:** `--paper` fill, 2px ink border, 14px radius, soft offset shadow.
  Sometimes tilted (`.tilt-l/.tilt-r`). No glassmorphism, no gradients.
- **Stickers:** gold fill, tilted, hard shadow, Instrument-Serif italic — used for
  margin annotations and "actually shipped" notes.

### Motion & states
- **Easing:** `cubic-bezier(.22,.61,.36,1)`; fast 120–150ms. Pulsing "live" dots
  (`ph-pulse` 1.6s). Marquee ticker (linear, ~60s loop). `um-fade-up` for reveals.
  No bounces.
- **Hover (the tell):** `transform: translate(-1px,-1px)` **+** a `3px 3px 0` hard
  shadow appears — the element lifts toward you and casts a hard shadow. Solid
  buttons cast an **emerald** shadow on hover.
- **Active/nav:** active item = ink fill + paper text (a solid "stamped" chip).
- **No opacity-dimming** for emphasis; colour/fill changes carry state.

### Borders, radii, blur, transparency
- Radii: 6 (sm) · 8 (md) · 12 (lg) · 14 (xl) · 999 (pill). Buttons/inputs 8px;
  cards 12–14px; pills/avatars fully round.
- **Transparency/blur are rare** — only sticky-nav scroll backdrop and faint rule
  tints (`--rule-soft` 14%, `--rule-softer` 8%). The aesthetic is **opaque & flat**,
  not frosted.
- Imagery: brand photography/illustration is minimal; the system leans on
  **type, colour blocks, and real product UI** (device mockups, code echoes,
  data tables) rather than stock imagery. Broker logos keep their own brand colour
  on a cream tile.

---

## ICONOGRAPHY

- **Lucide** is the icon system (`lucide-react` in production; inline lucide-style
  SVG paths in the kits). **Outline only**, `viewBox 0 0 24 24`, **stroke 1.9–2.2**,
  round caps & joins, `fill:none`. (`@tabler/icons-react` is also present as a
  secondary set.) When you need an icon, pull it from Lucide — don't draw your own.
- **No emoji** in product or marketing. Status & emphasis use glyphs instead:
  `●` (live/synced dots), `✦` (trust bullets), `›` `→` `↪` `↩` `↑` (mono arrows &
  chat prompts), `~~strike~~`. Currency is always `₹`.
- **Brand mark:** a **rounded square, ink fill, cream mono "U", rotated −3°**
  (`assets/usemoney-mark.svg`). It scales 22 → 96px (nav → favicon) and has
  accent-fill variants (gold/emerald/coral/outline). An "M" alternate exists; **U
  ships.** Wordmark = `UseMoney` + an emerald mono `AI` superscript.
- **Real raster assets** live in `assets/`: broker logos (`assets/brokers/`, PNG),
  AI logos (`assets/ai-logos/`, Perplexity + Grok SVG), favicons, and the full
  **social banner set** (`assets/brand/` — X, LinkedIn, Discord, Reddit, Telegram,
  WhatsApp, YouTube, OG). Copy these in rather than recreating them.

---

## How to build with this

1. Link `colors_and_type.css` (and `styles/playful.css` for marketing or
   `styles/playful-app.css` for app shells). Add `class="dark"` to `<html>` for dark.
2. Reuse the real components from the UI kits — the marketing CSS classes
   (`.btn-solid`, `.section`, `.sticker`, `.tag-pill`, `.compare-tbl`…) and the
   `.pf-*` app-shell classes are production-grade.
3. Copy assets from `assets/`; never redraw logos or icons.
4. Follow the content voice above: sentence case, mono labels, ₹ numbers, the
   period-mid-headline rhythm, gold highlight + coral strike, no emoji.
