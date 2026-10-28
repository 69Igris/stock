import * as React from "react";
import { EmailLayout } from "./layout";
import { AskAiCta, EButton, EHeading, EText } from "../components";

interface BrokerConnectedEmailProps {
  name: string;
  brokerName: string;
  /** MONEY-837: which broker ACCOUNT (the user can have several). */
  brokerUserId?: string;
  accountName?: string;
  /** True when re-authorising an existing connection, not a new connect. */
  isReauth?: boolean;
  unsubscribeUrl?: string;
}

export function BrokerConnectedEmail({
  name,
  brokerName,
  brokerUserId,
  accountName,
  isReauth = false,
  unsubscribeUrl,
}: BrokerConnectedEmailProps) {
  return (
    <EmailLayout
      preview={
        isReauth
          ? `${brokerName} re-authorised successfully`
          : `${brokerName} broker connected successfully`
      }
      unsubscribeUrl={unsubscribeUrl}
      feedback="broker-connected"
    >
      <EHeading>
        {isReauth ? "Broker re-authorised" : "Broker connected"}
      </EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your <strong>{brokerName}</strong>{" "}
        {isReauth
          ? "account has been re-authorised successfully — syncing has resumed."
          : "broker account is connected. Your holdings, positions, and trades will begin syncing shortly."}
      </EText>
      {brokerUserId ? (
        <EText muted>
          Account: {accountName || brokerName} · {brokerUserId}
        </EText>
      ) : null}
      <EText>
        You can trigger a manual sync anytime from the Brokers page.
      </EText>
      <EButton href="https://usemoney.ai/brokers">View brokers</EButton>
      <AskAiCta prompt="Give me a quick health check of my portfolio." />
    </EmailLayout>
  );
}
