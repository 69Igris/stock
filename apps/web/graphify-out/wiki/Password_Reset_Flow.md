# Password Reset Flow

> 16 nodes

## Key Concepts

- **forgot-password/client.tsx** (16 connections) — `app/forgot-password/client.tsx`
- **client-trust.ts** (7 connections) — `components/auth/client-trust.ts`
- **pickClientTrustFactor()** (6 connections) — `components/auth/client-trust.ts`
- **getPasswordStrength()** (5 connections) — `components/auth/usePasswordStrength.ts`
- **usePasswordStrength.ts** (5 connections) — `components/auth/usePasswordStrength.ts`
- **ClientTrustFactor** (3 connections) — `components/auth/client-trust.ts`
- **CodeStep()** (3 connections) — `app/forgot-password/client.tsx`
- **NewPasswordStep()** (3 connections) — `app/forgot-password/client.tsx`
- **client-trust.test.ts** (3 connections) — `__tests__/auth/client-trust.test.ts`
- **FpStep** (1 connections) — `app/forgot-password/client.tsx`
- **SignInNextStep** (1 connections) — `components/auth/client-trust.ts`
- **PasswordStrength** (1 connections) — `components/auth/usePasswordStrength.ts`
- **handleDigit()** (1 connections) — `app/forgot-password/client.tsx`
- **handleKeyDown()** (1 connections) — `app/forgot-password/client.tsx`
- **handleSubmit()** (1 connections) — `app/forgot-password/client.tsx`
- **LABELS** (1 connections) — `components/auth/usePasswordStrength.ts`

## Relationships

- [Authentication Flow Components](Authentication_Flow_Components.md) (6 shared connections)
- [Forgot Password Authentication Flow](Forgot_Password_Authentication_Flow.md) (4 shared connections)
- [Sign In Page Flow](Sign_In_Page_Flow.md) (4 shared connections)
- [Debug & UI Components](Debug_&_UI_Components.md) (2 shared connections)
- [Sign-Up Authentication Flow](Sign-Up_Authentication_Flow.md) (1 shared connections)
- [Authentication Brand Layout](Authentication_Brand_Layout.md) (1 shared connections)

## Source Files

- `__tests__/auth/client-trust.test.ts`
- `app/forgot-password/client.tsx`
- `components/auth/client-trust.ts`
- `components/auth/usePasswordStrength.ts`

## Audit Trail

- EXTRACTED: 38 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*