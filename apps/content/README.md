# UseMoney Content CMS

> **Content Management System for UseMoney**

Headless CMS for creating, managing, and publishing blog posts, glossary terms,
and newsletters. Built with Next.js and BlockNote editor.

[![Next.js](https://img.shields.io/badge/Next.js-14.2-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## Quick Start

```bash
# From monorepo root
yarn install
yarn workspace @usemoney/content dev

# Or from apps/content
cd apps/content && yarn dev
```

CMS runs at [http://localhost:3002](http://localhost:3002)

---

## Features

- **Blog Editor**: Rich text editing with BlockNote
- **Glossary Management**: Financial/trading term definitions
- **Newsletter Composer**: Create and schedule newsletter issues
- **Content Calendar**: Visual publication planning
- **Tag Management**: Categorize and organize content
- **Content Ideas**: Track and manage content ideas pipeline
- **SEO Metadata**: Title, description, OG image management
- **Publish/Schedule Workflow**: Draft → Scheduled → Published
- **Role-Based Access**: Owner, Admin, Editor, Writer roles
- **Team Management**: Manage content authors and subscribers
- **Analytics**: Content performance tracking

---

## Content Types

| Type         | Description                           |
| ------------ | ------------------------------------- |
| `BLOG`       | Blog posts for the UseMoney blog      |
| `GLOSSARY`   | Financial/trading glossary terms      |
| `NEWSLETTER` | Newsletter issues sent to subscribers |
| `LEGAL`      | Legal pages (terms, privacy, etc.)    |

---

## Post Status Flow

```
DRAFT → SCHEDULED → PUBLISHED
  ↓
DELETED (soft delete)
```

---

## Access Control

Uses Clerk authentication with role-based access:

- **OWNER**: Full access to all content and settings
- **ADMIN**: Manage all content and authors
- **EDITOR**: Edit any content
- **WRITER**: Edit own content only

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
| `@usemoney/storage`    | GCS for images       |
| `@blocknote/react`     | Rich text editor     |

---

## Environment Variables

```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# Database
DATABASE_URL=mongodb+srv://...

# App URL
NEXT_PUBLIC_APP_URL=http://localhost:3002

# Storage (for feature images)
GCP_PROJECT_ID=...
GCP_STORAGE_BUCKET=...
GCP_SERVICE_ACCOUNT_KEY_BASE64=...
```

---

## Development Commands

```bash
# Dev server (port 3002)
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

## Integration with Web App

Published content is consumed by the main web app (`@usemoney/web`):

- `/blog` - Blog post listing
- `/blog/[slug]` - Individual blog post
- `/glossary` - Glossary term listing
- `/glossary/[term]` - Individual glossary term
- `/newsletter` - Newsletter archive

---

## Documentation

- **CLAUDE.md** - Technical details for AI assistants
- **Root CLAUDE.md** - Project-wide context

---

_Part of the UseMoney monorepo_
