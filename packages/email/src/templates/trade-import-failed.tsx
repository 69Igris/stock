import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, ECallout, EHeading, EText } from "../components";

interface TradeImportFailedEmailProps {
  name: string;
  errorMessage: string;
  unsubscribeUrl?: string;
}

export function TradeImportFailedEmail({
  name,
  errorMessage,
  unsubscribeUrl,
}: TradeImportFailedEmailProps) {
  return (
    <EmailLayout preview="Trade import failed" unsubscribeUrl={unsubscribeUrl}>
      <EHeading>Trade Import Failed</EHeading>
      <EText>Hi {name},</EText>
      <EText>Unfortunately, your trade import could not be completed.</EText>
      <ECallout>
        <EText muted style={{ margin: 0 }}>
          <strong>Error:</strong> {errorMessage}
        </EText>
      </ECallout>
      <EText>
        Please check your file format and try again. Make sure the file matches
        one of our supported broker formats (Zerodha, Upstox, Angel One, Groww)
        or the generic CSV format.
      </EText>
      <EButton href="https://usemoney.ai/tradebook">Try Again</EButton>
    </EmailLayout>
  );
}
