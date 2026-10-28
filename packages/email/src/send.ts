import { getResendClient } from "./client";
import { EMAIL_FROM, EMAIL_REPLY_TO } from "./constants";
import { buildListUnsubscribeHeaders } from "./theme";
import type {
  SendEmailOptions,
  SendResult,
  NewsletterSendOptions,
} from "./types";

/**
 * Send a single transactional email.
 * Fire-and-forget: logs errors but never throws.
 * Retries once on transient network failures (Resend DNS/connection errors).
 */
export async function sendEmail(
  options: SendEmailOptions,
): Promise<SendResult> {
  const maxAttempts = 2;

  // RFC 8058 one-click unsubscribe (+ any explicit headers). Only the HTTPS URL
  // is listed for one-click; we intentionally omit a mailto: so unsubscribes
  // don't land in the founder inbox as manual work.
  const headers: Record<string, string> = {
    ...(options.unsubscribeUrl
      ? buildListUnsubscribeHeaders(options.unsubscribeUrl)
      : {}),
    ...options.headers,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resend = getResendClient();
      const { data, error } = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: options.replyTo ?? EMAIL_REPLY_TO,
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        react: options.react,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
      });

      if (error) {
        // Resend returned an API error - retry on transient network errors
        const isTransient =
          error.message?.includes("could not be resolved") ||
          error.message?.includes("fetch") ||
          error.name === "application_error";

        if (isTransient && attempt < maxAttempts) {
          console.warn(
            `[Email] Transient error sending "${options.template}", retrying...`,
          );
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        console.error(`[Email] Failed to send "${options.template}":`, error);
        return { success: false, error: error.message };
      }

      return { success: true, resendId: data?.id };
    } catch (err) {
      if (attempt < maxAttempts) {
        console.warn(
          `[Email] Exception sending "${options.template}", retrying...`,
        );
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[Email] Error sending "${options.template}":`, message);
      return { success: false, error: message };
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

/**
 * Send batch emails using Resend's batch API.
 * Chunks into groups of 100, with 500ms delay between batches
 * to respect the 2 req/sec rate limit.
 */
export async function sendBatchEmails(
  emails: Array<{
    to: string;
    subject: string;
    react: React.ReactElement;
  }>,
): Promise<{ sent: number; failed: number }> {
  const resend = getResendClient();
  const chunkSize = 100;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < emails.length; i += chunkSize) {
    const chunk = emails.slice(i, i + chunkSize);

    try {
      // `resend.batch.send` infers the array element type from the first
      // entry; with our `React.ReactElement<unknown>` payload the inference
      // collapses to a stricter shape than `CreateBatchOptions`. Casting the
      // batch as `Parameters<typeof resend.batch.send>[0]` would still need
      // the same widening - settle for a single, contained cast.
      const { data, error } = await resend.batch.send(
        chunk.map((email) => ({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: [email.to],
          subject: email.subject,
          react: email.react,
        })) as Parameters<typeof resend.batch.send>[0],
      );

      if (error) {
        console.error("[Email] Batch send error:", error);
        failed += chunk.length;
      } else {
        sent += data?.data?.length ?? chunk.length;
      }
    } catch (err) {
      console.error("[Email] Batch send exception:", err);
      failed += chunk.length;
    }

    // Rate limit: wait 500ms between batches
    if (i + chunkSize < emails.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return { sent, failed };
}

/**
 * Send a newsletter to a list of subscriber emails.
 * Uses batch sending with rate limiting.
 */
export async function sendNewsletter(
  options: NewsletterSendOptions,
): Promise<{ sent: number; failed: number }> {
  const emails = options.subscriberEmails.map((email) => ({
    to: email,
    subject: options.subject,
    react: options.react,
  }));

  console.log(
    `[Email] Sending newsletter "${options.subject}" to ${emails.length} subscribers`,
  );

  const result = await sendBatchEmails(emails);

  console.log(
    `[Email] Newsletter sent: ${result.sent} delivered, ${result.failed} failed`,
  );

  return result;
}
