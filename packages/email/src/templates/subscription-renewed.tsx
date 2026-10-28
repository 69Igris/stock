import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface SubscriptionRenewedEmailProps {
  name: string;
  planName: string;
  unsubscribeUrl?: string;
}

export function SubscriptionRenewedEmail({
  name,
  planName,
  unsubscribeUrl,
}: SubscriptionRenewedEmailProps) {
  return (
    <EmailLayout
      preview={`Your ${planName} subscription has been renewed`}
      unsubscribeUrl={unsubscribeUrl}
      feedback="subscription-renewed"
    >
      <EHeading>Subscription Renewed</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your <strong>{planName}</strong> subscription has been successfully
        renewed. Your AI query limits have been reset for the new billing
        period.
      </EText>
      <EText>
        Continue enjoying all your premium features without interruption.
      </EText>
      <EButton href="https://usemoney.ai/dashboard">Go to Dashboard</EButton>
    </EmailLayout>
  );
}
