import { Hr, Img, Markdown, Section, Text } from "@react-email/components";
import * as React from "react";
import { EmailLayout } from "./layout";
import { AskAiCta, EButton, EHeading, EText } from "../components";
import { fonts } from "../theme";

interface NewsletterIssueEmailProps {
  title: string;
  excerpt: string;
  /**
   * Greeting name. BROADCASTS pass the Resend merge tag
   * `{{{contact.first_name|there}}}` (substituted per-contact at send time);
   * INDIVIDUAL sends (resend.emails.send, which does NOT substitute merge tags)
   * pass the recipient's real first name. Defaults to "there".
   */
  firstName?: string;
  postUrl: string;
  /**
   * Raw post slug (NOT the full URL). Powers the deterministic
   * `summarize_post` deep-link in the Ask-AI CTA — the chat reads the post from
   * the DB by slug, so it works for fresh/unlisted posts. When absent, the CTA
   * falls back to the free-text prompt path.
   */
  slug?: string;
  unsubscribeUrl: string;
  /** Feature image URL */
  featureImage?: string | null;
  /** Full post content as email-safe HTML (from blocknoteToEmailHtml) */
  contentHtml?: string;
  /** Author name */
  authorName?: string;
  /** Author avatar URL */
  authorImageUrl?: string;
  /** Publish date ISO string */
  publishDate?: string;
  /** Hide the unsubscribe link (for security emails) */
  hideUnsubscribe?: boolean;
}

export function NewsletterIssueEmail({
  title,
  excerpt,
  firstName,
  postUrl,
  slug,
  unsubscribeUrl,
  featureImage,
  contentHtml,
  authorName,
  authorImageUrl,
  publishDate,
  hideUnsubscribe = false,
}: NewsletterIssueEmailProps) {
  const formattedDate = publishDate
    ? new Date(publishDate).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <EmailLayout
      preview={title}
      unsubscribeUrl={unsubscribeUrl}
      hideUnsubscribe={hideUnsubscribe}
      variant="editorial"
      feedback="newsletter-issue"
    >
      {/* Personalized greeting. Broadcasts pass the merge tag (substituted by
          Resend per-contact); individual sends pass the real first name; both
          fall back to "there". */}
      <EText style={{ margin: "0 0 18px" }}>Hi {firstName || "there"},</EText>

      {/* Feature Image */}
      {featureImage && (
        <Section style={{ marginBottom: "20px" }}>
          <Img
            src={featureImage}
            alt={title}
            width="544"
            style={featureImageStyle}
          />
        </Section>
      )}

      {/* Title */}
      <EHeading style={{ fontSize: "28px", lineHeight: "1.2" }}>
        {title}
      </EHeading>

      {/* Author & Date */}
      {(authorName || formattedDate) && (
        <table cellPadding="0" cellSpacing="0" style={{ margin: "0 0 16px" }}>
          <tr>
            {authorImageUrl && (
              <td style={{ verticalAlign: "middle", paddingRight: "10px" }}>
                <Img
                  src={authorImageUrl}
                  alt={authorName || ""}
                  width="32"
                  height="32"
                  style={{ borderRadius: "50%" }}
                />
              </td>
            )}
            <td style={{ verticalAlign: "middle" }}>
              {authorName && (
                <Text className="em-ink-2" style={authorText}>
                  {authorName}
                </Text>
              )}
              {formattedDate && (
                <Text className="em-ink-3" style={dateText}>
                  {formattedDate}
                </Text>
              )}
            </td>
          </tr>
        </table>
      )}

      {/* Excerpt (when there's no full content) */}
      {!contentHtml && excerpt && (
        <>
          <Text className="em-ink-2" style={excerptStyle}>
            {excerpt}
          </Text>
          <Hr className="em-rule" style={hr} />
        </>
      )}

      {/* Full content — rendered from blocknoteToEmailHtml. Colors are left to
          inherit from the wrapping .em-ink-2 so they flip in dark mode (the
          Markdown component inlines its own styles, which classes can't reach). */}
      {contentHtml && (
        <Section className="em-ink-2" style={{ color: "#3a3a35" }}>
          <Markdown
            markdownCustomStyles={{
              p: {
                margin: "16px 0",
                lineHeight: "1.7",
                fontSize: "16px",
                fontFamily: fonts.body,
                color: "#3a3a35",
              },
              h1: {
                fontSize: "24px",
                marginBottom: "16px",
                marginTop: "32px",
                fontFamily: fonts.display,
                fontWeight: 700,
                color: "#1d1d1b",
              },
              h2: {
                fontSize: "20px",
                marginBottom: "14px",
                marginTop: "28px",
                fontFamily: fonts.display,
                fontWeight: 700,
                color: "#1d1d1b",
              },
              h3: {
                fontSize: "18px",
                marginBottom: "12px",
                marginTop: "24px",
                fontFamily: fonts.display,
                fontWeight: 700,
                color: "#1d1d1b",
              },
              ul: {
                marginLeft: "20px",
                marginBottom: "16px",
                fontFamily: fonts.body,
                color: "#3a3a35",
              },
              ol: {
                marginLeft: "20px",
                marginBottom: "16px",
                fontFamily: fonts.body,
                color: "#3a3a35",
              },
              li: {
                margin: "8px 0",
                lineHeight: "1.7",
                fontFamily: fonts.body,
                color: "#3a3a35",
              },
              blockQuote: {
                fontFamily: fonts.body,
                color: "#3a3a35",
              },
              link: { color: "#0f7a34" },
            }}
          >
            {contentHtml}
          </Markdown>
        </Section>
      )}

      <Hr className="em-rule" style={hr} />

      {/* Read Full Article Button */}
      <EButton href={postUrl}>
        {contentHtml ? "View on website" : "Read full article"}
      </EButton>

      {/* MONEY-887: deterministic dispatch. The CTA fires the `summarize_post`
          tool BY SLUG — the chat reads the post from the DB and summarises it +
          relates it to UseMoney, bypassing the classifier (a free-text
          "summarise … my portfolio" prompt collapsed to a generic portfolio
          dump, and web-search can't read a fresh/unlisted post). Falls back to
          the prompt path only if the slug is somehow missing. */}
      <AskAiCta
        prompt="Summarise this newsletter and why it matters for investing on UseMoney."
        ctaLabel="Discuss with UseMoney AI"
        tool={slug ? "summarize_post" : undefined}
        toolParams={slug ? { slug } : undefined}
        userText="Summarise this newsletter and why it matters for investing on UseMoney."
      />
    </EmailLayout>
  );
}

const featureImageStyle: React.CSSProperties = {
  maxWidth: "100%",
  height: "auto",
  borderRadius: "10px",
};

const authorText: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "14px",
  fontWeight: 600,
  margin: 0,
  lineHeight: "18px",
};

const dateText: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: "12px",
  margin: 0,
  lineHeight: "16px",
};

const excerptStyle: React.CSSProperties = {
  fontFamily: fonts.body,
  fontSize: "16px",
  lineHeight: "26px",
  color: "#3a3a35",
  margin: "0 0 14px",
};

const hr: React.CSSProperties = {
  borderColor: "rgba(29,29,27,0.14)",
  margin: "18px 0",
};
