import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface SubscriptionCancelledEmailProps {
  name: string;
  planName: string;
  unsubscribeUrl?: string;
}

export function SubscriptionCancelledEmail({
  name,
  planName,
  unsubscribeUrl,
}: SubscriptionCancelledEmailProps) {
  return (
    <EmailLayout
      preview={`Your ${planName} subscription has been cancelled`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <EHeading>Subscription Cancelled</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your <strong>{planName}</strong> subscription has been cancelled as
        requested.
      </EText>
      <EText>
        Your data is safe and will be retained. You can continue using free
        features, and you can resubscribe at any time to regain access to
        premium features.
      </EText>
      <EButton href="https://usemoney.ai/settings">Resubscribe</EButton>
      <EText>
        We&apos;d love to hear why you cancelled. Reply to this email with any
        feedback.
      </EText>
    </EmailLayout>
  );
}
