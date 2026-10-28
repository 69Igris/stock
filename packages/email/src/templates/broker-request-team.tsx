import * as React from "react";
import { EmailLayout } from "./layout";
import { EHeading, EText } from "../components";

/**
 * Team-facing notification when a visitor submits the "Request a broker" form
 * on /integrations. Goes to founder@usemoney.ai (the EMAIL_REPLY_TO default)
 * so a single reply to this email reaches the requester.
 *
 * Kept intentionally tabular: easy to scan at a glance, easy to dump into a
 * Linear ticket if the broker request justifies one.
 */

interface BrokerRequestTeamEmailProps {
  email: string;
  brokerName: string;
  receivedAt: string; // ISO timestamp
  ip?: string | null;
  userAgent?: string | null;
}

export function BrokerRequestTeamEmail({
  email,
  brokerName,
  receivedAt,
  ip,
  userAgent,
}: BrokerRequestTeamEmailProps) {
  return (
    <EmailLayout
      preview={`Broker request: ${brokerName} (from ${email})`}
      hideSocials
    >
      <EHeading>New broker request</EHeading>
      <EText>
        A visitor on <strong>/integrations</strong> asked us to prioritise a
        broker integration. Reply to this email to reach them directly — the
        Reply-To header is set to their address.
      </EText>

      <EText muted style={{ margin: "0 0 2px" }}>
        Broker
      </EText>
      <EText style={{ margin: "0 0 12px" }}>{brokerName}</EText>

      <EText muted style={{ margin: "0 0 2px" }}>
        Requester
      </EText>
      <EText style={{ margin: "0 0 12px" }}>{email}</EText>

      <EText muted style={{ margin: "0 0 2px" }}>
        Received
      </EText>
      <EText style={{ margin: "0 0 12px" }}>{receivedAt}</EText>

      {ip ? (
        <>
          <EText muted style={{ margin: "0 0 2px" }}>
            IP
          </EText>
          <EText style={{ margin: "0 0 12px" }}>{ip}</EText>
        </>
      ) : null}

      {userAgent ? (
        <>
          <EText muted style={{ margin: "0 0 2px" }}>
            User Agent
          </EText>
          <EText style={{ margin: "0 0 12px" }}>{userAgent}</EText>
        </>
      ) : null}

      <EText>
        This visitor was also added to the newsletter audience so they receive
        the weekly long-read and the eventual &ldquo;{brokerName} is live&rdquo;
        announcement.
      </EText>
    </EmailLayout>
  );
}
