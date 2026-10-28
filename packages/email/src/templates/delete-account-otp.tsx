import { Text } from "@react-email/components";
import * as React from "react";
import { EmailLayout } from "./layout";
import { ECallout, EHeading, EText } from "../components";
import { fonts } from "../theme";

interface DeleteAccountOtpEmailProps {
  name: string;
  otp: string;
  expiresInMinutes: number;
}

/**
 * One-time 6-digit code emailed when a user requests account deletion.
 * Renders the code as a prominent monospace block + warning copy so a
 * misclick still requires copying a code from email.
 */
export function DeleteAccountOtpEmail({
  name,
  otp,
  expiresInMinutes,
}: DeleteAccountOtpEmailProps) {
  return (
    <EmailLayout preview="Your UseMoney account deletion code" hideSocials>
      <EHeading>Confirm account deletion</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        You requested to delete your UseMoney account. Use the code below to
        confirm. This action is permanent — your portfolio data, broker
        connections, paper trades, and chat history cannot be recovered.
      </EText>
      <ECallout>
        <Text
          className="em-ink"
          style={{
            fontFamily: fonts.mono,
            fontSize: "30px",
            fontWeight: 700,
            letterSpacing: "6px",
            textAlign: "center",
            margin: 0,
          }}
        >
          {otp}
        </Text>
      </ECallout>
      <EText muted>
        This code expires in {expiresInMinutes} minutes. If you didn&apos;t
        request this, ignore this email — your account stays safe.
      </EText>
      <EText muted>
        Questions? Reply to this email or write to support@usemoney.ai.
      </EText>
    </EmailLayout>
  );
}
