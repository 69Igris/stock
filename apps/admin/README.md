# UseMoney Admin Dashboard

> **Internal Admin Dashboard for UseMoney Platform**

Admin dashboard for managing users, content, and platform settings. Role-based access restricted to team members.

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## Quick Start

```bash
# From monorepo root
yarn install
yarn workspace @usemoney/admin dev

# Or from apps/admin
cd apps/admin && yarn dev
```

Dashboard runs at [http://localhost:3001](http://localhost:3001)

---

## Features

- **User Management** - View and manage user accounts
- **Content Management** - Upload and manage learning content
- **Platform Settings** - Configure system settings
- **Role-Based Access** - Admin-only access via Clerk

---

## Pages

| Route                                    | Description         |
| ---------------------------------------- | ------------------- |
| `/`                                      | Dashboard overview  |
| `/users`                                 | User management     |
| `/content`                               | Content management  |
| `/content/create`                        | Create content      |
| `/courses`                               | Courses list        |
| `/courses/create`                        | Create course       |
| `/courses/[courseId]`                    | Course details      |
| `/courses/[courseId]/lessons/[lessonId]` | Lesson editor       |
| `/glossary`                              | Glossary management |
| `/settings`                              | Platform settings   |
| `/sign-in`                               | Authentication      |

---

## Access Control

Only users with `admin` role in Clerk can access.

**Setting Admin Role:**

1. Go to Clerk Dashboard → Users → [User]
2. Edit Public Metadata:

```json
{
  "role": "admin"
}
```

---

## Project Structure

```
apps/admin/
├── app/
│   ├── layout.tsx              # Root layout
│   ├── sign-in/                # Sign-in page
│   ├── unauthorized/           # Access denied page
│   └── (dashboard)/            # Protected routes
│       ├── page.tsx            # Dashboard home
│       ├── users/              # User management
│       ├── content/            # Content management
│       └── settings/           # Settings
├── components/                  # Admin components
└── lib/
    └── utils.ts                # Utilities
```

---

## Dependencies

| Package                    | Purpose            |
| -------------------------- | ------------------ |
| `next`                     | Framework          |
| `@clerk/nextjs`            | Authentication     |
| `@usemoney/database`       | Database client    |
| `@usemoney/ui`             | Shared components  |
| `@usemoney/types`          | Type definitions   |
| `@usemoney/auth`           | Auth utilities     |
| `@usemoney/core`           | Business logic     |
| `@usemoney/content-engine` | Content generation |
| `@usemoney/validation`     | Zod schemas        |

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
```

---

## Development Commands

```bash
# Dev server (port 3001)
yarn dev

# Build
yarn build

# Start production
yarn start

# Lint
yarn lint
```

---

## Testing

See [TEST-COVERAGE.md](../../TEST-COVERAGE.md) for the full report.

---

## Documentation

- **CLAUDE.md** - Technical details for AI assistants
- **Root CLAUDE.md** - Project-wide context

---

_Part of the UseMoney monorepo_
