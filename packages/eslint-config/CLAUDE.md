# @usemoney/eslint-config - CLAUDE.md

## Overview

Shared ESLint configuration for all UseMoney packages and apps.

**Package:** `@usemoney/eslint-config`

---

## Configs

| Config                                     | Use For                           |
| ------------------------------------------ | --------------------------------- |
| `./base` — named export `config`           | Base flat config for all packages |
| `./next-js` — named export `nextJsConfig`  | Next.js apps                      |
| `./react-internal` — named export `config` | React packages                    |

---

## Usage

```javascript
// eslint.config.mjs — ESLint 9 flat config (legacy .eslintrc `extends` does not work)
import { config } from "@usemoney/eslint-config/react-internal";

export default config;
```

---

## Gotchas

- `packages/ui/eslint.config.mjs` currently imports `@repo/eslint-config/react-internal` — a leftover template scope that does NOT resolve; rename to `@usemoney/eslint-config/...` to unbreak ui lint.
- `apps/web` does not use this package; it lints via its own `.eslintrc.json` (`next/core-web-vitals`).

---

_Last Updated: July 2026_
