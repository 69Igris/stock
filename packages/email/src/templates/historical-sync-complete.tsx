import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EStatStrip, EText } from "../components";

/**
 * MONEY-839: sent once the CONNECT-time historical tradebook backfill finishes on
 * the worker (the slow Console/backoffice import that runs after the day's sync).
 * The connect email promised "we'll email you when it's done" — this is that.
 *
 * MONEY-848: also sent when the backfill found NO history (`tradesCount === 0`) —
 * a fresh / cash-only account is connected and fully synced, just with nothing to
 * import. The empty case is reworded to "connected and synced" rather than a
 * confusing "0 historical trades", so the connect promise is still kept.
 */
interface HistoricalSyncCompleteEmailProps {
  name: string;
  brokerName: string;
  tradesCount: number;
  /** Which broker ACCOUNT (the user can have several). */
  brokerUserId?: string;
  accountName?: string;
  unsubscribeUrl?: string;
}

export function HistoricalSyncCompleteEmail({
  name,
  brokerName,
  tradesCount,
  brokerUserId,
  accountName,
  unsubscribeUrl,
}: HistoricalSyncCompleteEmailProps) {
  const isEmpty = tradesCount <= 0;
  return (
    <EmailLayout
      preview={
        isEmpty
          ? `${brokerName} connected and synced`
          : `${brokerName} historical import complete - ${tradesCount} trades`
      }
      unsubscribeUrl={unsubscribeUrl}
      feedback="historical-sync-complete"
    >
      <EHeading>
        {isEmpty ? "Connected & Synced" : "Historical Import Complete"}
      </EHeading>
      <EText>Hi {name},</EText>
      {isEmpty ? (
        <EText>
          Your <strong>{brokerName}</strong> account is connected and fully
          synced. We didn&apos;t find any past trade history to import — once
          you start trading, new activity will sync automatically.
        </EText>
      ) : (
        <EText>
          Your full <strong>{brokerName}</strong> trade history has finished
          importing. We brought in{" "}
          <strong>
            {tradesCount} historical trade{tradesCount === 1 ? "" : "s"}
          </strong>{" "}
          — your tradebook and realised-P&amp;L pairing are now complete.
        </EText>
      )}
      {brokerUserId ? (
        <EText muted>
          Account: {accountName || brokerName} · {brokerUserId}
        </EText>
      ) : null}
      {!isEmpty ? (
        <EStatStrip
          items={[{ label: "Trades imported", value: tradesCount }]}
        />
      ) : null}
      <EButton href="https://usemoney.ai/tradebook">View Tradebook</EButton>
    </EmailLayout>
  );
}
