import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EEyebrow, EHeading, EText } from "../components";

interface NewsletterWelcomeEmailProps {
  unsubscribeUrl: string;
  /** Subscriber's first name, if captured at signup. */
  name?: string;
}

export function NewsletterWelcomeEmail({
  unsubscribeUrl,
  name,
}: NewsletterWelcomeEmailProps) {
  const greetingName = name?.trim();
  return (
    <EmailLayout
      preview="Welcome to the UseMoney newsletter!"
      unsubscribeUrl={unsubscribeUrl}
      variant="editorial"
      feedback="newsletter-welcome"
    >
      <EEyebrow>Subscribed</EEyebrow>
      <EHeading>
        You&apos;re in{greetingName ? `, ${greetingName}` : ""}.
      </EHeading>
      <EText>
        Welcome to the UseMoney newsletter! You&apos;ll get market insights,
        trading strategies, and portfolio-management tips delivered straight to
        your inbox.
      </EText>
      <EText>About one a week. No spam, ever.</EText>
      <EButton href="https://usemoney.ai/blog">Read our latest posts</EButton>
    </EmailLayout>
  );
}
