# UseMoney Admin Dashboard - CLAUDE.md

## Overview

Internal admin dashboard for UseMoney team members. Provides user management, content management, and platform settings.

**Framework:** Next.js 16.2 (App Router)
**Port:** 3001
**Package:** `@usemoney/admin`

---

## Purpose

The admin dashboard allows UseMoney team members to:

1. View and manage user accounts
2. Upload and manage learning content
3. Configure platform settings
4. Monitor system health

---

## Directory Structure

```
apps/admin/
├── app/
│   ├── layout.tsx              # Root layout with Clerk
│   ├── sign-in/[[...sign-in]]/ # Sign-in page
│   ├── unauthorized/           # Unauthorized access page
│   └── (dashboard)/            # Protected dashboard routes
│       ├── layout.tsx          # Dashboard layout with sidebar
│       ├── page.tsx            # Dashboard home
│       ├── audit-logs/ content/ coupons/ courses/
│       ├── gst/ invites/ members/ payments/
│       └── settings/ users/    # one dir per route in the Pages table below
├── components/                  # Admin-specific components
├── lib/
│   └── utils.ts                # Utility functions
└── public/                     # Static assets
```

---

## Pages

| Route           | Description                                              |
| --------------- | -------------------------------------------------------- |
| `/`             | Dashboard home - overview stats                          |
| `/courses`      | Courses & lessons management                             |
| `/content`      | Content/learning management                              |
| `/coupons`      | Coupon/discount management (percent + flat ₹; MONEY-865) |
| `/invites`      | Invite-link management                                   |
| `/gst/invoices` | GST export invoices                                      |
| `/audit-logs`   | Broker failures + consent + sync logs (MONEY-583)        |
| `/payments`     | Payment list + manual complete failover (MONEY-413)      |
| `/members`      | App-user mgmt: detail + plan switch + delete (MONEY-412) |
| `/users`        | Admin allowlist (who is an admin); server-resolved       |
| `/settings`     | Platform settings                                        |
| `/sign-in`      | Clerk sign-in page                                       |
| `/unauthorized` | Shown when non-admin tries to access                     |

---

## Access Control

The admin dashboard uses Clerk for authentication with role-based access:

1. User signs in via Clerk
2. `apps/admin/proxy.ts` (Next.js 16 renamed the `middleware` convention to
   `proxy` — runs on the Node runtime) checks `publicMetadata.role === "admin"`
   OR an `ADMIN_EMAILS` allowlist match (`isUserAdmin` in
   `lib/admin-auth-logic.ts`). Server actions + API routes independently re-gate
   via `requireAdmin()` / `verifyAdminUserId()`.
   _History: MONEY-697 (filed against Next 14) flagged the gate as dead because
   Next 14 only auto-loaded `middleware.ts`; the Next 16 upgrade resolved it by
   making `proxy.ts` the loaded convention — so the file is `proxy.ts`, not
   `middleware.ts` (which Next 16 now deprecates)._
3. Non-admins are redirected to `/unauthorized`

> Every admin WRITE is appended to `AdminAuditLog` via `recordAdminAction`
> (`@usemoney/services`). The `/users` admin list is resolved server-side
> (MONEY-703), never hardcoded in the client bundle.

**Admin Role Setup:**
In Clerk Dashboard → Users → [User] → Public Metadata:

```json
{
  "role": "admin"
}
```

---

## Dependencies

| Package                | Purpose              |
| ---------------------- | -------------------- |
| `next`                 | Framework            |
| `@clerk/nextjs`        | Authentication       |
| `@usemoney/database`   | Prisma client        |
| `@usemoney/ui`         | Shared UI components |
| `@usemoney/types`      | Shared types         |
| `@usemoney/utils`      | Utilities            |
| `@usemoney/validation` | Zod schemas          |

---

## Environment Variables

```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# Database
DATABASE_URL=mongodb+srv://...

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3001

# Admin allowlist — proxy.ts + isUserAdmin read this CSV (alternative to Clerk role)
ADMIN_EMAILS=founder@example.com
```

---

## Development

```bash
# Run dev server (port 3001)
yarn dev

# Build
yarn build

# Start production
yarn start

# Lint
yarn lint
```

---

## What's Been Completed

- [x] Basic dashboard structure
- [x] Clerk authentication
- [x] Role-based access control
- [x] User listing page
- [x] Content management page
- [x] Settings page
- [x] Unauthorized page

---

## What Needs to Be Done

### High Priority

- [ ] Content upload functionality
- [ ] Content preview

### Medium Priority

- [ ] Analytics dashboard
- [ ] User activity logs
- [ ] Bulk user operations
- [ ] Feature flag management

### Low Priority

- [ ] Email templates management
- [ ] System logs viewer
- [ ] Database maintenance tools

---

## Testing

See [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests for this app, update `TEST-COVERAGE.md` in the repo root.

---

## Restrictions & Guidelines

### Access Control

- Only users with `admin` role can access
- All routes protected by middleware
- Separate Clerk instance recommended for production

### Security

- No direct database mutations from client
- Use server actions for all operations
- Log all admin actions for audit

### Architecture

- Share components from @usemoney/ui
- Use @usemoney/database for DB access
- Keep admin-specific logic in this app

---

_Last Updated: July 2026_
