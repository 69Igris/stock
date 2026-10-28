# @usemoney/email

> Email service for UseMoney - transactional, newsletter, and broadcast emails
> via Resend

## Features

- **Transactional Email**: Welcome, payment, broker events, import status
- **Newsletter**: Subscriber management, issue delivery, verification flow
- **Broadcast**: Send to audiences/segments
- **Contact Management**: Resend audience sync across 5 segments - free, paid,
  downgraded (previously paid), security (all users), marketing (opt-in)
- **BlockNote Integration**: Convert editor content to email HTML

## Usage

```typescript
import { sendEmail, sendBatchEmails, sendNewsletter } from "@usemoney/email";
import { WelcomeEmail } from "@usemoney/email/templates";

// Single email
await sendEmail({
  to: "user@example.com",
  subject: "Welcome to UseMoney",
  react: WelcomeEmail({ name: "User" }),
});

// Newsletter
await sendNewsletter({
  subscriberEmails: ["a@example.com", "b@example.com"],
  subject: "Weekly Market Update",
  react: NewsletterIssueEmail({ content }),
});
```

## Exports

| Export                     | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `sendEmail`                | Send single transactional email                                        |
| `sendBatchEmails`          | Send batch emails                                                      |
| `sendNewsletter`           | Send to newsletter subscribers                                         |
| `sendBroadcast`            | Send broadcast to audience                                             |
| `upsertResendContact`      | Add/update contact in Resend                                           |
| `addContactToSegment`      | Add contact to audience segment                                        |
| `removeContactFromSegment` | Remove contact from segment                                            |
| `moveContactToSegment`     | Atomically move contact between segments (used on upgrade / downgrade) |
| `blocknoteToEmailHtml`     | Convert BlockNote content to HTML                                      |
| `generateUnsubscribeToken` | Generate unsubscribe token                                             |
| `verifyUnsubscribeToken`   | Verify unsubscribe token                                               |

## Email Templates (18)

Welcome, payment success/failed, subscription renewed/cancelled, broker
connected/disconnected, sync complete, trade import complete/failed, AI query
limit, newsletter verify/welcome/issue, author role changed, account deleted.

## Dependencies

| Package                   | Purpose                |
| ------------------------- | ---------------------- |
| `resend`                  | Email API              |
| `@react-email/components` | Email template toolkit |

## Documentation

See **CLAUDE.md** for technical details.
