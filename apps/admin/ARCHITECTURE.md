# Admin Dashboard - Architecture

> Deep technical reference for `@usemoney/admin`. Complements
> [`README.md`](./README.md) (quick start) and [`CLAUDE.md`](./CLAUDE.md)
> (project memory & rules).

**Stack:** Next.js 14.2 (App Router) · React 18 · Clerk · MongoDB via Prisma ·
Tailwind **Deploy target:** Vercel (admin.usemoney.ai) **Audience:** Internal
team only. Access gated by Clerk roles + allow-listed emails.

---

## 1. Purpose

Internal tooling for the UseMoney team to:

- View platform-wide metrics (users, revenue, broker connections)
- Manage content (posts, newsletters, courses) - direct DB access bypassing the
  content CMS
- Issue invite tokens with custom discount codes
- Inspect user subscriptions, credit balances, and payment history
- Trigger admin operations (sync products from Dodo, clear caches, etc.)

**Not for:** end users, broker OAuth, real-time trading data.

---

## 2. System architecture

```
                  ┌────────────────────────────┐
                  │  Admin user's browser      │
                  │  (internal team only)      │
                  └─────────────┬──────────────┘
                                │
                                ▼
                     ┌──────────────────────┐
                     │  Clerk middleware    │
                     │  + role gate         │ ← emails allow-list + `admin` role
                     └──────────┬───────────┘
                                │
                                ▼
                     ┌──────────────────────┐
                     │  Admin pages (RSC)   │
                     │  + server actions    │
                     └──────────┬───────────┘
                                │
                   ┌────────────┴────────────┐
                   ▼                         ▼
          ┌──────────────┐         ┌──────────────────┐
          │   MongoDB    │         │ Admin operations │
          │  (via Prisma)│         │ (/api/admin/*)   │
          └──────────────┘         └────────┬─────────┘
                                            │
                                            ▼
                                   ┌────────────────┐
                                   │  Dodo Payments │
                                   │  (product sync)│
                                   └────────────────┘
```

---

## 3. Access control

Two-layer gate:

1. **Clerk middleware** - rejects unauthenticated users with 401/redirect
2. **Admin allow-list** - email must be in `CONTENT_ADMIN_EMAILS` env var OR
   user must have `admin` role in Clerk `publicMetadata`

Bypass is impossible: both client pages AND server actions re-check the
allow-list.

---

## 4. Feature areas

### 4.1 Dashboard (`app/(dashboard)/page.tsx`)

- Top-level KPIs: total users, MRR, paying customers, broker connections
- Placeholder-heavy today (content stats hardcoded) - real-time stats via
  `lib/actions/stats.ts`

### 4.2 User management

- Search users by email / clerkId
- View subscription, credits, broker connections
- Impersonate (if configured) - uses Clerk's impersonation tokens

### 4.3 Content management

- Direct DB access to `Post`, `Tag`, `NewsletterSubscriber`
- Separate from the content CMS app - admin is for **platform ops**, content CMS
  is for **authors**

### 4.4 Invite tokens (`app/api/admin/invites/route.ts`)

- Create single-use or multi-use invite URLs
- Can bundle discount codes (via `dodoDiscountId`)
- Tracked in `InviteToken` model

### 4.5 Dodo product sync (`app/api/admin/sync-products/route.ts`)

- Pulls latest products from Dodo API
- Updates `DodoProduct` table (price, billing period, archived state)
- Runs on-demand OR via Vercel Cron daily

---

## 5. Data flow - admin operation example

Admin creates an invite token:

```
Admin fills form → clicks "Create"
  ↓
Server action createInviteAction({ plan, maxUses, discount })
  ↓
Check admin role via Clerk
  ↓
Call Dodo API to create discount (if discount specified)
  ↓
Insert into InviteToken table
  ↓
Return { token, url } to admin
  ↓
Admin shares url with user
```

---

## 6. External integrations

| Integration       | Purpose                              |
| ----------------- | ------------------------------------ |
| **Clerk**         | Auth + admin role check              |
| **MongoDB Atlas** | Platform datastore (same as web app) |
| **Dodo Payments** | Product sync, discount creation      |
| **Resend**        | Subscriber analytics for newsletters |

---

## 7. Deployment model

- **Hosting:** Vercel (admin.usemoney.ai)
- **Not publicly discoverable:** no links from usemoney.ai, not in sitemaps
- **Firewall:** can add IP allow-list if needed (currently not enforced - relies
  on Clerk + email gate)

---

## 8. Design decisions

### Why separate from web app?

- **Smaller blast radius** - bug in admin can't crash user-facing web app
- **Faster iteration** - no risk of breaking end users with admin UI changes
- **Different auth model** - stricter role check, different session TTL if
  needed
- **Clear security boundary** - code review for admin changes doesn't need to
  consider user paths

### Why not a private GitHub repo?

- Shares too much with the web app (Prisma schema, `packages/*` types)
- Monorepo keeps type safety across apps
- Obscurity (subdomain + email gate) is sufficient - not a security boundary

---

## See also

- [README.md](./README.md) - quick start
- [CLAUDE.md](./CLAUDE.md) - project memory, conventions
- [`apps/content/ARCHITECTURE.md`](../content/ARCHITECTURE.md) - distinct
  content authoring app
