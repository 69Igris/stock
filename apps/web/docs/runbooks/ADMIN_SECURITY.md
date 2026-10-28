# Admin Security & Debug Features

## Overview

All debug and cache management endpoints are now restricted to **admin users only** (specifically `deepshaswat@gmail.com`).

## Secured Endpoints

### 1. **Cache Management**

- `POST /api/cache/clear` - Clear Redis cache (all/user/pattern/memory)
- `GET /api/cache/stats` - View cache statistics and hit rates
- `DELETE /api/cache/stats` - Reset cache statistics counters

### 2. **Debug Endpoints**

- `GET /api/debug/clear-ff-cache` - Clear feature flags cache
- `GET /api/debug/clear-ff-cache?all=true` - Clear all feature flags

### 3. **Debug Pages**

- `/debug-posthog` - PostHog debug interface

## Security Implementation

### Admin Check

All endpoints now use the `checkAdminAuth()` function from `lib/auth/admin.ts`:

```typescript
const { isAdmin, userId, userEmail } = await checkAdminAuth();

if (!isAdmin) {
  return NextResponse.json(
    {
      error: "Unauthorized: Admin access required",
      message: "This endpoint is restricted to admin users only",
    },
    { status: 403 }
  );
}
```

### Admin User

- **Email:** `deepshaswat@gmail.com`
- **Configured in:** `lib/auth/admin.ts`
- **Enforcement:** All debug/cache endpoints check this email before allowing access

### Production Protection

Debug features are automatically disabled in production unless explicitly enabled.

**Environment Variable:**

```bash
# In .env file - uncomment to enable debug features in production
ENABLE_DEBUG_FEATURES=true
```

**Behavior:**

- **Development:** Debug features always enabled (admin check still enforced)
- **Production:** Debug features disabled by default
  - Set `ENABLE_DEBUG_FEATURES=true` to enable in production
  - Admin email check still enforced even when enabled

## Usage Examples

### Clear Cache (Admin Only)

```bash
# Clear all cache
curl -X POST http://localhost:3000/api/cache/clear \
  -H "Content-Type: application/json" \
  -H "Cookie: your-auth-cookie" \
  -d '{"action": "all"}'

# Clear user cache
curl -X POST http://localhost:3000/api/cache/clear \
  -H "Content-Type: application/json" \
  -H "Cookie: your-auth-cookie" \
  -d '{"action": "user", "userId": "user_123"}'

# Clear by pattern
curl -X POST http://localhost:3000/api/cache/clear \
  -H "Content-Type: application/json" \
  -H "Cookie: your-auth-cookie" \
  -d '{"action": "pattern", "pattern": "dashboard:*"}'
```

### View Cache Stats (Admin Only)

```bash
curl http://localhost:3000/api/cache/stats \
  -H "Cookie: your-auth-cookie"
```

### Clear Feature Flags (Admin Only)

```bash
# Clear for current admin user
curl http://localhost:3000/api/debug/clear-ff-cache \
  -H "Cookie: your-auth-cookie"

# Clear all feature flags
curl "http://localhost:3000/api/debug/clear-ff-cache?all=true" \
  -H "Cookie: your-auth-cookie"
```

## Response Examples

### Success (Admin User)

```json
{
  "success": true,
  "message": "Successfully cleared all Redis cache (42 keys) and memory cache",
  "details": {
    "keysCleared": 42
  },
  "timestamp": "2026-01-14T10:30:00.000Z"
}
```

### Unauthorized (Non-Admin)

```json
{
  "error": "Unauthorized: Admin access required",
  "message": "Cache clearing is restricted to admin users only"
}
```

### Debug Disabled in Production

```json
{
  "error": "Debug features are disabled in production"
}
```

## Files Changed

### Created

- `lib/auth/admin.ts` - Admin authentication utilities

### Modified

- `app/api/cache/clear/route.ts` - Added admin check
- `app/api/cache/stats/route.ts` - Added admin check (GET & DELETE)
- `app/api/debug/clear-ff-cache/route.ts` - Added admin check + debug flag check
- `app/debug-posthog/page.tsx` - Added admin check + redirect
- `.env` - Added `ENABLE_DEBUG_FEATURES` documentation

## Security Features

1. **Email-based Admin Check**: Only `deepshaswat@gmail.com` can access
2. **Production Safeguard**: Debug features disabled by default in production
3. **Audit Logging**: All admin actions logged with user email and action type
4. **Graceful Errors**: Clear error messages for unauthorized access
5. **No Exposure**: Debug pages redirect to dashboard if not admin

## Deployment Checklist

### Development/Staging

- ✅ Admin can access all debug endpoints
- ✅ Non-admin users get 403 Forbidden

### Production

- ✅ Debug features disabled by default
- ✅ Set `ENABLE_DEBUG_FEATURES=true` if needed (not recommended)
- ✅ Admin check enforced even when enabled
- ✅ All actions logged

## Recommendations

### For Production

1. **Keep `ENABLE_DEBUG_FEATURES` unset or `false`** - This disables debug endpoints entirely
2. **Use CLI script instead** - For cache clearing, use `npx tsx scripts/clear-cache.ts` on the server
3. **Monitor logs** - All admin actions are logged for audit trail

### For Staging/QA

1. Set `ENABLE_DEBUG_FEATURES=true` to test debug features
2. Verify admin restrictions work correctly
3. Test with both admin and non-admin accounts

## CLI Alternative

For production cache clearing without exposing the API:

```bash
# SSH into server, then run:
npx tsx scripts/clear-cache.ts stats
npx tsx scripts/clear-cache.ts all
npx tsx scripts/clear-cache.ts user user_123abc
npx tsx scripts/clear-cache.ts pattern "dashboard:*"
```

## Adding More Admins

To add more admin users, edit `lib/auth/admin.ts`:

```typescript
// Change from single email:
const ADMIN_EMAIL = "deepshaswat@gmail.com";

// To array of emails:
const ADMIN_EMAILS = ["deepshaswat@gmail.com", "another-admin@gmail.com"];

// Update isAdmin check:
return ADMIN_EMAILS.includes(userEmail);
```

## Questions?

- **Issue:** Non-admin accessing debug endpoint
  - **Expected:** 403 Forbidden with clear error message

- **Issue:** Admin can't access in production
  - **Check:** Is `ENABLE_DEBUG_FEATURES=true` set in production `.env`?
  - **Check:** Is user signed in with `deepshaswat@gmail.com`?

- **Issue:** Debug page redirects even for admin
  - **Check:** User authentication via Clerk
  - **Check:** Email address matches exactly (case-sensitive)
