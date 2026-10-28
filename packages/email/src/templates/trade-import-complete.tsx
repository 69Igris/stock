import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EStatStrip, EText } from "../components";

interface TradeImportCompleteEmailProps {
  name: string;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  unsubscribeUrl?: string;
}

export function TradeImportCompleteEmail({
  name,
  importedCount,
  skippedCount,
  duplicateCount,
  unsubscribeUrl,
}: TradeImportCompleteEmailProps) {
  return (
    <EmailLayout
      preview={`Trade import complete - ${importedCount} trades imported`}
      unsubscribeUrl={unsubscribeUrl}
      feedback="trade-import-complete"
    >
      <EHeading>Trade Import Complete</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your trade import has been completed. Here&apos;s a summary:
      </EText>
      <EStatStrip
        items={[
          { label: "Imported", value: importedCount },
          { label: "Skipped", value: skippedCount },
          { label: "Duplicates", value: duplicateCount },
        ]}
      />
      <EButton href="https://usemoney.ai/tradebook">View Trade Book</EButton>
    </EmailLayout>
  );
}
