import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EEyebrow, EHeading, EListItem, EText } from "../components";

interface WelcomeEmailProps {
  name: string;
}

export function WelcomeEmail({ name }: WelcomeEmailProps) {
  return (
    <EmailLayout preview={`Welcome to UseMoney, ${name}!`} feedback="welcome">
      <EEyebrow>Welcome aboard</EEyebrow>
      <EHeading>Welcome to UseMoney!</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Thanks for joining UseMoney! We&apos;re excited to help you track and
        manage your trading portfolio across all your brokers — in one place.
      </EText>
      <EText>Here&apos;s how to get started:</EText>
      <EListItem>Connect your first broker from the Brokers page</EListItem>
      <EListItem>
        Your holdings, positions, and trades sync automatically
      </EListItem>
      <EListItem>Explore your dashboard for portfolio insights</EListItem>
      <EButton href="https://usemoney.ai/brokers">
        Connect your first broker
      </EButton>
      <EText>
        Want the full picture? Beyond tracking, UseMoney adds AI portfolio chat,
        paper trading, risk analysis, and FIRE planning — take a quick
        walkthrough of what you can do and how each feature works.
      </EText>
      <EButton href="https://usemoney.ai/features">
        See how UseMoney works
      </EButton>
      <EText muted>
        Your security comes first — broker credentials are encrypted with
        AES-256 and every connection is strictly read-only, so UseMoney can
        never place a trade or move your money.
      </EText>
      <EText>
        Have questions? Just reply to this email — we read every one.
      </EText>
      <EText>
        Happy investing,
        <br />
        The UseMoney Team
      </EText>
    </EmailLayout>
  );
}
