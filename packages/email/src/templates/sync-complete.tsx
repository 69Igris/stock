import * as React from "react";
import { EmailLayout } from "./layout";
import {
  AskAiCta,
  EButton,
  ECallout,
  EHeading,
  EStatStrip,
  EText,
} from "../components";

interface SyncCompleteEmailProps {
  name: string;
  brokerName: string;
  holdingsCount: number;
  positionsCount: number;
  tradesCount: number;
  mutualFundsCount?: number;
  /**
   * MONEY-837: true when the MF fetch FAILED (e.g. the broker's MF-holdings
   * endpoint wasn't authorised for this token), so we don't show a misleading
   * "Mutual Funds: 0" that's indistinguishable from a genuinely empty account.
   */
  mutualFundsError?: boolean;
  /** MONEY-837: which broker ACCOUNT synced (the user can have several). */
  brokerUserId?: string;
  accountName?: string;
  /**
   * MONEY-839: true for the CONNECT-time email — only the DAY'S trades are in
   * yet; the full historical tradebook is still backfilling on the worker.
   */
  historicalPending?: boolean;
  unsubscribeUrl?: string;
}

export function SyncCompleteEmail({
  name,
  brokerName,
  holdingsCount,
  positionsCount,
  tradesCount,
  mutualFundsCount = 0,
  mutualFundsError = false,
  brokerUserId,
  accountName,
  historicalPending = false,
  unsubscribeUrl,
}: SyncCompleteEmailProps) {
  const stats = [
    { label: "Holdings", value: holdingsCount },
    { label: "Positions", value: positionsCount },
    {
      label: historicalPending ? "Day's trades" : "Trades",
      value: tradesCount,
    },
    {
      label: "Mutual funds",
      value: mutualFundsError ? "—" : mutualFundsCount,
    },
  ];

  return (
    <EmailLayout
      preview={`${brokerName} sync complete — ${holdingsCount} holdings, ${tradesCount} trades`}
      unsubscribeUrl={unsubscribeUrl}
      feedback="sync-complete"
    >
      <EHeading>Sync complete</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your <strong>{brokerName}</strong> data has been synced successfully.
        Here&apos;s the summary:
      </EText>
      {brokerUserId ? (
        <EText muted>
          Account: {accountName || brokerName} · {brokerUserId}
        </EText>
      ) : null}
      <EStatStrip items={stats} />
      {mutualFundsError ? (
        <EText muted>
          Mutual funds weren&apos;t synced — re-authorise the broker to enable
          mutual-fund sync.
        </EText>
      ) : null}
      {historicalPending ? (
        <ECallout>
          <EText muted style={{ margin: 0 }}>
            Your full <strong>historical trade history</strong> is importing in
            the background — this can take a few minutes. We&apos;ll email you
            as soon as it&apos;s done.
          </EText>
        </ECallout>
      ) : null}
      <EButton href="https://usemoney.ai/dashboard">View dashboard</EButton>
      <AskAiCta prompt="How is my portfolio doing after the latest sync?" />
    </EmailLayout>
  );
}
