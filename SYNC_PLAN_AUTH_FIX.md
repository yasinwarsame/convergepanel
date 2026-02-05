# Sync Plan Authentication Fix

## Problem
After Stripe checkout, the client logs:
```
[billing] Syncing plan from Stripe after successful checkout...
```

But the request to `/api/billing/sync-plan` fails with **401 Unauthorized** and the response body:
```json
{"error":"Unauthorized. Please sign in."}
```

Because of this, the user's Firestore plan field stays "free" even though Stripe shows an active subscription.

## Root Cause

### Client-Side (`app/billing/page.tsx`)
✅ **Already sending Authorization header** with Bearer token:
```typescript
headers: {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${idToken}`,
}
```

### Server-Side (`app/api/billing/sync-plan/route.ts`)
❌ **Only checking session cookie**, not Bearer token:
```typescript
const auth = await verifySessionCookie(req);
if (!auth) {
  return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
}
```

**The Issue**: 
- Client sends `Authorization: Bearer <idToken>` header
- Server only checks for session cookie (`__session`)
- No fallback to Bearer token → 401 Unauthorized

## Solution

### 1. Updated `/app/api/billing/sync-plan/route.ts`

**Changed authentication to match `/api/user/usage` pattern:**
- Try session cookie first (for server-side requests)
- Fallback to Bearer token (for client-side requests)
- Added comprehensive error logging

**Before:**
```typescript
const auth = await verifySessionCookie(req);
if (!auth) {
  return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
}
const uid = auth.uid;
```

**After:**
```typescript
let uid: string;
try {
  const auth = await verifySessionCookie(req);
  
  if (auth) {
    uid = auth.uid;
    console.log("[sync-plan] Authenticated via session cookie:", uid);
  } else {
    // Fallback to Bearer token (for client-side requests)
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.error("[sync-plan] ❌ No ID token provided - missing Authorization header");
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }
    const token = authHeader.split("Bearer ")[1];
    if (!token) {
      console.error("[sync-plan] ❌ No ID token provided - empty token");
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }
    const decodedToken = await verifyIdToken(token);
    uid = decodedToken.uid;
    console.log("[sync-plan] Authenticated via Bearer token:", uid);
  }
} catch (authError: any) {
  // Log specific auth error details
  console.error("[sync-plan] ❌ Authentication error:", {
    message: authError?.message,
    code: authError?.code,
    cause: authError?.cause?.message,
  });
  
  // Check if this is a token verification error
  const isTokenError = 
    authError?.message === "INVALID_ID_TOKEN" ||
    authError?.message?.includes("ID token") ||
    authError?.message?.includes("expired") ||
    authError?.code === "auth/id-token-expired";
  
  return NextResponse.json(
    { 
      error: isTokenError 
        ? "Authentication failed. Please sign in again."
        : "Unauthorized. Please sign in." 
    },
    { status: 401 }
  );
}
```

### 2. Enhanced Client-Side (`app/billing/page.tsx`)

**Improved error handling and token refresh:**
- Force token refresh with `getIdToken(true)` to ensure fresh token
- Better error logging with structured error objects
- Longer timeout for user availability check (1000ms instead of 500ms)

**Key Changes:**
```typescript
// Get fresh ID token (may have expired)
let idToken: string;
try {
  idToken = await user.getIdToken(true); // Force refresh token
} catch (tokenError: any) {
  console.error("[billing] ❌ Failed to get ID token:", tokenError?.message);
  refresh(); // Just refresh without sync
  return;
}

// Better error logging
if (!syncResponse.ok) {
  const errorText = await syncResponse.text();
  let errorData;
  try {
    errorData = JSON.parse(errorText);
  } catch {
    errorData = { error: errorText };
  }
  console.error("[billing] ❌ Sync failed:", {
    status: syncResponse.status,
    statusText: syncResponse.statusText,
    error: errorData,
  });
}
```

### 3. Added Comprehensive Logging

**Server-side logs now show:**
- Authentication method used (session cookie vs Bearer token)
- Specific auth error details (missing token, invalid token, expired token)
- User document lookup results
- Firestore update verification

**Client-side logs now show:**
- Token retrieval success/failure
- Structured error responses
- Sync operation status

## Files Modified

1. **`app/api/billing/sync-plan/route.ts`**
   - Added Bearer token fallback authentication
   - Enhanced error logging
   - Improved error messages

2. **`app/billing/page.tsx`**
   - Force token refresh with `getIdToken(true)`
   - Better error handling and logging
   - Longer timeout for user availability

## Testing

### Expected Behavior After Fix

1. **User completes Stripe checkout**
2. **Client calls `/api/billing/sync-plan` with Bearer token**
3. **Server authenticates via Bearer token** (fallback from session cookie)
4. **Server fetches subscription from Stripe**
5. **Server updates Firestore with plan data**
6. **Client refreshes and shows updated plan**

### Verification Steps

1. Complete a Stripe checkout
2. Check browser console for:
   ```
   [billing] Syncing plan from Stripe after successful checkout...
   [billing] ✅ Plan synced successfully: { plan: "full", ... }
   ```

3. Check server logs for:
   ```
   [sync-plan] Authenticated via Bearer token: <uid>
   [sync-plan] ✅ Authenticated user, syncing plan for: <uid>
   [sync-plan] ✅ Firestore update successful
   ```

4. Verify Firestore document is updated:
   - `plan`: "full" or "lite"
   - `monthlyLimit`: correct limit for plan
   - `maxModelsPerRun`: correct model count
   - `stripeSubscriptionId`: subscription ID from Stripe

## Summary

**What was causing the 401:**
- Server only checked session cookie, not Bearer token
- Client sends Bearer token, server ignores it → 401

**How the fix works:**
- Server now checks session cookie first, then falls back to Bearer token
- Matches the same authentication pattern as `/api/user/usage`
- Client forces token refresh to ensure valid token
- Comprehensive logging helps debug any remaining issues

The authentication flow now works correctly for both server-side (session cookie) and client-side (Bearer token) requests.
