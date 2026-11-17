# API error catalog, request text rules and error precedence (API-0, Addendum 2)

| | |
|---|---|
| **Status** | Design contract, 0.3.0-draft. Added by [Owner Decision Addendum 2](owner-decision-addendum-2.md) (2026-11-17) to resolve audit findings C-3, C-4 and C-6. **Not implemented** beyond the 12 API-1a codes marked below. |
| **Single source** | This file is the **only** list of error codes. PRD §9.5, the `openapi.yaml` response descriptions and `lib/apiPlatform/errors.ts` must agree with it. `openapi.yaml` mirrors §2 in `components.x-error-catalog`; `docs/__tests__/apiOpenapiRequestContract.spec.ts` pins the mirror, the OpenAPI response descriptions and the implemented API-1a codes to this table. |
| **Changing it** | Add or change a row here first, in the same PR as the OpenAPI mirror. A new code is an additive change. Renaming or removing a code, or changing its status or `type`, is a breaking change (PRD §8.7). |
| **Does not change** | Any owner ruling (OD-1..OD-21, Addendum 1 D1–D10, OQ-1..OQ-5, §1.1 P1–P4) or any beta exclusion (Addendum 1 §4). |

## 1. Envelope

Every error uses `{ error: { type, code, message, param, request_id, doc_url } }` (PRD §9.5), with `Cache-Control: no-store` and `X-Request-Id` on every response. `message` is a fixed string per code: no stack, no provider text, no input text, no key material and no tenant data. `param` is `null` or the dotted path of the offending member (for example `input.question`, `options.stream`, `metadata.customer_ref`). Clients must handle an unknown code by its HTTP status and `type`.

## 2. Catalog

**Plane:** `data` = `https://api.convergepanel.com/v1` (API keys); `management` = `/api/developer/*` on the main app (Firebase session only); `both` = either.
**Stage:** the implementation stage that introduces the code (Addendum 1 §9).
**Beta status:**
- `active`: may be returned in the controlled beta.
- `beta-rejection`: the beta-only rejection of an option the beta excludes (Addendum 1 §4). It stays defined after the beta for the post-beta meaning noted in §2.2.
- `future`: a future capability; never returned in the controlled beta.
- `reserved`: reserved for a fix in progress; the code, status and type are fixed now.
- `proposed`: pending an owner decision; not part of the contract until approved.

**Implemented (API-1a):** present in `lib/apiPlatform/errors.ts` on the API-1a branch (#327) with this status and `type`.

| Code | HTTP | `type` | Plane | Stage | Beta status | Implemented (API-1a) | Fixed message (intent) |
|---|---|---|---|---|---|---|---|
| `invalid_request` | 400 | `invalid_request_error` | both | API-1a | active | yes | The request is invalid. |
| `invalid_json` | 400 | `invalid_request_error` | data | API-3 | active | no | The request body is not valid JSON. |
| `invalid_encoding` | 400 | `invalid_request_error` | data | API-3 | active | no | The request body contains characters that are not allowed. |
| `missing_field` | 400 | `invalid_request_error` | data | API-3 | active | no | A required field is missing. |
| `unknown_field` | 400 | `invalid_request_error` | data | API-3 | active | no | The request contains a field that is not recognized. |
| `empty_input` | 400 | `invalid_request_error` | data | API-3 | active | no | The input text is empty. |
| `input_too_long` | 400 | `invalid_request_error` | data | API-3 | active | no | The input text is too long. |
| `invalid_model` | 400 | `invalid_request_error` | data | API-3 | active | no | A model ID is not valid. |
| `invalid_cursor` | 400 | `invalid_request_error` | data | API-3 | active | no | The pagination cursor is not valid. |
| `invalid_status` | 400 | `invalid_request_error` | data | API-3 | active | no | The status filter is not valid. |
| `invalid_api_key` | 401 | `authentication_error` | data | API-1a | active | yes | The API key is invalid. |
| `api_key_not_accepted` | 401 | `authentication_error` | management | API-1a | active | yes | API keys are not accepted on this endpoint. |
| `session_required` | 401 | `authentication_error` | management | API-1a | active | yes | A signed-in session is required. |
| `quota_exceeded` | 402 | `billing_error` | data | API-2β | active | no | The credit quota for this period is used up. |
| `spend_limit_reached` | 402 | `billing_error` | data | API-2β | active | no | The organization spend limit has been reached. |
| `payment_required` | 402 | `billing_error` | data | API-2S | future | no | A payment is required to continue. |
| `insufficient_scope` | 403 | `permission_error` | data | API-1a | active | yes | The API key does not have the required scope. |
| `org_suspended` | 403 | `permission_error` | data | API-1a | active | yes | The organization is suspended. |
| `live_key_requires_plan` | 403 | `permission_error` | data | API-1a | active | yes | Live keys require an active API plan. |
| `failed_job_threshold_exceeded` | 403 | `permission_error` | data | API-2β | active | no | Too many failed jobs; live creates are paused. |
| `model_response_access_disabled` | 403 | `permission_error` | data | post-beta (OD-19) | future | no | Model response access is not enabled for this organization. |
| `pipeline_processing_not_acknowledged` | 403 | `permission_error` | data | API-3 | active | no | Research requires a recorded pipeline-processing acknowledgement. |
| `insufficient_role` | 403 | `permission_error` | management | API-1a | active | yes | Your organization role does not allow this action. |
| `fresh_session_required` | 403 | `permission_error` | management | API-1a | active | yes | Sign in again to perform this action. |
| `identity_not_verified` | 403 | `permission_error` | management | API-1a (#327) | reserved | no | Verify your email address to manage API organizations. |
| `verification_not_found` | 404 | `not_found` | data | API-3 | active | no | Not found. |
| `not_found` | 404 | `not_found` | management | API-1a | active | yes | Not found. |
| `idempotency_key_reused` | 409 | `idempotency_error` | data | API-3 | active | no | This idempotency key was used with a different request. |
| `request_in_progress` | 409 | `idempotency_error` | data | API-3 | active | no | A request with this idempotency key is in progress; retry. |
| `not_cancelable` | 409 | `invalid_request_error` | data | API-3 | active | no | The verification can no longer be canceled. |
| `verification_deleted` | 410 | `gone` | data | API-3 | active | no | The verification was deleted. |
| `request_too_large` | 413 | `request_too_large` | data | API-3 | active | no | The request body is too large. |
| `unsupported_media_type` | 415 | `invalid_request_error` | data | API-3 | active | no | The request body must be UTF-8 application/json. |
| `model_unavailable` | 422 | `unprocessable` | data | API-3 | active | no | A selected model is not available. |
| `too_few_models` | 422 | `unprocessable` | data | API-3 | active | no | Select at least two models. |
| `model_limit_exceeded` | 422 | `unprocessable` | data | API-3 | active | no | Too many models are selected. |
| `type_unavailable` | 422 | `unprocessable` | data | API-3 | active | no | This verification type is not available. |
| `synthesis_not_supported` | 422 | `unprocessable` | data | API-3 | active | no | Synthesis is not supported for claims. |
| `synthesis_unavailable` | 422 | `unprocessable` | data | API-3 | beta-rejection | no | Synthesis is not available. |
| `fallback_unavailable` | 422 | `unprocessable` | data | API-3 | beta-rejection | no | Provider fallback is not available. |
| `option_unavailable_in_beta` | 422 | `unprocessable` | data | API-3 | beta-rejection | no | This option is not available in the beta. |
| `repeated_failing_input` | 422 | `unprocessable` | data | API-2β | active | no | This input has failed repeatedly; try again later. |
| `research_schema_unsupported` | 422 | `unprocessable` | data | API-3 (pending C-5) | proposed | no | This kind of research question is not supported yet. |
| `rate_limited` | 429 | `rate_limit_error` | data | API-3 | active | no | Too many requests; retry after the indicated time. |
| `concurrency_limit` | 429 | `rate_limit_error` | data | API-3 | active | no | Too many concurrent jobs; retry after the indicated time. |
| `internal_error` | 500 | `api_error` | both | API-1a | active | yes | An internal error occurred. |
| `api_unavailable` | 503 | `service_unavailable` | both | API-1a | active | yes | The API is temporarily unavailable. |
| `queue_unavailable` | 503 | `service_unavailable` | data | API-3 | active | no | The service cannot accept jobs right now; retry. |
| `capacity_protection` | 503 | `service_unavailable` | data | CR-2 | active | no | The service is protecting capacity; retry. |
| `platform_spend_ceiling` | 503 | `service_unavailable` | data | API-2β | active | no | The service cannot accept jobs right now; retry. |
| `maintenance` | 503 | `service_unavailable` | data | API-3 | active | no | The service is under maintenance; retry. |

51 codes. `type` values: `invalid_request_error`, `authentication_error`, `billing_error`, `permission_error`, `not_found`, `idempotency_error`, `gone`, `request_too_large`, `unprocessable`, `rate_limit_error`, `api_error`, `service_unavailable` (the open enum of `openapi.yaml` `Error.type`; no new `type` is added).

### 2.1 Reconciliation decisions (C-4)

| # | Drift found | Contract decision | Side that must change |
|---|---|---|---|
| R-1 | PRD §9.5 and OpenAPI name the 404 `verification_not_found`; API-1a implements a generic `not_found` | **Both codes exist, one per plane.** Data-plane verification routes return `verification_not_found`. Management routes return `not_found`. Both are 404, `type: not_found`, message "Not found." A data-plane route never returns the generic `not_found` | **Implementation** (#327): add `verification_not_found` to `errors.ts` before the first data-plane verification route; keep `not_found` for management. PRD and OpenAPI unchanged |
| R-2 | PRD §9.5 lists specific 400 codes; API-1a implements only a generic `invalid_request` | Both are kept. `invalid_request` is the generic 400, always with `param`, used only where no specific code in §2 applies (§4.4). The specific codes are added in API-3 | Implementation adds the specific codes in API-3; no change in #327 |
| R-3 | OpenAPI `BadRequest` did not list every 400 code | Listed; `invalid_encoding`, `unknown_field`, `empty_input` added (C-3) | OpenAPI (this commit) |
| R-4 | `not_cancelable` (`jobs-and-idempotency.md` §6, OpenAPI) versus the audit's proposed `job_not_cancelable` | Keep `not_cancelable`. Its `type` is `invalid_request_error` (a state conflict, not an idempotency error) | None; the audit's name is not adopted |
| R-5 | Addendum 1 codes (`invalid_cursor`, `invalid_status`, `pipeline_processing_not_acknowledged`, `option_unavailable_in_beta`) are not in PRD §9.5 | In §2 with Addendum 1's statuses (400, 400, 403, 422) | PRD §9.5 points here (appended note); its ruling table is not rewritten |
| R-6 | PRD §9.5 says the 401 is a single code; the management plane has three 401 codes | The single-code rule is a data-plane rule and stands. `api_key_not_accepted` and `session_required` are management-plane only | None |
| R-7 | `errors.ts` `ApiErrorType` lacks `billing_error`, `idempotency_error`, `gone`, `request_too_large`, `unprocessable` | Each `type` is added with the first code that uses it, in that code's stage | Implementation, per stage |
| R-8 | Body encoding and media type were undefined | 415 `unsupported_media_type` (new) for a wrong media type or charset; 400 `invalid_encoding` (new) for bad bytes or characters; 400 `invalid_json` for syntax. **Why 415, not `invalid_json`:** a missing or wrong `Content-Type` is a client-configuration error, distinct from a malformed body, and RFC 9110 §15.5.16 defines 415 for exactly that case | OpenAPI (this commit); implementation in API-3 |
| R-9 | No management code for an unverified email (audit C-2) | `identity_not_verified` (403, `permission_error`, management only) is **reserved** for #327. **No `account_disabled` code:** a disabled Firebase account returns 401 `session_required`, identical to having no session, so the account's existence and state are not revealed | Implementation (#327) |
| R-10 | No code for a research schema the beta does not support (audit C-5) | `research_schema_unsupported` (422) is **proposed**, pending owner approval of the C-5 scope decision. It is an error code, not a section `availability` value; no new availability value (such as `not_available_in_beta`) is introduced | Owner decision first; then API-3 |

### 2.2 Notes per code

- `synthesis_not_supported`: `options.synthesis: true` on a claim, in the beta and after it. On a claim it takes precedence over `synthesis_unavailable`, because it is a permanent property of the type.
- `synthesis_unavailable`, `fallback_unavailable`: in the beta, every `true` value (Addendum 1 D4, P2). After the beta, returned when the provider that the option needs is not confirmed (PRD §21A P-9).
- `option_unavailable_in_beta`: `retain_input: true` (OQ-4) or `retain_model_responses: true` (P3) in the beta.
- `model_response_access_disabled`: after the beta only (OD-19 opt-in). In the beta, `retain_model_responses: true` is rejected first by `option_unavailable_in_beta` (§3, step 6), so this code is never returned.
- `payment_required`: Stripe API plans (API-2S) are excluded from the beta (D4).
- `too_few_models`, `model_limit_exceeded`: also the codes for the absolute 2..5 bounds of `models` (§4.4), not only the plan limit.
- `verification_deleted`: only for a verification of the caller's own organization and mode, including an idempotent replay of its create. Another organization's deleted verification returns 404 `verification_not_found`.
- `session_required`: includes a disabled Firebase account, an expired or revoked session, and an `auth_time` that is missing or in the future.
- `identity_not_verified`: the server-read Firebase user record has `emailVerified !== true`. Evaluated after the account is known to be enabled, and before anything specific to an organization (§3.2).
- `research_schema_unsupported`: proposed. Must be returned before job creation and before credit reservation, with nothing written (Addendum 2 §2).

Job-level outcomes are not HTTP errors on `GET`: they are `status` plus `failure.code` (PRD §9.5, unchanged). In the controlled beta, `status` is never `synthesizing` (D4).

## 3. Error precedence (normative, C-6)

A request gets **one** error: the first failing step below. Steps are evaluated in order; a later step is never evaluated before an earlier one has passed. 503 `api_unavailable` (the API is switched off, or a dependency a step needs has failed) and 500 `internal_error` can occur at any step, fail closed, write nothing and depend on no tenant data.

### 3.1 Data plane

| Step | Check | Codes |
|---|---|---|
| 0 | Global availability (no tenant data) | 503 `api_unavailable`, `maintenance` |
| 1 | Transport, from headers and the byte count only (the body is not decoded) | 413 `request_too_large`; 415 `unsupported_media_type` |
| 2 | Authentication | 401 `invalid_api_key` |
| 3 | Organization and plan state of the key's own organization | 403 `org_suspended`, then 403 `live_key_requires_plan` |
| 4 | Scope | 403 `insufficient_scope` |
| 5 | Decode and validate (§4): 5a bytes → 400 `invalid_encoding`; 5b JSON syntax → 400 `invalid_json`; 5c characters after parsing → 400 `invalid_encoding`; 5d NFC, then the schema in the order of §4.4. GET query parameters: 400 `invalid_cursor`, `invalid_status`, `invalid_request` | 400 (and the 422 bound codes of §4.4) |
| 6 | Beta-unavailable and type-invalid options, in member order `synthesis`, `allow_fallback`, `retain_input`, `retain_model_responses` | 422 `synthesis_not_supported` (claim), `synthesis_unavailable`, `fallback_unavailable`, `option_unavailable_in_beta` |
| 7 | Type and model availability: 7a type switched off → 422 `type_unavailable`; 7b research without the D6 acknowledgement → 403 `pipeline_processing_not_acknowledged`; 7c org model-response setting off (after the beta only) → 403 `model_response_access_disabled`; 7d → 422 `model_unavailable`; 7e plan model limit → 422 `model_limit_exceeded`; 7f → 422 `repeated_failing_input`; 7g (proposed) → 422 `research_schema_unsupported` | 422 / 403 |
| 8 | Request rate (before the create transaction) and the pre-write queue health check | 429 `rate_limited`; 503 `queue_unavailable` |
| 9 | Idempotency (first read inside the create transaction): a committed record returns the stored 202 replay (`Idempotent-Replayed: true`) or 410 `verification_deleted`, and evaluation stops | 409 `idempotency_key_reused`, `request_in_progress`; 410 |
| 10 | Concurrency (inside the transaction) | 429 `concurrency_limit` |
| 11 | Entitlement and credits (inside the transaction): transactional re-check of step 3 (same codes), then 403 `failed_job_threshold_exceeded`, then 402 `quota_exceeded`, `spend_limit_reached`, `payment_required` (future) | 403 / 402 |
| 12 | Capacity (inside the transaction) | 503 `capacity_protection`, `platform_spend_ceiling` |

`GET`, `DELETE` and `cancel` on `/verifications/{id}` run steps 0–4, then the tenant-bound lookup: a malformed, nonexistent or foreign ID → 404 `verification_not_found`; the caller's own deleted verification → 410 `verification_deleted`; `cancel` on a terminal job → 409 `not_cancelable`.

**Adjustments to the suggested order, with reasons:**
- **Encoding moved from step 1 to step 5.** Step 1 needs only headers and a byte count. Decoding and parsing the body before authentication would enlarge the unauthenticated parsing surface for no gain.
- **Rate limit (step 8) before idempotency (step 9).** The ruled create flow (`openapi.yaml` `createVerification`; `jobs-and-idempotency.md` §5) applies the rate limit before the create transaction, and idempotency is read inside it. So a replay consumes rate budget. Concurrency stays inside the transaction (step 10), as already designed.
- **Org state (step 3) before scope (step 4)** is the order API-1a implements (`lib/apiPlatform/principal.ts`).
- **Step 6 before step 7c**, so `retain_model_responses` in the beta always gets 422 `option_unavailable_in_beta`, never 403 (audit C-6). The 403 cannot reveal an organization setting that the beta does not use.
- **7g placement is provisional.** If the executed research schema is only known after a classification call to a provider, 7g cannot run before 7b (D6 acknowledgement). The C-5 decision must say how the schema is determined before reservation.

**Invariant (unchanged):** every non-2xx response to `POST /v1/verifications` creates no job, no ledger entry, no idempotency record and no provider call. The 202 replay is the only non-creating success.

### 3.2 Management plane

| Step | Check | Code |
|---|---|---|
| 1 | Any `Authorization: Bearer cpk_…` header, before the session is evaluated | 401 `api_key_not_accepted` |
| 2 | No valid session: absent, invalid, expired or revoked; `auth_time` missing or in the future; **Firebase account disabled** | 401 `session_required` |
| 3 | Email not verified (**reserved**, #327) | 403 `identity_not_verified` |
| 4 | Organization ID format invalid | 404 `not_found` (same body as step 5) |
| 5 | No active membership: not a member, removed, another organization, or no such organization | 404 `not_found` |
| 6 | Role lacks the capability | 403 `insufficient_role` |
| 7 | Capability needs a fresh session (≤ 15 min, `tenancy-and-auth.md` §3) | 403 `fresh_session_required` |
| 8 | Request body validation, only after authorization | 400 `invalid_request` |
| 9 | Resource inside the organization (an app or key of another organization, or none) | 404 `not_found` |

Role is checked before freshness, so a member without the capability is not asked to sign in again.

### 3.3 Privacy rules (both planes)

1. **Nothing that depends on another tenant's data is evaluated before authentication and tenant binding.** Steps before tenant binding (data plane 0–1; management 1–3) read only the request's own headers and bytes, the caller's own identity, and global state.
2. **A foreign ID returns the same 404 as a nonexistent one**, byte-identical except `request_id`; so does a malformed ID. A foreign deleted verification is 404, not 410.
3. **No error reveals whether a different organization exists.** A sibling, foreign or nonexistent `application_id` filter returns an identical empty list (Addendum 1 D9). Management non-membership and a nonexistent organization are both 404 `not_found`. A disabled account is indistinguishable from no session.
4. Idempotency records are scoped to `(organization, application, mode, key)`, so a key value can never match another tenant's request.
5. This design does not claim constant-time responses. Implementations must not add work that depends on another tenant's data before step 2 (data) or step 5 (management).

## 4. Request text and body rules (C-3)

### 4.1 Media type and encoding

- On a request with a body, the body must be `application/json` in UTF-8. `Content-Type: application/json` with no `charset`, or with `charset=utf-8` (case-insensitive), is accepted. A missing or different media type, or any other charset, is 415 `unsupported_media_type` (§2.1 R-8).
- Bytes that are not well-formed UTF-8 (including overlong forms and encoded surrogate code points) are 400 `invalid_encoding`.
- A byte-order mark, a JSON syntax error, trailing data after the top-level value, or a **duplicate member name** at any level is 400 `invalid_json`. Duplicate names are rejected so that no two components can read different values from the same body.
- A top-level value that is not an object is 400 `invalid_request`.
- After parsing, any string (member name or value) that contains a **lone surrogate** (for example an unpaired `\ud800` escape), or a **C0 control character other than tab (U+0009), LF (U+000A) and CR (U+000D)**, including an escaped `\u0000`, is 400 `invalid_encoding`. DEL (U+007F) and C1 controls are accepted in 0.3.0-draft.

### 4.2 Normalization and length units

- The server applies **Unicode NFC** to every string value in the body, server-side, after §4.1 and before any length check, schema check, hashing or processing.
- **Every length limit is counted in Unicode code points of the NFC form.** Not UTF-16 code units, not bytes, not grapheme clusters. (JSON Schema `minLength`/`maxLength` also count code points.) NFC can lengthen a string in rare cases; the limit applies to the NFC form.
- **Whitespace-only input text is rejected.** `input.claim` and `input.question` must contain at least one character outside Unicode White_Space (the ECMAScript `\s` set); otherwise 400 `empty_input`. The schema states this as `minLength: 1` plus `pattern: \S`. Trimming is used only for this check: the text processed is the NFC form, untrimmed. `input.context` may be empty.

### 4.3 Limits (all placeholders unless stated)

| Item | Limit | Over the limit |
|---|---|---|
| Request body | **65,536 bytes (64 KiB), placeholder pending owner sizing**, as received | 413 `request_too_large` (step 1) |
| `input.claim` | 1..4,000 code points (NFC), not whitespace-only | 400 `input_too_long` / `empty_input` |
| `input.question` | 1..4,000 code points (NFC), not whitespace-only | 400 `input_too_long` / `empty_input` |
| `input.context` | 0..20,000 code points (NFC); research only | 400 `input_too_long` |
| `models` | 2..5 unique items | 422 `too_few_models` / `model_limit_exceeded`; duplicate → 400 `invalid_model` |
| `models[]` item | 1..64 characters, pattern `^[a-z0-9][a-z0-9._-]{0,63}$` | 400 `invalid_model` |
| `metadata` | ≤ 20 keys; key 1..40 characters, pattern `^[A-Za-z0-9_.-]{1,40}$`; value a string of 0..500 code points (NFC) | 400 `invalid_request`, `param` `metadata` or `metadata.<key>` |
| `Idempotency-Key` | 1..255 printable ASCII (unchanged) | 400 `invalid_request`, `param` `Idempotency-Key` |

**Sizing input for the owner.** The body cap and the text limits interact. 24,000 code points of research text (4,000 + 20,000) take up to 96,000 bytes as raw 4-byte UTF-8, 72,000 bytes as 3-byte CJK text, or 144,000 bytes and more as `\uXXXX` escapes. So at 64 KiB a maximal-length research request in most non-Latin scripts is rejected with 413 before its text limits apply. The owner sizing decision must either raise the cap (for example to 128 KiB or 256 KiB) or accept this and document it. Until then, 413 governs: it is evaluated first (step 1).

### 4.4 Schema violations → codes

The create body is a union discriminated on `type` (`openapi.yaml` `CreateVerificationRequest`). Every object is closed. When a body has several violations, the server reports the first one in this order; `param` is the dotted path of the first offending member in lexical member order:

| Order | Violation | Code |
|---|---|---|
| a | Unknown top-level member (the top-level member set is the same for both types) | 400 `unknown_field` |
| b | `type` missing | 400 `missing_field`, `param` `type` |
| b | `type` not a string, or not `claim` / `research` | 400 `invalid_request`, `param` `type` |
| c1 | Unknown member in `input`, `options` (any level), for the selected type: `question` or `context` on a claim, `claim` on research | 400 `unknown_field` |
| c2 | `input` missing, or `input.claim` (claim) / `input.question` (research) missing | 400 `missing_field` |
| c3 | Wrong JSON type for a known member (for example a non-boolean option, a non-array `models`) | 400 `invalid_request` |
| c4 | Whitespace-only `input.claim` / `input.question` (`minLength`, `pattern`) | 400 `empty_input` |
| c5 | Text over its `maxLength` | 400 `input_too_long` |
| c6 | `models` item malformed or duplicated | 400 `invalid_model` |
| c7 | `models` fewer than 2 / more than 5 | 422 `too_few_models` / `model_limit_exceeded` |
| c8 | `metadata` rule | 400 `invalid_request` |

C0 controls and lone surrogates are found at step 5c, before the schema, so the schema's `NoControlCharacters` rule is never the reported cause; it is there so that a client-side validator agrees with the server.

### 4.5 Idempotency implication

The idempotency request hash (`jobs-and-idempotency.md` §5) is computed over the **canonical JSON of the NFC-normalized body** (sorted keys, no insignificant whitespace), only after step 5 passes. Two bodies that differ only in normalization form, member order or insignificant whitespace are the **same** request: the second gets the 202 replay, not 409. Bodies that differ in anything NFC preserves (for example full-width versus ASCII digits, or trailing whitespace inside a string) are **different** requests: the second gets 409 `idempotency_key_reused`. A rejected request stores nothing (unchanged).

## 5. Tests that pin this file

`docs/__tests__/apiOpenapiRequestContract.spec.ts`:
- compiles `CreateVerificationRequest` from the dereferenced `openapi.yaml` with Ajv (JSON Schema 2020-12, discriminator on) and checks that every positive request example validates and every negative example (`x-expected-error`) fails, plus a table of cross-type and limit cases;
- checks that the §2 table, `components.x-error-catalog` and the codes named in the OpenAPI response descriptions agree, and that each response description names only codes of its own HTTP status;
- checks that the 12 implemented API-1a codes appear in §2 with the same status and `type`, and that the PRD §9.5 and Addendum 1 codes appear with the same status.

What these tests do **not** cover: NFC normalization, code-point counting of NFC forms, lone surrogates and invalid UTF-8 are server behaviours that a schema validator cannot exercise on already-parsed YAML; they are API-3 implementation tests. `errors.ts` lives on the API-1a branch, so the spec pins the 12 codes as a literal list; #327 must add a test in `lib/` that pins `errors.ts` to this file.
