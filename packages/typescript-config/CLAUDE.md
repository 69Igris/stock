# @usemoney/typescript-config - CLAUDE.md

## Overview

Shared TypeScript configuration for all UseMoney packages and apps.

**Package:** `@usemoney/typescript-config`

---

## Configs

| Config               | Use For                                         |
| -------------------- | ----------------------------------------------- |
| `base.json`          | Base config — what Node packages extend (20/22) |
| `nextjs.json`        | Next.js apps                                    |
| `react-library.json` | React packages                                  |

---

## Usage

```json
// tsconfig.json
{
  "extends": "@usemoney/typescript-config/base.json"
}
```

---

_Last Updated: July 2026_
