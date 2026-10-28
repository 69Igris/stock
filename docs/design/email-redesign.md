# Email redesign — cream theme + dark mode + one-click unsubscribe (MONEY-878)

Replaces the generic blue/white email layout with the app's **cream-paper / ink
"playful" theme** (the removed "Terminal Luxe" navy is gone), adds a
`prefers-color-scheme` dark variant, a SEBI footer, social links, RFC 8058
one-click unsubscribe, and an Ask-AI CTA. Source of truth for the email design
system: `packages/email/src/theme.ts` + `packages/email/src/components/`.

## Palette (literal hex — email can't use CSS vars)

| Role                               | Light (cream)         | Dark (deep-ink)          |
| ---------------------------------- | --------------------- | ------------------------ |
| Body / paper                       | `#f7f3e6`             | `#16140e`                |
| Surface / card                     | `#fbf8eb`             | `#1f1c14`                |
| Ink (text)                         | `#1d1d1b`             | `#f4ede0`                |
| Muted text                         | `#6b6b62`             | `#a09a8d`                |
| Primary CTA (emerald)              | `#16a34a`             | `#34d399`                |
| Emerald text-on-cream (AA)         | `#0f7a34`             | `#34d399`                |
| Hairline rule                      | `rgba(29,29,27,0.14)` | `rgba(244,237,224,0.16)` |
| Positive / negative                | `#16a34a` / `#b91c1c` | `#34d399` / `#ff8a5b`    |
| Dark stat band (pinned both modes) | `#1d1d1b` / `#f4ede0` | `#2a2620` / `#f4ede0`    |

Fonts: DM Sans (body/display) · Instrument Serif (accent) · JetBrains Mono
(numbers/labels), each with system fallbacks. Loaded via a Google Fonts
`@import` in the `<Head>` style block (Apple Mail loads them; others fall back).

## Dark mode — the constraint

Email **cannot** follow an in-app preference toggle: the email is static HTML
and the recipient's mail client decides light/dark from the device setting. We
ship cream as the inline default and a dark variant via `.em-*` classes + a
`@media (prefers-color-scheme: dark)` block (`EMAIL_GLOBAL_CSS`), using
`!important` so the dark rules beat the inline light styles.

- **Apple Mail (macOS/iOS):** honours the media query → true deep-ink dark.
- **Gmail / Outlook:** ignore it and force their own inversion — the cream
  palette is chosen to survive that gracefully.
- Inline styles can't carry media queries, so dark mode lives in the
  `<Head><style>` block (react-email supports it via `dangerouslySetInnerHTML`).

## Component kit (`packages/email/src/components/index.tsx`)

`EmailHead`, `EmailFooter`, `SocialLinks`, `EHeading`, `ESubheading`, `EText`
(`muted`), `EListItem`, `EEyebrow`, `EButton`, `ECallout`, `EStatStrip` (dark
mono band for counts), `AskAiCta`. All 20 templates build from these.

## Layout variants (`templates/layout.tsx`)

`EmailLayout` is backward-compatible (`preview` / `unsubscribeUrl` /
`hideUnsubscribe`) + a new `variant`:

- **`system`** (default) — transactional/account/notification emails. Compact;
  no social row.
- **`editorial`** — newsletter/marketing. Social links in the footer.

## SEBI disclaimer

Entity-level wording in the shared footer (`SEBI_DISCLAIMER`) — used because not
every email is AI-generated. **DRAFT placeholder pending legal sign-off
(MONEY-149/879)** — replace `SEBI_DISCLAIMER` with the approved copy before
shipping to real inboxes.

## Unsubscribe — all paths

| Path             | Emails                                            | Mechanism                                                                  |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| Newsletter       | newsletter-issue / welcome / verify               | `/api/newsletter/unsubscribe` + one-click header                           |
| Per-category     | broker / sync / trade-import / payment / ai-limit | `/api/email/preferences/unsubscribe?category=…` + Settings → Notifications |
| Never (security) | welcome / otp / account-deleted / broker-request  | no link                                                                    |

Both routes now expose a **POST** handler (RFC 8058 one-click → blank `200`) in
addition to the GET confirmation page (re-skinned to cream). `sendEmail()` emits
`List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
whenever an `unsubscribeUrl` is passed; the newsletter bulk path and all 14
transactional sends pass it. (Resend broadcasts inject the header automatically.)

## Ask-AI CTA

Deep-links to `/chat?q=…` and carries the SEBI line. Wired into **newsletter,
sync-complete, broker-connected**. Deliberately NOT in OTP / receipts /
account-deleted (keeps them clean for trust + deliverability).

## Owed before this ships (founder-gated)

1. **Legal sign-off** on the exact SEBI footer wording (then update
   `SEBI_DISCLAIMER`).
2. Push → Vercel preview → merge.
3. **Worker redeploy** — `workers/src/processors/sync.ts` and
   `newsletter-publish.ts` bundle these templates.
4. Optional: set `EMAIL_COMPANY_ADDRESS` to add a physical address to the footer
   (CAN-SPAM / bulk-mail hygiene). Left blank by default — not invented.

## Not in scope (future)

- A **digest/data** layout variant for the planned weekly-health (MONEY-153) and
  daily-market (MONEY-154) emails — build alongside those tickets.
- Hosted monochrome social icons (currently typographic text links).
