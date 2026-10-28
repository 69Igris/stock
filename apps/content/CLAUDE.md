# UseMoney Content CMS - CLAUDE.md

## Overview

Content Management System for UseMoney. A headless CMS for creating, managing, and publishing blog posts, glossary terms, and newsletters.

**Framework:** Next.js 16.2 (App Router)
**Port:** 3002
**Package:** `@usemoney/content`

---

## Purpose

The Content CMS allows content authors to:

1. Create and edit blog posts, glossary terms, and newsletters
2. Manage content tags and categories
3. Schedule posts for future publication
4. Track content analytics (views, engagement)
5. Manage content metadata for SEO

---

## Directory Structure

```
apps/content/
├── app/
│   ├── layout.tsx              # Root layout with Clerk
│   ├── globals.css             # Global styles
│   ├── sign-in/[[...sign-in]]/ # Sign-in page
│   ├── unauthorized/           # Unauthorized access page
│   ├── (content)/              # Main content dashboard routes
│   │   ├── layout.tsx          # Dashboard layout with sidebar
│   │   ├── page.tsx            # Dashboard home with stats
│   │   ├── posts/              # All posts listing
│   │   ├── drafts/             # Draft posts
│   │   ├── published/          # Published posts
│   │   ├── calendar/           # Content calendar
│   │   ├── tags/               # Tag management
│   │   │   ├── page.tsx        # Tag listing
│   │   │   ├── new-tag/        # Create new tag
│   │   │   └── [slug]/         # Edit tag
│   │   └── usemoney/           # UseMoney specific content
│   │       ├── blog/           # Blog posts
│   │       ├── glossary/       # Glossary terms
│   │       └── newsletter/     # Newsletters
│   ├── (posts)/                # Post editing routes
│   │   ├── layout.tsx          # Editor layout
│   │   ├── new-post/           # Create new post
│   │   └── editor/[id]/        # Edit existing post
├── components/
│   ├── header.tsx              # App header
│   ├── providers.tsx           # Context providers
│   ├── sidebar/                # Navigation sidebar
│   ├── posts/                  # Post-related components
│   │   ├── post-table.tsx      # Posts data table
│   │   ├── post-filters.tsx    # Post filtering controls
│   │   ├── post-navbar.tsx     # Post editor navbar
│   │   ├── metadata-sidebar.tsx # SEO metadata sidebar
│   │   └── publish-dialog.tsx  # Publish/schedule dialog
│   └── tags/                   # Tag-related components
│       ├── tag-form.tsx        # Tag create/edit form
│       └── tag-card.tsx        # Tag display card
├── lib/
│   ├── utils.ts                # Utility functions
│   └── actions/                # Server actions
│       ├── posts.ts            # Post CRUD operations
│       ├── tags.ts             # Tag CRUD operations
│       ├── authors.ts          # Author operations
│       └── dashboard.ts        # Dashboard stats
└── proxy.ts                    # Auth & access control (Next.js 16 `proxy` convention, was `middleware.ts`)
```

---

## Content Types

| Type         | Description                           |
| ------------ | ------------------------------------- |
| `BLOG`       | Blog posts for the main UseMoney blog |
| `GLOSSARY`   | Financial/trading glossary terms      |
| `NEWSLETTER` | Newsletter issues sent to subscribers |
| `LEGAL`      | Legal pages (terms, privacy, etc.)    |
| `DOCS`       | Product documentation pages           |

---

## Post Status Flow

```
DRAFT → SCHEDULED → PUBLISHED → ARCHIVED
  ↓
DELETED (soft delete)
```

- **DRAFT**: Work in progress, not visible to public
- **SCHEDULED**: Will be published at specified date/time
- **PUBLISHED**: Live and visible on the website
- **ARCHIVED**: Removed from public listings, kept for reference
- **DELETED**: Soft deleted, can be restored

---

## Access Control

The content CMS uses Clerk for authentication with role-based access:

1. User signs in via Clerk
2. Middleware checks for content admin access
3. Access granted if (proxy.ts):
   - Email is in the hardcoded `ADMIN_EMAILS` list (proxy.ts:8 — founder only, not an env var), OR
   - Clerk `publicMetadata` role/roles contains `ADMIN`, `OWNER`, or `WRITER`

**Content Author Roles:**

- `OWNER`: Full access to all content and settings
- `ADMIN`: Can manage all content and authors
- `EDITOR`: Can edit any content but not manage authors
- `WRITER`: Can only edit own content

---

## Dependencies

| Package                | Purpose                |
| ---------------------- | ---------------------- |
| `next`                 | Framework              |
| `@clerk/nextjs`        | Authentication         |
| `@usemoney/database`   | Prisma client          |
| `@usemoney/ui`         | Shared UI components   |
| `@usemoney/types`      | Shared types           |
| `@usemoney/utils`      | Utilities              |
| `@usemoney/validation` | Zod schemas            |
| `@usemoney/storage`    | GCS storage for images |

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

## Development

```bash
# Run dev server (port 3002)
yarn dev

# Or from monorepo root
yarn content:dev

# Build
yarn build

# Or from monorepo root
yarn content:build

# Start production
yarn start

# Lint
yarn lint
```

---

## Server Actions

All data mutations use Next.js Server Actions:

**Posts (`lib/actions/posts.ts`):**

- `createPost(data)` - Create a new post
- `updatePost(id, data)` - Update existing post
- `deletePost(id)` - Soft delete a post
- `publishPost(id, publishDate?)` - Publish or schedule
- `unpublishPost(id)` - Revert to draft
- `getPostById(id)` - Get single post
- `archivePost(id)` - Archive a post
- `resendNewsletter(id, segments, individualEmails?)` - Re-send a newsletter issue

**Tags (`lib/actions/tags.ts`):**

- `createTag(data)` - Create a new tag
- `updateTag(slug, data)` - Update existing tag
- `deleteTag(slug)` - Delete a tag
- `getTagBySlug(slug)` - Get single tag
- `listTags(filter)` - List all tags

---

## What's Been Completed

- [x] Dashboard with stats overview
- [x] Post listing with filters
- [x] Post editor with rich content
- [x] Tag management
- [x] Publish/schedule workflow
- [x] Draft/published views
- [x] SEO metadata sidebar
- [x] Clerk authentication
- [x] Role-based access control

---

## What Needs to Be Done

### High Priority

- [x] Rich text editor (BlockNote — used in new-post / editor/[id] / preview)
- [x] Image upload (`app/api/upload`, `app/api/upload-from-url`)
- [ ] Content preview mode
- [ ] Auto-save drafts

### Medium Priority

- [ ] Content calendar view
- [ ] Bulk operations (delete, publish)
- [ ] Content versioning/history
- [ ] Author management UI

### Low Priority

- [ ] Import from external sources
- [ ] AI-assisted writing
- [ ] SEO score checker
- [ ] Content templates

---

## Integration with Web App

Published content is consumed by the main web app (`@usemoney/web`):

- `/blog` - Lists published blog posts
- `/blog/[slug]` - Individual blog post
- `/glossary` - Glossary term listing
- `/glossary/[term]` - Individual glossary term
- `/newsletter` - Newsletter archive

---

## Testing

See [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests for this app, update `TEST-COVERAGE.md` in the repo root.

---

## Restrictions & Guidelines

### Access Control

- Only content authors can access the CMS
- Writers can only edit their own posts
- Admins can edit all posts

### Content

- All posts require title, content, and URL slug
- URL slugs must be unique across all content types
- Feature images should be optimized before upload

### Architecture

- Use server actions for all mutations
- Share components from @usemoney/ui
- Use @usemoney/database for DB access
- Validate all inputs with Zod schemas

---

_Last Updated: July 2026_
