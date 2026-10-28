# Forgot Password Authentication Flow

> 8 nodes

## Key Concepts

- **ForgotPasswordClient()** (6 connections) — `app/forgot-password/client.tsx`
- **firstClerkMessage()** (5 connections) — `app/forgot-password/client.tsx`
- **handleSetPassword()** (4 connections) — `app/forgot-password/client.tsx`
- **forgot-password/page.tsx** (3 connections) — `app/forgot-password/page.tsx`
- **handleCode()** (2 connections) — `app/forgot-password/client.tsx`
- **handleSend()** (2 connections) — `app/forgot-password/client.tsx`
- **handleTrustCode()** (2 connections) — `app/forgot-password/client.tsx`
- **ForgotPasswordPage()** (1 connections) — `app/forgot-password/page.tsx`

## Relationships

- [Password Reset Flow](Password_Reset_Flow.md) (4 shared connections)
- [Sign In Page Flow](Sign_In_Page_Flow.md) (1 shared connections)

## Source Files

- `app/forgot-password/client.tsx`
- `app/forgot-password/page.tsx`

## Audit Trail

- EXTRACTED: 15 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*