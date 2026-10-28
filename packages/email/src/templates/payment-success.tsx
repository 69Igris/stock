import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface PaymentSuccessEmailProps {
  name: string;
  planName: string;
  amount: string;
  currency: string;
  unsubscribeUrl?: string;
}

export function PaymentSuccessEmail({
  name,
  planName,
  amount,
  currency,
  unsubscribeUrl,
}: PaymentSuccessEmailProps) {
  return (
    <EmailLayout
      preview={`Payment confirmed for ${planName} plan`}
      unsubscribeUrl={unsubscribeUrl}
      feedback="payment-success"
    >
      <EHeading>Payment confirmed</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your payment of{" "}
        <strong>
          {currency} {amount}
        </strong>{" "}
        for the <strong>{planName}</strong> plan has been processed
        successfully.
      </EText>
      <EText>
        Your subscription is now active — you can start using all {planName}{" "}
        features right away.
      </EText>
      <EButton href="https://usemoney.ai/dashboard">Go to dashboard</EButton>
      <EText>
        Questions about your subscription? Just reply to this email.
      </EText>
    </EmailLayout>
  );
}
