# Error Handling and Datadog RUM

> 13 nodes

## Key Concepts

- **error.tsx** (9 connections) — `app/error.tsx`
- **DatadogRumProvider.tsx** (7 connections) — `components/DatadogRumProvider.tsx`
- **global-error.tsx** (5 connections) — `app/global-error.tsx`
- **DatadogRumProvider()** (4 connections) — `components/DatadogRumProvider.tsx`
- **rum-init.ts** (4 connections) — `lib/datadog/rum-init.ts`
- **@datadog/browser-rum** (4 connections) — `package.json`
- **GlobalError()** (3 connections) — `app/global-error.tsx`
- **rumInitConfig()** (3 connections) — `lib/datadog/rum-init.ts`
- **@datadog/browser-rum** (3 connections) — `@datadog/browser-rum`
- **ErrorPage()** (2 connections) — `app/error.tsx`
- **ErrorPageProps** (1 connections) — `app/error.tsx`
- **GlobalErrorProps** (1 connections) — `app/global-error.tsx`
- **ErrorContent()** (1 connections) — `app/error.tsx`

## Relationships

- [Debug & UI Components](Debug_&_UI_Components.md) (4 shared connections)
- [App Layout & Shell](App_Layout_&_Shell.md) (3 shared connections)
- [Dashboard UI & Navigation](Dashboard_UI_&_Navigation.md) (2 shared connections)
- [Financial Calculators Pages](Financial_Calculators_Pages.md) (1 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)

## Source Files

- `@datadog/browser-rum`
- `app/error.tsx`
- `app/global-error.tsx`
- `components/DatadogRumProvider.tsx`
- `lib/datadog/rum-init.ts`
- `package.json`

## Audit Trail

- EXTRACTED: 29 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*