import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface BrokerDisconnectedEmailProps {
  name: string;
  brokerName: string;
  unsubscribeUrl?: string;
}

export function BrokerDisconnectedEmail({
  name,
  brokerName,
  unsubscribeUrl,
}: BrokerDisconnectedEmailProps) {
  return (
    <EmailLayout
      preview={`${brokerName} broker disconnected`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <EHeading>Broker Disconnected</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your <strong>{brokerName}</strong> broker account has been disconnected.
        Your previously synced data is still available, but no new data will be
        fetched until you reconnect.
      </EText>
      <EText>
        To resume syncing, reconnect your broker from the Brokers page.
      </EText>
      <EButton href="https://usemoney.ai/brokers">Reconnect Broker</EButton>
    </EmailLayout>
  );
}
