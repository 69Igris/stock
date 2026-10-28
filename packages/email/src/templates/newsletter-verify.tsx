import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface NewsletterVerifyEmailProps {
  verifyUrl: string;
  /** Subscriber's first name, if captured at signup. */
  name?: string;
}

export function NewsletterVerifyEmail({
  verifyUrl,
  name,
}: NewsletterVerifyEmailProps) {
  const greetingName = name?.trim() || "there";
  return (
    <EmailLayout preview="Verify your email to subscribe to the UseMoney newsletter">
      <EHeading>Verify your email</EHeading>
      <EText>
        Hi {greetingName}, thanks for subscribing to the UseMoney newsletter!
        Please confirm your email address by clicking the button below.
      </EText>
      <EButton href={verifyUrl}>Verify email</EButton>
      <EText muted>
        If you didn&apos;t subscribe, you can safely ignore this email.
      </EText>
      <EText muted>This link will expire in 24 hours.</EText>
    </EmailLayout>
  );
}
