/**
 * Shared email component kit (MONEY-878). Every template builds from these so
 * the cream theme + dark-mode classes + spacing stay consistent across all 20
 * emails. Each primitive sets the light value inline AND attaches an `.em-*`
 * class so the dark-mode `@media` block in EMAIL_GLOBAL_CSS can override it.
 *
 * Footer is a cream band (light default, dark-mode override) with text social
 * links + an optional "Was this email useful?" widget.
 */

import {
  Button,
  Column,
  Head,
  Heading,
  Hr,
  Img,
  Link,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";
import {
  EMAIL_FEEDBACK_WIDGET_ENABLED,
  LOGO_URL,
  WEB_APP_URL,
} from "../constants";
import {
  COMPANY_ADDRESS,
  EMAIL_ASSETS_URL,
  EMAIL_GLOBAL_CSS,
  fonts,
  SEBI_DISCLAIMER,
  SOCIAL_LINKS,
} from "../theme";

// ---------------------------------------------------------------------------
// Head — fonts, color-scheme meta, dark-mode style block
// ---------------------------------------------------------------------------

export function EmailHead() {
  return (
    <Head>
      <meta name="color-scheme" content="light" />
      <meta name="supported-color-schemes" content="light" />
      <style dangerouslySetInnerHTML={{ __html: EMAIL_GLOBAL_CSS }} />
    </Head>
  );
}

// ---------------------------------------------------------------------------
// Text primitives
// ---------------------------------------------------------------------------

export function EHeading({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <Heading className="em-ink" style={{ ...headingStyle, ...style }}>
      {children}
    </Heading>
  );
}

export function ESubheading({ children }: { children: React.ReactNode }) {
  return (
    <Heading as="h2" className="em-ink" style={subheadingStyle}>
      {children}
    </Heading>
  );
}

export function EText({
  children,
  style,
  muted,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  muted?: boolean;
}) {
  return (
    <Text
      className={muted ? "em-ink-3" : "em-ink-2"}
      style={{ ...(muted ? mutedTextStyle : textStyle), ...style }}
    >
      {children}
    </Text>
  );
}

export function EListItem({ children }: { children: React.ReactNode }) {
  return (
    <Text className="em-ink-2" style={listItemStyle}>
      <span className="em-eyebrow" style={bulletStyle}>
        •
      </span>
      {children}
    </Text>
  );
}

export function EEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text className="em-eyebrow" style={eyebrowStyle}>
      <span style={eyebrowDot}>●</span>
      <span style={{ verticalAlign: "middle" }}>{children}</span>
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export function EButton({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Section style={{ margin: "22px 0 6px" }}>
      <Button className="em-btn" style={buttonStyle} href={href}>
        {children}
      </Button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Callout (note box) — soft surface with an emerald left rule
// ---------------------------------------------------------------------------

export function ECallout({ children }: { children: React.ReactNode }) {
  return (
    <Section className="em-callout" style={calloutStyle}>
      {children}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// StatStrip — the signature dark mono "band" for counts (stays dark in both
// modes, like the app's terminal band). Renders e.g. HOLDINGS 12 · TRADES 540.
// ---------------------------------------------------------------------------

export function EStatStrip({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <Section className="em-band" style={bandStyle}>
      <Row>
        {items.map((it, i) => (
          <Column key={i} style={{ textAlign: "center" as const }}>
            <Text style={bandLabel}>{it.label}</Text>
            <Text style={bandValue}>{it.value}</Text>
          </Column>
        ))}
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Ask-AI CTA — drives re-engagement back into chat. Carries the disclaimer.
// ---------------------------------------------------------------------------

export function AskAiCta({
  prompt,
  ctaLabel = "Ask UseMoney AI",
  appUrl = WEB_APP_URL,
  tool,
  toolParams,
  userText,
}: {
  prompt: string;
  ctaLabel?: string;
  appUrl?: string;
  /**
   * Optional DETERMINISTIC tool dispatch (MONEY-887). When set, the deep-link
   * is `?tool=...&toolParams=...&userText=...`, which `executeToolDirect`
   * fires on mount BYPASSING the chat classifier — so a "summarise this post"
   * CTA can't collapse to get_portfolio_summary. Without `tool` it falls back
   * to the free-text `?prompt=` path.
   */
  tool?: string;
  toolParams?: Record<string, unknown>;
  userText?: string;
}) {
  // The chat lives at /stocksage (apps/web/app/stocksage/client.tsx); /chat 404s.
  const href = tool
    ? `${appUrl}/stocksage?tool=${encodeURIComponent(tool)}` +
      `&toolParams=${encodeURIComponent(JSON.stringify(toolParams ?? {}))}` +
      `&userText=${encodeURIComponent(userText ?? prompt)}`
    : `${appUrl}/stocksage?prompt=${encodeURIComponent(prompt)}`;
  return (
    <Section
      className="em-callout"
      style={{ ...calloutStyle, marginTop: "24px" }}
    >
      <EEyebrow>Ask UseMoney AI</EEyebrow>
      <Text className="em-ink-2" style={{ ...textStyle, margin: "0 0 4px" }}>
        “{prompt}”
      </Text>
      <Link className="em-link" href={href} style={askLink}>
        {ctaLabel} →
      </Link>
      <Text className="em-ink-3" style={askDisclaimer}>
        {SEBI_DISCLAIMER}
      </Text>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Social links — graphical icons (hosted PNGs under /email/social/*.png),
// centered in the footer band. The glyphs are generated ink-toned to read on
// the light cream footer (scripts/ops/gen-email-icons.cjs).
// ---------------------------------------------------------------------------

export function SocialLinks() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={6}
      align="center"
      style={{ margin: "0 auto 16px" }}
    >
      <tbody>
        <tr>
          {SOCIAL_LINKS.map((s) => (
            <td key={s.label} style={askAiCell}>
              <Link href={s.href} style={{ textDecoration: "none" }}>
                <Img
                  src={`${EMAIL_ASSETS_URL}/email/social/${s.icon}`}
                  width="20"
                  height="20"
                  alt={s.label}
                  style={{ display: "block", border: 0, margin: "0 auto" }}
                />
              </Link>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Ask-AI row — mirrors the web footer's "Ask AI about UseMoney AI" cluster
// (apps/web/components/marketing/PlayfulFooter.tsx). Each assistant is a hosted
// brand PNG (/email/ai/*.png, generated by scripts/ops/gen-email-icons.cjs) on
// a LIGHT rounded cell in BOTH modes: the dark marks (ChatGPT / Grok ink) are
// baked into the PNG and can't be recolored for dark mode like the site's
// currentColor glyphs, so a fixed light cell keeps every mark legible. Each
// deep-link opens the assistant pre-loaded with a one-line prompt about the
// product.
// ---------------------------------------------------------------------------

const ASK_AI_PROMPT =
  "Tell me about UseMoney AI — the AI-native portfolio workspace for Indian retail investors (NSE & BSE). https://usemoney.ai";

const ASK_AI_TARGETS = [
  { label: "Claude", icon: "claude.png", base: "https://claude.ai/new?q=" },
  { label: "ChatGPT", icon: "chatgpt.png", base: "https://chatgpt.com/?q=" },
  {
    label: "Perplexity",
    icon: "perplexity.png",
    base: "https://www.perplexity.ai/search/new?q=",
  },
  {
    label: "Gemini",
    icon: "gemini.png",
    base: "https://gemini.google.com/app?q=",
  },
  { label: "Grok", icon: "grok.png", base: "https://grok.com/?q=" },
] as const;

export function AskAiRow() {
  const q = encodeURIComponent(ASK_AI_PROMPT);
  return (
    <Section style={askAiSection}>
      <Text className="em-foot-dim" style={askAiLabel}>
        Ask AI about UseMoney AI
      </Text>
      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={6}
        align="center"
        style={{ margin: "0 auto" }}
      >
        <tbody>
          <tr>
            {ASK_AI_TARGETS.map((a) => (
              <td key={a.label} style={askAiCell}>
                <Link href={`${a.base}${q}`} style={{ textDecoration: "none" }}>
                  <Img
                    src={`${EMAIL_ASSETS_URL}/email/ai/${a.icon}`}
                    width="20"
                    height="20"
                    alt={a.label}
                    style={{ display: "block", border: 0, margin: "0 auto" }}
                  />
                </Link>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// "Was this email useful?" — Yes/No widget (Anthropic-style). Links to the
// email-feedback route with the template tag. Only rendered when a template
// opts in (excluded on account-deleted / cancelled / OTP / failures).
// ---------------------------------------------------------------------------

export function WasThisUseful({
  template,
  appUrl = WEB_APP_URL,
}: {
  template: string;
  appUrl?: string;
}) {
  const base = `${appUrl}/api/email/feedback?t=${encodeURIComponent(template)}`;
  return (
    <Section className="em-feedback" style={feedbackBox}>
      <Text className="em-foot-ink" style={feedbackTitle}>
        Was this email useful?
      </Text>
      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={0}
        align="center"
        style={{ margin: "0 auto" }}
      >
        <tbody>
          <tr>
            <td style={{ padding: "0 11px" }}>
              <Link
                className="em-foot-link"
                href={`${base}&v=up`}
                style={socialLink}
              >
                Yes
              </Link>
            </td>
            <td style={{ padding: "0 11px" }}>
              <Link
                className="em-foot-link"
                href={`${base}&v=down`}
                style={socialLink}
              >
                No
              </Link>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Footer — cream band: feedback widget, wordmark, socials, copyright,
// address, SEBI, unsubscribe.
// ---------------------------------------------------------------------------

function Sep() {
  return (
    <span className="em-foot-dim" style={sepStyle}>
      ·
    </span>
  );
}

export function EmailFooter({
  unsubscribeUrl,
  hideUnsubscribe = false,
  showSocials = false,
  feedbackTemplate,
  appUrl = WEB_APP_URL,
}: {
  unsubscribeUrl?: string;
  hideUnsubscribe?: boolean;
  showSocials?: boolean;
  feedbackTemplate?: string;
  appUrl?: string;
}) {
  const year = new Date().getFullYear();
  return (
    <Section className="em-foot" style={footerBand}>
      {EMAIL_FEEDBACK_WIDGET_ENABLED && feedbackTemplate ? (
        <WasThisUseful template={feedbackTemplate} appUrl={appUrl} />
      ) : null}

      {/* Logo + wordmark on ONE centered line (matches the header). */}
      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={0}
        align="center"
        style={{ margin: "0 auto 4px" }}
      >
        <tbody>
          <tr>
            <td style={{ verticalAlign: "middle", paddingRight: "9px" }}>
              <Img
                src={LOGO_URL}
                width="28"
                height="28"
                alt="UseMoney AI"
                style={{ display: "block", borderRadius: "7px", border: 0 }}
              />
            </td>
            <td style={{ verticalAlign: "middle" }}>
              <Text
                className="em-foot-ink"
                style={{ ...footerWordmark, margin: 0 }}
              >
                UseMoney
                <span style={footerAi}> AI</span>
              </Text>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Tagline, positioning line, socials, and the Ask-AI row mirror the web
          footer (PlayfulFooter). All gated on showSocials so security / internal
          emails (hideSocials) stay minimal: logo + wordmark + disclaimer. */}
      {showSocials ? (
        <>
          <Text className="em-foot-ink" style={footerTagline}>
            Use money. <span style={footerTaglineSerif}>Intelligently.</span>
          </Text>
          <SocialLinks />
          <AskAiRow />
        </>
      ) : null}

      <Hr className="em-foot-rule" style={footerHr} />

      <Text className="em-foot-dim" style={footerText}>
        © {year} UseMoney<span style={footerAi}> AI</span>
        <Sep />
        <Link className="em-foot-link" href={appUrl} style={footerLink}>
          usemoney.ai
        </Link>
      </Text>
      {COMPANY_ADDRESS ? (
        <Text className="em-foot-dim" style={footerText}>
          {COMPANY_ADDRESS}
        </Text>
      ) : null}
      <Text className="em-foot-dim" style={footerDisclaimer}>
        {SEBI_DISCLAIMER}
      </Text>
      {!hideUnsubscribe && unsubscribeUrl ? (
        <Text className="em-foot-dim" style={footerText}>
          <Link
            className="em-foot-link"
            href={unsubscribeUrl}
            style={footerLink}
          >
            Unsubscribe
          </Link>
          <Sep />
          <Link
            className="em-foot-link"
            href={`${WEB_APP_URL}/settings`}
            style={footerLink}
          >
            Manage preferences
          </Link>
        </Text>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headingStyle: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "25px",
  fontWeight: 700,
  letterSpacing: "-0.4px",
  lineHeight: "1.2",
  color: "#1d1d1b",
  margin: "0 0 14px",
};

const subheadingStyle: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "18px",
  fontWeight: 700,
  letterSpacing: "-0.2px",
  color: "#1d1d1b",
  margin: "20px 0 10px",
};

const textStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "15px",
  lineHeight: "24px",
  color: "#3a3a35",
  margin: "0 0 12px",
};

const mutedTextStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "13px",
  lineHeight: "20px",
  color: "#6b6b62",
  margin: "0 0 10px",
};

const listItemStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "15px",
  lineHeight: "24px",
  color: "#3a3a35",
  margin: "0 0 6px",
};

const bulletStyle: React.CSSProperties = {
  color: "#0f7a34",
  fontWeight: 700,
  marginRight: "9px",
};

const eyebrowStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
  color: "#0f7a34",
  margin: "0 0 8px",
};

const eyebrowDot: React.CSSProperties = {
  display: "inline-block",
  verticalAlign: "middle",
  marginRight: "7px",
  fontSize: "8px",
  lineHeight: "1",
  color: "#16a34a",
};

const buttonStyle: React.CSSProperties = {
  backgroundColor: "#16a34a",
  color: "#ffffff",
  border: "1.5px solid #14140e",
  borderRadius: "8px",
  fontFamily: fonts.body,
  fontSize: "14px",
  fontWeight: 700,
  textDecoration: "none",
  textAlign: "center" as const,
  display: "inline-block",
  padding: "12px 22px",
  boxShadow: "3px 3px 0 #14140e",
};

const calloutStyle: React.CSSProperties = {
  backgroundColor: "#efe7d0",
  borderLeft: "3px solid #16a34a",
  borderRadius: "8px",
  padding: "12px 14px",
  margin: "16px 0",
};

const bandStyle: React.CSSProperties = {
  backgroundColor: "#1d1d1b",
  color: "#f4ede0",
  borderRadius: "10px",
  padding: "14px 12px",
  margin: "18px 0",
};

const bandLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
  color: "rgba(244,237,224,0.55)",
  margin: "0 0 2px",
};

const bandValue: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: "18px",
  fontWeight: 700,
  color: "#f4ede0",
  margin: 0,
};

const askLink: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "14px",
  fontWeight: 700,
  color: "#0f7a34",
  textDecoration: "none",
};

const askDisclaimer: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "11px",
  lineHeight: "16px",
  color: "#6b6b62",
  margin: "10px 0 0",
};

// Footer band (pinned dark)
const footerBand: React.CSSProperties = {
  backgroundColor: "#efe7d0",
  borderTop: "1px solid rgba(29,29,27,0.10)",
  padding: "26px 28px 28px",
  borderRadius: "0 0 13px 13px",
  textAlign: "center" as const,
};

const footerLogo: React.CSSProperties = {
  display: "inline-block",
  borderRadius: "9px",
  marginBottom: "10px",
};

const footerAi: React.CSSProperties = {
  color: "#16a34a",
};

const footerWordmark: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "16px",
  fontWeight: 700,
  letterSpacing: "-0.2px",
  color: "#1d1d1b",
  margin: "0 0 12px",
};

// Tagline — "Use money. Intelligently." Muted-ink in light (inline color wins);
// the em-foot-ink class flips it to cream in dark via the !important @media
// override in EMAIL_GLOBAL_CSS. The serif span italicises "Intelligently."
const footerTagline: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "18px",
  fontWeight: 600,
  letterSpacing: "-0.3px",
  lineHeight: "1.25",
  color: "#3a3a35",
  margin: "0 0 6px",
};

const footerTaglineSerif: React.CSSProperties = {
  fontFamily: fonts.serif,
  fontStyle: "italic",
  fontWeight: 400,
};

const footerSubhead: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "12px",
  lineHeight: "18px",
  color: "#6b6b62",
  maxWidth: "330px",
  margin: "0 auto 18px",
};

// Ask-AI cluster
const askAiSection: React.CSSProperties = {
  margin: "0 0 4px",
  textAlign: "center" as const,
};

const askAiLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "1px",
  textTransform: "uppercase",
  margin: "0 0 10px",
};

// A fixed-light rounded "chip" (~32px) around each 20px brand mark — light in
// BOTH modes so the baked-dark marks stay legible on the dark footer band.
const askAiCell: React.CSSProperties = {
  backgroundColor: "#f7f3e6",
  border: "1px solid rgba(29,29,27,0.16)",
  borderRadius: "8px",
  padding: "6px",
  textAlign: "center" as const,
  verticalAlign: "middle" as const,
};

const feedbackBox: React.CSSProperties = {
  border: "1px solid rgba(29,29,27,0.14)",
  borderRadius: "12px",
  padding: "16px 14px",
  margin: "0 0 24px",
  textAlign: "center" as const,
};

const feedbackTitle: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "15px",
  fontWeight: 700,
  color: "#1d1d1b",
  margin: "0 0 12px",
};

const footerHr: React.CSSProperties = {
  borderColor: "rgba(29,29,27,0.12)",
  margin: "18px 0 14px",
};

const footerText: React.CSSProperties = {
  fontFamily: fonts.body,
  color: "#6b6b62",
  fontSize: "12px",
  lineHeight: "18px",
  margin: "4px 0",
};

const footerDisclaimer: React.CSSProperties = {
  fontFamily: fonts.body,
  color: "#6b6b62",
  fontSize: "11px",
  lineHeight: "16px",
  margin: "10px 0",
};

const footerLink: React.CSSProperties = {
  color: "#0f7a34",
  textDecoration: "underline",
};

const socialLink: React.CSSProperties = {
  color: "#0f7a34",
  textDecoration: "none",
  fontFamily: fonts.mono,
  fontSize: "12px",
  fontWeight: 600,
};

const sepStyle: React.CSSProperties = {
  padding: "0 7px",
  verticalAlign: "middle",
  opacity: 0.55,
};
