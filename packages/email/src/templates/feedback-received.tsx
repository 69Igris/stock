import * as React from "react";
import { EmailLayout } from "./layout";
import { ECallout, EEyebrow, EHeading, EText } from "../components";

interface FeedbackReceivedEmailProps {
  name: string;
  feedbackTitle: string;
  feedbackType: string;
  feedbackDescription: string;
}

const TYPE_LABELS: Record<string, string> = {
  BUG: "Bug Report",
  FEATURE_REQUEST: "Feature Request",
  IMPROVEMENT: "Improvement Suggestion",
  QUESTION: "Question",
  OTHER: "Feedback",
};

export function FeedbackReceivedEmail({
  name,
  feedbackTitle,
  feedbackType,
  feedbackDescription,
}: FeedbackReceivedEmailProps) {
  const typeLabel = TYPE_LABELS[feedbackType] || "Feedback";

  return (
    <EmailLayout preview={`${typeLabel} received: ${feedbackTitle}`}>
      <EHeading>{typeLabel} Received</EHeading>
      <EText>Hi {name},</EText>
      <EText>
        Thank you for submitting your {typeLabel.toLowerCase()}. Our team will
        review it and update the status.
      </EText>

      <ECallout>
        <EEyebrow>Title</EEyebrow>
        <EText style={{ margin: "0 0 12px" }}>{feedbackTitle}</EText>
        <EEyebrow>Type</EEyebrow>
        <EText style={{ margin: "0 0 12px" }}>{typeLabel}</EText>
        <EEyebrow>Description</EEyebrow>
        <EText style={{ margin: 0 }}>{feedbackDescription}</EText>
      </ECallout>

      <EText>
        You can track the status of your submission in{" "}
        <strong>Settings &gt; Feedback</strong>.
      </EText>
      <EText>
        If you have any additional details to add, simply reply to this email.
      </EText>
      <EText>- The UseMoney Team</EText>
    </EmailLayout>
  );
}
