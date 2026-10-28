import {
  Body,
  Container,
  Html,
  Img,
  Link,
  Preview,
  Section,
} from "@react-email/components";
import * as React from "react";
import { LOGO_URL, WEB_APP_URL } from "../constants";
import { fonts, MAX_WIDTH, radius } from "../theme";
import { EmailFooter, EmailHead } from "../components";

interface EmailLayoutProps {
  preview: string;
  children: React.ReactNode;
  /** Unsubscribe URL (newsletter unsub, or per-category preference opt-out). */
  unsubscribeUrl?: string;
  /** Hide the unsubscribe link entirely (e.g. for security/account emails). */
  hideUnsubscribe?: boolean;
  /**
   * "system" (default) — compact transactional/account/notification emails.
   * "editorial" — newsletter/marketing; shows social links in the footer.
   */
  variant?: "system" | "editorial";
  /** Suppress social links — for security / OTP / account / internal emails. */
  hideSocials?: boolean;
  /**
   * When set (the email's template id), renders the "Was this email useful?"
   * widget in the footer, linking to /api/email/feedback?t=<id>. Omit for
   * security / negative emails (account-deleted, cancelled, OTP, failures).
   */
  feedback?: string;
}

export function EmailLayout({
  preview,
  children,
  unsubscribeUrl,
  hideUnsubscribe = false,
  variant = "system",
  hideSocials = false,
  feedback,
}: EmailLayoutProps) {
  return (
    <Html lang="en">
      <EmailHead />
      <Preview>{preview}</Preview>
      <Body className="em-body" style={body}>
        <Container className="em-card" style={container}>
          {/* Header */}
          <Section style={header}>
            <Link href={WEB_APP_URL} style={logoLink}>
              <Img
                src={LOGO_URL}
                width="32"
                height="32"
                alt="UseMoney AI"
                style={logoImage}
              />
              <span className="em-ink" style={logoText}>
                UseMoney
                <span className="em-ai" style={logoAi}>
                  {" "}
                  AI
                </span>
              </span>
            </Link>
          </Section>

          {/* Content */}
          <Section style={content}>{children}</Section>

          {/* Footer */}
          <EmailFooter
            unsubscribeUrl={unsubscribeUrl}
            hideUnsubscribe={hideUnsubscribe}
            showSocials={
              (variant === "editorial" || variant === "system") && !hideSocials
            }
            feedbackTemplate={feedback}
            appUrl={WEB_APP_URL}
          />
        </Container>
      </Body>
    </Html>
  );
}

const body: React.CSSProperties = {
  backgroundColor: "#f7f3e6",
  // The app's signature dotted texture on the area AROUND the card. Mail
  // clients that drop background-image just fall back to the flat cream.
  backgroundImage:
    "radial-gradient(rgba(29,29,27,0.06) 1px, transparent 1.5px)",
  backgroundSize: "16px 16px",
  fontFamily: fonts.body,
  margin: 0,
  padding: "24px 0 48px",
};

const container: React.CSSProperties = {
  backgroundColor: "#fbf8eb",
  border: "1px solid rgba(29,29,27,0.12)",
  borderRadius: radius.card,
  // Clip the footer band to the rounded card.
  overflow: "hidden",
  margin: "0 auto",
  padding: 0,
  maxWidth: MAX_WIDTH,
};

const header: React.CSSProperties = {
  padding: "20px 28px 6px",
};

const logoLink: React.CSSProperties = {
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};

const logoImage: React.CSSProperties = {
  borderRadius: "8px",
  verticalAlign: "middle",
};

const logoText: React.CSSProperties = {
  fontFamily: fonts.display,
  fontSize: "20px",
  fontWeight: 700,
  letterSpacing: "-0.3px",
  color: "#1d1d1b",
  verticalAlign: "middle",
  // Email clients ignore flex `gap`, so space the wordmark off the logo here.
  marginLeft: "10px",
};

const logoAi: React.CSSProperties = {
  color: "#16a34a",
};

const content: React.CSSProperties = {
  padding: "8px 28px 22px",
};
