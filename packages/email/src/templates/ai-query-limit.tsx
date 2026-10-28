import * as React from "react";
import { EmailLayout } from "./layout";
import { EButton, EHeading, EText } from "../components";

interface AiQueryLimitEmailProps {
  name: string;
  planName: string;
  unsubscribeUrl?: string;
}

export function AiQueryLimitEmail({
  name,
  planName,
  unsubscribeUrl,
}: AiQueryLimitEmailProps) {
  return (
    <EmailLayout
      preview="You've reached your AI query limit"
      unsubscribeUrl={unsubscribeUrl}
      feedback="ai-query-limit"
    >
      <EHeading>AI Query Limit Reached</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        You&apos;ve used all your AI queries for the current billing period on
        your <strong>{planName}</strong> plan.
      </EText>
      <EText>
        Upgrade your plan or purchase an AI Query Pack to continue getting
        AI-powered portfolio insights.
      </EText>
      <EButton href="https://usemoney.ai/settings">Upgrade Plan</EButton>
    </EmailLayout>
  );
}
