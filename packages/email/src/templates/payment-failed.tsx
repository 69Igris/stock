import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, ECallout, EHeading, EText } from "../components";

interface PaymentFailedEmailProps {
  name: string;
  planName: string;
  errorMessage?: string;
  unsubscribeUrl?: string;
}

export function PaymentFailedEmail({
  name,
  planName,
  errorMessage,
  unsubscribeUrl,
}: PaymentFailedEmailProps) {
  return (
    <EmailLayout
      preview={`Payment failed for ${planName} plan`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <EHeading>Payment Failed</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        We were unable to process your payment for the{" "}
        <strong>{planName}</strong> plan.
      </EText>
      {errorMessage && (
        <ECallout>
          <EText muted style={{ margin: 0 }}>
            <strong>Reason:</strong> {errorMessage}
          </EText>
        </ECallout>
      )}
      <EText>
        Please check your payment method and try again. If the issue persists,
        contact your bank or try a different payment method.
      </EText>
      <EButton href="https://usemoney.ai/settings">Retry Payment</EButton>
      <EText>Need help? Reply to this email and we&apos;ll assist you.</EText>
    </EmailLayout>
  );
}
