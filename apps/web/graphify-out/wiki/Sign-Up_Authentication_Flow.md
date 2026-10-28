# Sign-Up Authentication Flow

> 10 nodes

## Key Concepts

- **SignUpPage()** (10 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **firstClerkMessage()** (6 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **[[...sign-up]]/page.tsx** (3 connections) — `app/sign-up/[[...sign-up]]/page.tsx`
- **handleContinueSubmit()** (2 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **handleOAuth()** (2 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **handleResend()** (2 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **handleSubmit()** (2 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **handleVerify()** (2 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **handleChangeEmail()** (1 connections) — `app/sign-up/[[...sign-up]]/client.tsx`
- **SignUpPage()** (1 connections) — `app/sign-up/[[...sign-up]]/page.tsx`

## Relationships

- [Authentication Flow Components](Authentication_Flow_Components.md) (3 shared connections)
- [Pricing Page & Plans](Pricing_Page_&_Plans.md) (1 shared connections)
- [Password Reset Flow](Password_Reset_Flow.md) (1 shared connections)

## Source Files

- `app/sign-up/[[...sign-up]]/client.tsx`
- `app/sign-up/[[...sign-up]]/page.tsx`

## Audit Trail

- EXTRACTED: 18 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*