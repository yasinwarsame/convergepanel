# Security Hardening Patch Report

## Overview
Applied security hardening to `/api/run-panel` and `/api/synthesize-panel` endpoints without breaking existing functionality. All changes are additive (guards/wrappers) and preserve existing request/response contracts.

## Files Changed

### New Files Created
1. **`lib/security/rateLimit.ts`** - Firestore-based rate limiting utility
   - Per-user rate limiting with atomic increments
   - TTL-style cleanup for old rate limit documents
   - Fail-open behavior (allows requests if Firestore unavailable)

2. **`lib/security/requestValidation.ts`** - Request size and input validation
   - Request body size limits
   - Question length validation
   - Results/clusters count validation
   - Result text length validation

### Modified Files
1. **`app/api/synthesize-panel/route.ts`**
   - ✅ Added authentication (reuses existing `verifySessionCookie`/`verifyIdToken` pattern)
   - ✅ Added ownership verification (checks `run.userId` matches authenticated `uid`)
   - ✅ Added request size validation (10 MB max body, 10k chars question, 500k chars per result)
   - ✅ Added rate limiting (20 requests/minute per user)
   - ✅ Backward compatible: allows access to old runs without `userId` field

2. **`app/api/run-panel/route.ts`**
   - ✅ Added rate limiting (30 requests/minute per user)
   - ✅ Added request size validation (same limits as synthesize-panel)
   - ✅ Enhanced input validation with size checks

3. **`lib/api/errorResponse.ts`**
   - ✅ Added `RATE_LIMIT_EXCEEDED` and `REQUEST_TOO_LARGE` error codes

## Security Guards Added

### Authentication
- **`/api/synthesize-panel`**: Now requires authentication (was previously unprotected)
  - Uses same auth pattern as `/api/run-panel`: session cookie or Bearer token
  - Returns 401 with friendly message if unauthenticated

### Ownership Checks
- **`/api/synthesize-panel`**: Verifies user owns the run before synthesizing
  - Checks `run.userId === authenticated uid`
  - **Backward compatible**: Old runs without `userId` field are allowed (logged for monitoring)
  - Returns 403 if ownership check fails

### Request Size Limits
- **Maximum JSON body size**: 10 MB
- **Maximum question length**: 10,000 characters
- **Maximum result text length**: 500,000 characters per result
- **Maximum results count**: 10 (generous, supports up to 5 models currently)
- **Maximum cluster count**: 100
- Returns 413 (Payload Too Large) with details if exceeded

### Rate Limiting
- **`/api/run-panel`**: 30 requests per minute per user
- **`/api/synthesize-panel`**: 20 requests per minute per user
- Uses Firestore with atomic increments (thread-safe)
- Returns 429 (Too Many Requests) with `Retry-After` header
- Includes rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Thresholds Used

| Guard | Threshold | Rationale |
|-------|-----------|-----------|
| Run Panel Rate Limit | 30 req/min | Allows rapid testing but prevents abuse |
| Synthesize Rate Limit | 20 req/min | Synthesis is more expensive, lower limit |
| Request Body Size | 10 MB | Conservative, allows large inputs but prevents DoS |
| Question Length | 10,000 chars | Very generous, normal questions are <1000 chars |
| Result Text Length | 500,000 chars | Allows full model responses without truncation |
| Results Count | 10 | Supports current 5-model max with room for growth |

## Environment Variables
**None required.** All security features use existing Firestore instance and Firebase Admin SDK configuration.

## Manual Test Steps

### 1. Test Authentication (synthesize-panel)
```bash
# Should fail with 401
curl -X POST http://localhost:3000/api/synthesize-panel \
  -H "Content-Type: application/json" \
  -d '{"runId":"test","question":"test","results":[{"modelId":"chatgpt","text":"test"}]}'

# Should succeed with valid session cookie or Bearer token
curl -X POST http://localhost:3000/api/synthesize-panel \
  -H "Content-Type: application/json" \
  -H "Cookie: __session=YOUR_SESSION_COOKIE" \
  -d '{"runId":"test","question":"test","results":[{"modelId":"chatgpt","text":"test"}]}'
```

### 2. Test Rate Limiting
```bash
# Rapid-fire 21 requests (should hit rate limit on 21st)
for i in {1..21}; do
  curl -X POST http://localhost:3000/api/synthesize-panel \
    -H "Content-Type: application/json" \
    -H "Cookie: __session=YOUR_SESSION_COOKIE" \
    -d '{"runId":"test","question":"test","results":[{"modelId":"chatgpt","text":"test"}]}' \
    -w "\nHTTP Status: %{http_code}\n"
  sleep 0.1
done

# Should see 429 on 21st request with Retry-After header
```

### 3. Test Request Size Limits
```bash
# Generate large question (10,001 chars) - should fail with 413
LARGE_QUESTION=$(python3 -c "print('A' * 10001)")
curl -X POST http://localhost:3000/api/synthesize-panel \
  -H "Content-Type: application/json" \
  -H "Cookie: __session=YOUR_SESSION_COOKIE" \
  -d "{\"runId\":\"test\",\"question\":\"$LARGE_QUESTION\",\"results\":[{\"modelId\":\"chatgpt\",\"text\":\"test\"}]}"

# Should return 413 with errorCode: "QUESTION_TOO_LONG"
```

### 4. Test Ownership Check
```bash
# Try to synthesize a run belonging to another user - should fail with 403
# (Requires a runId from a different user's account)
curl -X POST http://localhost:3000/api/synthesize-panel \
  -H "Content-Type: application/json" \
  -H "Cookie: __session=YOUR_SESSION_COOKIE" \
  -d '{"runId":"OTHER_USERS_RUN_ID","question":"test","results":[{"modelId":"chatgpt","text":"test"}]}'

# Should return 403 with errorCode: "FORBIDDEN"
```

### 5. Test Existing Functionality Still Works
```bash
# Normal synthesis request - should succeed
curl -X POST http://localhost:3000/api/synthesize-panel \
  -H "Content-Type: application/json" \
  -H "Cookie: __session=YOUR_SESSION_COOKIE" \
  -d '{
    "runId":"valid-run-id",
    "question":"What is the capital of France?",
    "results":[
      {"modelId":"chatgpt","text":"Paris is the capital of France."},
      {"modelId":"claude","text":"The capital of France is Paris."}
    ]
  }'

# Should return 200 with synthesis report
```

## Validation Checklist

- [x] Build passes (`npm run build`)
- [x] No linter errors
- [x] Authentication added to synthesize-panel
- [x] Ownership checks implemented
- [x] Request size limits enforced
- [x] Rate limiting implemented
- [x] Error responses match existing format
- [x] Backward compatible (old runs without userId allowed)
- [x] No breaking changes to request/response contracts

## Error Response Format

All errors follow the existing format:
```json
{
  "ok": false,
  "errorCode": "ERROR_CODE",
  "message": "User-friendly message",
  "requestId": "optional-request-id",
  "details": {
    // Optional structured details
  }
}
```

Rate limit errors include additional headers:
- `Retry-After`: Seconds until retry allowed
- `X-RateLimit-Limit`: Maximum requests allowed
- `X-RateLimit-Remaining`: Remaining requests in window
- `X-RateLimit-Reset`: Unix timestamp when limit resets

## Notes

- **Fail-open strategy**: Rate limiting and ownership checks fail open (allow request) if Firestore is unavailable. This prevents outages from blocking legitimate users.
- **Backward compatibility**: Old runs without `userId` field are allowed (logged for monitoring). New runs always have `userId` set.
- **No secrets logged**: All error logging excludes sensitive data (API keys, tokens, etc.).
- **Atomic operations**: Rate limiting uses Firestore transactions for thread-safety.

