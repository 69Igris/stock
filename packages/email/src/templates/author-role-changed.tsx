import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface AuthorRoleChangedEmailProps {
  name: string;
  newRole: string;
}

export function AuthorRoleChangedEmail({
  name,
  newRole,
}: AuthorRoleChangedEmailProps) {
  return (
    <EmailLayout
      preview={`Your CMS role has been updated to ${newRole}`}
      hideSocials
    >
      <EHeading>Role Updated</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Your role in the UseMoney Content CMS has been updated to{" "}
        <strong>{newRole}</strong>.
      </EText>
      <EText>
        This change affects what actions you can perform in the CMS.
      </EText>
      <EButton href="https://cms.usemoney.ai">Go to CMS</EButton>
    </EmailLayout>
  );
}
