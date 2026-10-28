# Content CMS - Architecture

> Deep technical reference for `@usemoney/content`. Complements
> [`README.md`](./README.md) (quick start) and [`CLAUDE.md`](./CLAUDE.md)
> (project memory & rules).

**Stack:** Next.js 14.2 (App Router) · React 18 · Clerk · MongoDB via Prisma ·
BlockNote editor · Resend (newsletters) **Deploy target:** Vercel
(content.usemoney.ai) **Audience:** Content authors on the UseMoney team.
Role-based access (OWNER / ADMIN / EDITOR / WRITER).

---

## 1. Purpose

Authoring tool for:

- **Blog posts** (published to usemoney.ai/blog)
- **Newsletter issues** (sent via Resend to subscribed audiences)
- **Glossary terms** (displayed at usemoney.ai/glossary)
- **Help center docs** (displayed at usemoney.ai/docs)

Writes to the shared MongoDB; the web app reads published content on public
pages.

---

## 2. System architecture

```
              ┌────────────────────────────────┐
              │  Content author's browser      │
              │  (BlockNote editor)            │
              └───────────────┬────────────────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │  Clerk middleware     │
                  │  + role gate          │
                  └──────────┬────────────┘
                             │
                             ▼
              ┌────────────────────────────────┐
              │  Next.js pages + server        │
              │  actions (lib/actions)         │
              └───────────────┬────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
  │   MongoDB    │   │     Resend     │   │     GCS      │
  │   (Prisma)   │   │  (broadcasts)  │   │ (images)     │
  └──────────────┘   └────────────────┘   └──────────────┘
          │
          │ (published content)
          ▼
  ┌──────────────────────┐
  │  Web app (public)    │
  │ /blog  /docs         │
  │ /glossary /newsletter│
  └──────────────────────┘
```

---

## 3. Content lifecycle

```
   DRAFT ────────► SCHEDULED ────────► PUBLISHED
     │                 │                   │
     │                 │ (publish date)    │
     │                 │                   │
     └─────────────────┴───────────────────┘
                       │
                       ▼
                   DELETED (soft)
                       │
                       ▼ (manual via admin)
                   restored or hard-deleted
```

- **DRAFT** - author writes, saves repeatedly
- **SCHEDULED** - future publish date; cron publishes at scheduled time
- **PUBLISHED** - visible on usemoney.ai; newsletters delivered to Resend
  audiences
- **DELETED** - soft delete, recoverable by admins

---

## 4. Subsystem deep-dives

### 4.1 Editor (BlockNote)

- Rich text editing with structured JSON output (BlockNote blocks)
- Stored as JSON in `Post.content` column
- Converted to HTML server-side for email delivery via `blocknoteToEmailHtml()`
  in `@usemoney/email`
- Rendered in the web app via `@blocknote/react` renderer on public pages

### 4.2 Publishing workflow (`lib/actions/posts.ts`)

**Publish blog / docs:**

```
author clicks "Publish"
  ↓
publishPost(id, publishDate?)
  ↓
update Post.status = PUBLISHED
  ↓
invalidate usemoney.ai cache for /blog, /docs
```

**Publish newsletter:**

```
author clicks "Publish" → selects audiences (free / paid / downgraded / security)
  ↓
publishPost saves + triggers sendNewsletterBroadcastShared (fire-and-forget)
  ↓
@usemoney/email/newsletter.ts:
  - convert BlockNote JSON → email HTML
  - create Resend broadcast per audience
  - Resend sends to all contacts in that audience
  ↓
EmailLog records outcome per segment
```

### 4.3 Subscriber management (`lib/actions/subscribers.ts`)

- Manages `NewsletterSubscriber` table (newsletter-only, separate from Clerk
  users)
- Syncs to Resend audiences (mirrors `usemoney-free`, `usemoney-paid`, etc.)
- Verification flow: signup → magic link email → verified
- Unsubscribe: HMAC-signed link (no auth needed)

### 4.4 Analytics (`lib/actions/analytics.ts`)

- Per-post view counts (incremented from web app on read)
- Newsletter broadcast open/click rates pulled from Resend API
- Subscriber segment breakdown for publishing decisions

### 4.5 Role-based access (`middleware.ts`)

| Role   | Can do                                     |
| ------ | ------------------------------------------ |
| OWNER  | Full access, including role assignments    |
| ADMIN  | All content operations, no role management |
| EDITOR | Edit any post                              |
| WRITER | Only edit own posts                        |

Enforced in middleware AND in each server action.

---

## 5. Data flow - newsletter publish

```
Author writes newsletter in BlockNote
  ↓
Selects target segments: [free, paid, downgraded]
  ↓
Clicks "Publish"
  ↓
Server action: publishPost(id, "PUBLISHED")
  ↓
sendNewsletterBroadcastShared({ title, content, segments })
  ↓
For each segment:
  - Look up audience ID (RESEND_AUDIENCE_{SEGMENT}_ID)
  - Render BlockNote JSON → HTML
  - Create Resend broadcast
  - Trigger send
  ↓
Write EmailLog { segment, status, broadcastId }
  ↓
Return to editor with "sent to X audiences"
```

---

## 6. External integrations

| Integration              | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| **Clerk**                | Auth + role check for authors                 |
| **MongoDB Atlas**        | Content storage (shared with web app)         |
| **Resend**               | Newsletter broadcasts + subscriber management |
| **Google Cloud Storage** | Feature images, attachments                   |
| **BlockNote**            | Editor (client-only library)                  |

---

## 7. Relationship to other apps

| App         | Reads from CMS                                                  | Writes to CMS                                |
| ----------- | --------------------------------------------------------------- | -------------------------------------------- |
| **Web**     | Yes - public `/blog`, `/docs`, `/glossary`, `/newsletter` pages | No                                           |
| **Admin**   | Yes - view content stats                                        | Limited - can force-unpublish, cannot author |
| **API**     | No                                                              | No                                           |
| **Workers** | Yes - `newsletter-publish` processor reads scheduled posts      | No                                           |

---

## 8. Deployment model

- **Hosting:** Vercel (content.usemoney.ai)
- **Separate project** from web app - independent deploys, faster for authors
  iterating on editor UI
- **Scheduled publishing:** Cron endpoint publishes `SCHEDULED` posts when their
  publishDate is reached

---

## 9. Why separate from web app?

- **Different audience:** authors vs end users
- **Different concerns:** WYSIWYG editing complexity (BlockNote bundle)
  shouldn't bloat the main web app
- **Safer deploys:** content team can ship editor improvements without touching
  trading code
- **Role boundaries:** content authors never need access to user portfolio code

---

## See also

- [README.md](./README.md) - quick start + author guide
- [CLAUDE.md](./CLAUDE.md) - project memory, conventions
- [`packages/email/`](../../packages/email/) - newsletter delivery + segment
  management
- [`docs/content-planning/`](../../docs/content-planning/) - editorial content
  plans (blogs/newsletters/docs roadmap)
