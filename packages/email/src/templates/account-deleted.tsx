import * as React from "react";
import { EmailLayout } from "./layout";
import { EHeading, EText } from "../components";

interface AccountDeletedEmailProps {
  name: string;
}

export function AccountDeletedEmail({ name }: AccountDeletedEmailProps) {
  return (
    <EmailLayout preview="Your UseMoney account has been deleted" hideSocials>
      <EHeading>Account Deleted</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your UseMoney account has been permanently deleted as requested. All
        broker connections, holdings, paper trades, FIRE scenarios, chat
        history, and encrypted credentials have been removed.
      </EText>
      <EText>
        Any active subscription has been cancelled, so you won&apos;t be billed
        again.
      </EText>
      <EText>
        Account deletion is permanent — there is no recovery. If you want to use
        UseMoney again, you&apos;re welcome to sign up with a fresh account
        anytime at usemoney.ai.
      </EText>
      <EText>
        Thank you for using UseMoney. If anything went wrong, write to
        support@usemoney.ai and we&apos;ll help.
      </EText>
    </EmailLayout>
  );
}
