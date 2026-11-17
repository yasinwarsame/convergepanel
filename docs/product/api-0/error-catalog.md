# API error catalog, request text rules and error precedence (API-0, Addendum 2, amended by Addendum 3)

| | |
|---|---|
| **Status** | Design contract, 0.4.0-draft. Added by [Owner Decision Addendum 2](owner-decision-addendum-2.md) (2026-11-17) to resolve audit findings C-3, C-4 and C-6; amended by [Owner Decision Addendum 3](owner-decision-addendum-3.md) (2026-11-17, Quality Correction R2: m1–m6, the three reviewer exceptions, the body cap). **Not implemented and not active in Production.** 13 codes exist in the draft implementation on PR #327 (not merged); the API is dark, so **no code is returned by active Production** (§2, last column). |
| **Single source** | This file is the **only** list of error codes. PRD §9.5, the `openapi.yaml` response descriptions and `lib/apiPlatform/errors.ts` must agree with it. `openapi.yaml` mirrors §2 in `components.x-error-catalog`; `docs/__tests__/apiOpenapiRequestContract.spec.ts` pins the mirror, the OpenAPI response descriptions, every published error example, and the draft implementation snapshot `implementation-snapshots/api-1a-errors.json` (§2.3) to this table. |
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

- `reserved`: no code currently has this status (`identity_not_verified` left it in Addendum 3, m1).

**Three behaviours per code (Addendum 3, m1).** Each row distinguishes:
- **Contract message (fixed)**: the documented contract, the exact `message` string of the envelope. For every code present in the draft implementation it is identical to the implementation's string (test-pinned, §2.3).
- **Draft implementation (#327 @ `fa9146a`)**: `yes` when `lib/apiPlatform/errors.ts` at commit `fa9146aef8b1513225f487f8ad8b7723f95b8a95` of the unmerged PR #327 defines the code with this HTTP status, `type` and message. A draft implementation is not a release: it authorizes nothing and is not running anywhere a customer can reach.
- **Active Production**: what the live service returns today. It is `none` for every code: no API route, host or credential exists in Production (the API is dark; PRD Rev 4, Addendum 1 D2). This column changes only by a separately authorized release.

| Code | HTTP | `type` | Plane | Stage | Beta status | Contract message (fixed) | Draft implementation (#327 @ `fa9146a`) | Active Production |
|---|---|---|---|---|---|---|---|---|
| `invalid_request` | 400 | `invalid_request_error` | both | API-1a | active | The request is invalid. | yes | none |
| `invalid_json` | 400 | `invalid_request_error` | data | API-3 | active | The request body is not valid JSON. | no | none |
| `invalid_encoding` | 400 | `invalid_request_error` | data | API-3 | active | The request body contains characters that are not allowed. | no | none |
| `missing_field` | 400 | `invalid_request_error` | data | API-3 | active | A required field is missing. | no | none |
| `unknown_field` | 400 | `invalid_request_error` | data | API-3 | active | The request contains a field that is not recognized. | no | none |
| `empty_input` | 400 | `invalid_request_error` | data | API-3 | active | The input text is empty. | no | none |
| `input_too_long` | 400 | `invalid_request_error` | data | API-3 | active | The input text is too long. | no | none |
| `invalid_model` | 400 | `invalid_request_error` | data | API-3 | active | A model ID is not valid. | no | none |
| `invalid_cursor` | 400 | `invalid_request_error` | data | API-3 | active | The pagination cursor is not valid. | no | none |
| `invalid_status` | 400 | `invalid_request_error` | data | API-3 | active | The status filter is not valid. | no | none |
| `invalid_api_key` | 401 | `authentication_error` | data | API-1a | active | The API key is invalid. | yes | none |
| `api_key_not_accepted` | 401 | `authentication_error` | management | API-1a | active | API keys are not accepted on this endpoint. | yes | none |
| `session_required` | 401 | `authentication_error` | management | API-1a | active | A signed-in session is required. | yes | none |
| `quota_exceeded` | 402 | `billing_error` | data | API-2β | active | The credit quota for this period is used up. | no | none |
| `spend_limit_reached` | 402 | `billing_error` | data | API-2β | active | The organization spend limit has been reached. | no | none |
| `payment_required` | 402 | `billing_error` | data | API-2S | future | A payment is required to continue. | no | none |
| `insufficient_scope` | 403 | `permission_error` | data | API-1a | active | The API key does not have the required scope. | yes | none |
| `org_suspended` | 403 | `permission_error` | data | API-1a | active | The organization is suspended. | yes | none |
| `live_key_requires_plan` | 403 | `permission_error` | data | API-1a | active | Live keys require an active API plan. | yes | none |
| `failed_job_threshold_exceeded` | 403 | `permission_error` | data | API-2β | active | Too many failed jobs; live creates are paused. | no | none |
| `model_response_access_disabled` | 403 | `permission_error` | data | post-beta (OD-19) | future | Model response access is not enabled for this organization. | no | none |
| `pipeline_processing_not_acknowledged` | 403 | `permission_error` | data | API-3 | active | Research requires a recorded pipeline-processing acknowledgement. | no | none |
| `insufficient_role` | 403 | `permission_error` | management | API-1a | active | Your organization role does not allow this action. | yes | none |
| `fresh_session_required` | 403 | `permission_error` | management | API-1a | active | Sign in again to perform this action. | yes | none |
| `identity_not_verified` | 403 | `permission_error` | management | API-1a | active | Verify your email address to perform this action. | yes | none |
| `verification_not_found` | 404 | `not_found` | data | API-3 | active | Not found. | no | none |
| `not_found` | 404 | `not_found` | management | API-1a | active | Not found. | yes | none |
| `idempotency_key_reused` | 409 | `idempotency_error` | data | API-3 | active | This idempotency key was used with a different request. | no | none |
| `request_in_progress` | 409 | `idempotency_error` | data | API-3 | active | A request with this idempotency key is in progress; retry. | no | none |
| `not_cancelable` | 409 | `invalid_request_error` | data | API-3 | active | The verification can no longer be canceled. | no | none |
| `verification_deleted` | 410 | `gone` | data | API-3 | active | The verification was deleted. | no | none |
| `request_too_large` | 413 | `request_too_large` | data | API-3 | active | The request body is too large. | no | none |
| `unsupported_media_type` | 415 | `invalid_request_error` | data | API-3 | active | The request body must be UTF-8 application/json. | no | none |
| `model_unavailable` | 422 | `unprocessable` | data | API-3 | active | A selected model is not available. | no | none |
| `too_few_models` | 422 | `unprocessable` | data | API-3 | active | Select at least two models. | no | none |
| `model_limit_exceeded` | 422 | `unprocessable` | data | API-3 | active | Too many models are selected. | no | none |
| `type_unavailable` | 422 | `unprocessable` | data | API-3 | active | This verification type is not available. | no | none |
| `synthesis_not_supported` | 422 | `unprocessable` | data | API-3 | active | Synthesis is not supported for claims. | no | none |
| `synthesis_unavailable` | 422 | `unprocessable` | data | API-3 | beta-rejection | Synthesis is not available. | no | none |
| `fallback_unavailable` | 422 | `unprocessable` | data | API-3 | beta-rejection | Provider fallback is not available. | no | none |
| `option_unavailable_in_beta` | 422 | `unprocessable` | data | API-3 | beta-rejection | This option is not available in the beta. | no | none |
| `repeated_failing_input` | 422 | `unprocessable` | data | API-2β | active | This input has failed repeatedly; try again later. | no | none |
| `research_schema_unsupported` | 422 | `unprocessable` | data | API-3 (pending C-5) | proposed | This kind of research question is not supported yet. | no | none |
| `rate_limited` | 429 | `rate_limit_error` | data | API-3 | active | Too many requests; retry after the indicated time. | no | none |
| `concurrency_limit` | 429 | `rate_limit_error` | data | API-3 | active | Too many concurrent jobs; retry after the indicated time. | no | none |
| `internal_error` | 500 | `api_error` | both | API-1a | active | An internal error occurred. | yes | none |
| `api_unavailable` | 503 | `service_unavailable` | both | API-1a | active | The API is temporarily unavailable. | yes | none |
| `queue_unavailable` | 503 | `service_unavailable` | data | API-3 | active | The service cannot accept jobs right now; retry. | no | none |
| `capacity_protection` | 503 | `service_unavailable` | data | CR-2 | active | The service is protecting capacity; retry. | no | none |
| `platform_spend_ceiling` | 503 | `service_unavailable` | data | API-2β | active | The service cannot accept jobs right now; retry. | no | none |
| `maintenance` | 503 | `service_unavailable` | data | API-3 | active | The service is under maintenance; retry. | no | none |

51 codes; 13 in the draft implementation; none in active Production. `type` values: `invalid_request_error`, `authentication_error`, `billing_error`, `permission_error`, `not_found`, `idempotency_error`, `gone`, `request_too_large`, `unprocessable`, `rate_limit_error`, `api_error`, `service_unavailable` (the open enum of `openapi.yaml` `Error.type`; no new `type` is added).

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
| R-9 | No management code for an unverified email (audit C-2) | `identity_not_verified` (403, `permission_error`, management only) is **reserved** for #327 *(Addendum 3: now implemented in the #327 draft; see R-11)*. **No `account_disabled` code:** a disabled Firebase account returns 401 `session_required`, identical to having no session, so the account's existence and state are not revealed | Implementation (#327) |
| R-11 | *(Addendum 3, m1)* The catalog lagged #327: `identity_not_verified` was `reserved` here but is implemented in the #327 draft, and its message differed ("…to manage API organizations." here, "…to perform this action." in `errors.ts`) | **The implementation's text is adopted:** "Verify your email address to perform this action." It is correct (it names the remedy), reveals no organization context, and matches the wording of `fresh_session_required`. Beta status `reserved` → `active`, stage API-1a. The other 12 implemented codes already agreed in status, `type` and message | Catalog (this commit). Drift is now detected automatically (§2.3) |
| R-10 | No code for a research schema the beta does not support (audit C-5) | `research_schema_unsupported` (422) is **proposed**, pending owner approval of the C-5 scope decision. It is an error code, not a section `availability` value; no new availability value (such as `not_available_in_beta`) is introduced | Owner decision first; then API-3 |

### 2.2 Notes per code

- `synthesis_not_supported`: `options.synthesis: true` on a claim, in the beta and after it. On a claim it takes precedence over `synthesis_unavailable`, because it is a permanent property of the type.
- `synthesis_unavailable`, `fallback_unavailable`: in the beta, every `true` value (Addendum 1 D4, P2). After the beta, returned when the provider that the option needs is not confirmed (PRD §21A P-9).
- `option_unavailable_in_beta`: `retain_input: true` (OQ-4) or `retain_model_responses: true` (P3) in the beta.
- `model_response_access_disabled`: after the beta only (OD-19 opt-in). In the beta, `retain_model_responses: true` is rejected first by `option_unavailable_in_beta` (§3.1, step 9; step 6 before Addendum 3), so this code is never returned.
- `payment_required`: Stripe API plans (API-2S) are excluded from the beta (D4).
- `too_few_models`, `model_limit_exceeded`: also the codes for the absolute 2..5 bounds of `models` (§4.4), not only the plan limit.
- `verification_deleted`: only for a verification of the caller's own organization and mode, including an idempotent replay of its create. Another organization's deleted verification returns 404 `verification_not_found`.
- `session_required`: includes a disabled Firebase account, an expired or revoked session, and an `auth_time` that is missing or in the future.
- `identity_not_verified`: the server-read Firebase user record has `emailVerified !== true`. Evaluated after the account is known to be enabled, and before anything specific to an organization (§3.2). Implemented in the #327 draft (Addendum 3, m1).
- `rate_limited`: every data-plane operation, from the pre-authentication flood limit or the authenticated per-key and per-organization limits (§3.4). Always with `Retry-After`. A replay may receive it; it never writes anything.
- `empty_input`: also text with no visible code point (§4.2, Addendum 3, m4), not only whitespace-only text.
- `invalid_encoding`: also DEL (U+007F) and the C1 controls U+0080..U+009F (Addendum 3, reviewer exception 2).
- `research_schema_unsupported`: proposed. Must be returned before job creation and before credit reservation, with nothing written (Addendum 2 §2).

Job-level outcomes are not HTTP errors on `GET`: they are `status` plus `failure.code` (PRD §9.5, unchanged). In the controlled beta, `status` is never `synthesizing` (D4).

### 2.3 Drift detection against the implementation (Addendum 3, m1)

`implementation-snapshots/api-1a-errors.json` is a machine-generated snapshot of `API_ERRORS` in `lib/apiPlatform/errors.ts` at the recorded PR and full commit SHA: `{ source, pr, commit, codes: { <code>: { status, type, message } } }`, codes sorted. It is produced by `implementation-snapshots/generate-api-1a-errors.cjs <commit>`, which reads the real file with `git show`, transpiles it with the declared `typescript` dependency and evaluates it in an isolated context; it is never edited by hand.

- **This repository** (`apiOpenapiRequestContract.spec.ts`): every snapshot code is in §2 with the identical status, `type` and message, and is marked `yes` in the draft-implementation column; every code marked `yes` is in the snapshot.
- **PR #327** carries the mirror test, which pins `errors.ts` to an identical snapshot. After the restack both copies coexist, so a change on either side fails a test until the other side is updated in the same PR.
- Refreshing the snapshot (a new #327 head) is a reviewed change: regenerate, then reconcile §2 in the same commit.

## 3. Error precedence (normative, C-6)

A request gets **one** error: the first failing step below. Steps are evaluated in order; a later step is never evaluated before an earlier one has passed. 503 `api_unavailable` (the API is switched off, or a dependency a step needs has failed) and 500 `internal_error` can occur at any step, fail closed, write nothing and depend on no tenant data.

### 3.1 Data plane

*Addendum 3 (m2, m3) replaces the Addendum 2 order.* Authentication and the authenticated rate limit now come before any body decoding; the idempotency record is read first inside T-create, after the key and organization are re-checked, and a committed record is answered **before** every new-job-only check. Full procedure, transaction ordering, truth table and concurrency argument: `jobs-and-idempotency.md` §5A.

**`POST /v1/verifications`**

| Step | Check | Codes |
|---|---|---|
| 0 | Global availability (no tenant data) | 503 `api_unavailable`, `maintenance` |
| 1 | Transport, from headers and the byte count only (the body is not decoded): `Content-Length` over the cap, or the streamed byte count passing it, stops reading at once | 413 `request_too_large`; 415 `unsupported_media_type` |
| 2 | Pre-authentication flood limit per source address (§3.4); reads no tenant data | 429 `rate_limited` |
| 3 | Authentication | 401 `invalid_api_key` |
| 4 | Authenticated request rate: per key, then per organization (§3.4). Replays count | 429 `rate_limited` |
| 5 | Organization and plan state of the key's own organization | 403 `org_suspended`, then 403 `live_key_requires_plan` |
| 6 | Scope | 403 `insufficient_scope` |
| 7 | Decode and validate (§4): 7a bytes → 400 `invalid_encoding`; 7b JSON syntax → 400 `invalid_json`; 7c characters after parsing → 400 `invalid_encoding`; 7d NFC, then the schema in the order of §4.4; `Idempotency-Key` format, and its presence for a live key → 400 `invalid_request`. Then the canonical request is computed (§4.5) | 400 (and the 422 bound codes of §4.4) |
| 8 | **T-create begins.** 8a lock and read the idempotency record (first read); contention retries exhausted → 409 `request_in_progress`. 8b re-read the key and the organization and repeat steps 3, 5, 6 (a revocation, suspension or scope change that committed meanwhile wins; **no replay is returned to a caller that fails here**). 8c an unexpired record decides and evaluation **stops**: same canonical request → the stored 202 replay (`Idempotent-Replayed: true`); different → 409 `idempotency_key_reused`; deleted marker → 410 `verification_deleted` | 401 / 403; 409; 410; 202 replay |
| 9 | *New job only.* Beta-unavailable and type-invalid options, in member order `synthesis`, `allow_fallback`, `retain_input`, `retain_model_responses` | 422 `synthesis_not_supported` (claim), `synthesis_unavailable`, `fallback_unavailable`, `option_unavailable_in_beta` |
| 10 | *New job only.* Type and model availability: 10a type switched off → 422 `type_unavailable`; 10b research without the D6 acknowledgement → 403 `pipeline_processing_not_acknowledged`; 10c org model-response setting off (after the beta only) → 403 `model_response_access_disabled`; 10d → 422 `model_unavailable`; 10e plan model limit → 422 `model_limit_exceeded`; 10f → 422 `repeated_failing_input`; 10g (proposed) → 422 `research_schema_unsupported` | 422 / 403 |
| 11 | *New job only.* Queue health (read inside the transaction callback; nothing is written) | 503 `queue_unavailable` |
| 12 | *New job only.* Concurrency | 429 `concurrency_limit` |
| 13 | *New job only.* Entitlement and credits: 403 `failed_job_threshold_exceeded`, then 402 `quota_exceeded`, `spend_limit_reached`, `payment_required` (future) | 403 / 402 |
| 14 | *New job only.* Capacity | 503 `capacity_protection`, `platform_spend_ceiling` |
| 15 | Write the job, the reservation and the idempotency record in the same commit; dispatch after commit | 202 |

**`GET`, `DELETE` and `POST …/cancel` on `/verifications/{id}`, `GET /verifications/{id}/report`, `GET /verifications/{id}/models`, `GET /verifications` (list), `GET /usage`, `GET /models`**

| Step | Check | Codes |
|---|---|---|
| 0 | Global availability | 503 `api_unavailable`, `maintenance` |
| 1 | Transport: a `GET` or `DELETE` body is not read; a `cancel` body over the cap → 413 | 413 |
| 2 | Pre-authentication flood limit per source address | 429 `rate_limited` |
| 3 | Authentication | 401 `invalid_api_key` |
| 4 | Authenticated request rate, per key then per organization, in the operation's class (§3.4: `read`, `list` or `write`). **Decided before the path ID or any query parameter is examined**, from the caller's own buckets only | 429 `rate_limited` |
| 5 | Organization and plan state | 403 `org_suspended`, `live_key_requires_plan` |
| 6 | Scope of the operation | 403 `insufficient_scope` |
| 7 | Query parameters (list): 400 `invalid_cursor`, `invalid_status`, `invalid_request` | 400 |
| 8 | Tenant-bound lookup: a malformed, nonexistent or foreign ID → 404 `verification_not_found`; the caller's own deleted verification → 410 `verification_deleted`; `cancel` on a terminal job → 409 `not_cancelable` | 404 / 410 / 409 |

**Adjustments, with reasons:**
- **Transport (step 1) stays first.** It needs only headers and a byte count, rejects an oversized body before it is read in full, and reads no tenant data. Decoding and parsing the body before authentication would enlarge the unauthenticated parsing surface for no gain, so decoding is step 7.
- **Rate limit (step 4) immediately after authentication**, before the organization read and before the body is decoded (Addendum 3, m2). Decoding, NFC normalization and schema validation of up to 524,288 bytes are the expensive part of request handling; a flooding key is throttled before any of it. The check is one Redis-class increment on the caller's own buckets.
- **Idempotency (step 8) before every new-job-only check** (Addendum 3, m3). A dynamic condition that changed after the original request (model availability, credits, queue health, plan limits, concurrency, capacity, beta options, the D6 acknowledgement) applies only to a request that would create a job, so an accepted request's replay is never turned into an error or a duplicate job. The rate limit (step 4) may still throttle a replay; that writes nothing and the next retry replays.
- **Authorization is evaluated twice:** before the body is decoded (steps 3–6) and again inside T-create (8b), so a revocation or suspension that commits between the two is honoured, and a revoked key never obtains a replay.
- **Org state (step 5) before scope (step 6)** is the order API-1a implements (`lib/apiPlatform/principal.ts`).
- **Step 9 before step 10c**, so `retain_model_responses` in the beta always gets 422 `option_unavailable_in_beta`, never 403 (audit C-6).
- **10g placement is provisional.** The classifier versus pre-reservation conflict is unresolved (Addendum 3 §1, ruling on C-5); no placement of 10g is approved.

**Reviewer exception 1 (Addendum 3): `options.synthesis: true` is schema-valid by design.** It is rejected at step 9 as a semantic, release-stage rule (422), not by the schema: a schema rejection would be a 400 at step 7, contradicting the documented 422 (PRD §9.5, Addendum 1 D4), and the schema would have to change when the beta exclusion ends. Because step 9 is a new-job-only check, the precedence is well defined: an unexpired committed record for the same canonical request replays before it, which cannot occur in the beta (no such request is ever accepted there).

**Invariant (unchanged):** every non-2xx response to `POST /v1/verifications` creates no job, no ledger entry, no idempotency record and no provider call. The 202 replay is the only non-creating success.

### 3.2 Management plane

| Step | Check | Code |
|---|---|---|
| 1 | Any `Authorization: Bearer cpk_…` header, before the session is evaluated | 401 `api_key_not_accepted` |
| 2 | No valid session: absent, invalid, expired or revoked; `auth_time` missing or in the future; **Firebase account disabled** | 401 `session_required` |
| 3 | Email not verified (implemented in the #327 draft) | 403 `identity_not_verified` |
| 4 | Organization ID format invalid | 404 `not_found` (same body as step 5) |
| 5 | No active membership: not a member, removed, another organization, or no such organization | 404 `not_found` |
| 6 | Role lacks the capability | 403 `insufficient_role` |
| 7 | Capability needs a fresh session (≤ 15 min, `tenancy-and-auth.md` §3) | 403 `fresh_session_required` |
| 8 | Request body validation, only after authorization | 400 `invalid_request` |
| 9 | Resource inside the organization (an app or key of another organization, or none) | 404 `not_found` |

Role is checked before freshness, so a member without the capability is not asked to sign in again.

### 3.3 Privacy rules (both planes)

1. **Nothing that depends on another tenant's data is evaluated before authentication and tenant binding.** Steps before tenant binding (data plane 0–2; management 1–3) read only the request's own headers and bytes, the caller's own identity, and global state.
2. **A foreign ID returns the same 404 as a nonexistent one**, byte-identical except `request_id`; so does a malformed ID. A foreign deleted verification is 404, not 410.
3. **No error reveals whether a different organization exists.** A sibling, foreign or nonexistent `application_id` filter returns an identical empty list (Addendum 1 D9). Management non-membership and a nonexistent organization are both 404 `not_found`. A disabled account is indistinguishable from no session.
4. Idempotency records are scoped to `(organization, application, mode, key)`, so a key value can never match another tenant's request.
5. This design does not claim constant-time responses. Implementations must not add work that depends on another tenant's data before step 3 (data) or step 5 (management).
6. **A 429 reveals nothing about a resource** (Addendum 3, m2). Every rate decision is made from the caller's own buckets (source address, key, organization) before the path ID, query or body is examined, so a 429 for a foreign ID is byte-identical (except `request_id` and the `RateLimit-*` / `Retry-After` values, which depend only on the caller's buckets) to a 429 for a nonexistent ID. Lookups never consume a bucket that depends on the ID.

### 3.4 Rate limits (Addendum 3, m2)

All numbers are **placeholders** (set per plan in `lib/apiPlatform/apiPlans.ts`, compile-time, OD-21), stated so that implementation and tests have concrete values. Windows are sliding 60 s windows in the Redis-class store (OD-5).

| Layer | Bucket | Limit (placeholder) | Applies to | Step |
|---|---|---|---|---|
| Pre-authentication flood limit | source address (edge-reported client IP; IPv6 by /64) | 600 requests / min, all data-plane routes together | every request, before the key is looked at | 2 |
| Pre-authentication failed-auth limit | source address | 30 failed authentications / min; then every request from the address gets 429 until the window clears | requests from an address that recently sent invalid keys | 2 |
| Per key, `create` | API key | 60 / min (PRD §9.3) | `POST /verifications` (new and replay) | 4 |
| Per key, `write` | API key | 60 / min | `DELETE /verifications/{id}`, `POST …/cancel` | 4 |
| Per key, `read` (poll) | API key | 600 / min (`jobs-and-idempotency.md` §7) | `GET /verifications/{id}`, `/report`, `/models`, `GET /usage`, `GET /models` | 4 |
| Per key, `list` | API key | 120 / min | `GET /verifications` | 4 |
| Per organization (all keys) | organization | 5 × the per-key limit of each class | the same classes, summed over the organization's keys | 4 |

- **Response.** 429 `rate_limited` with `Retry-After` (seconds until the bucket admits one request) and `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` for the bucket that refused. The body is the fixed envelope; producing it reads nothing but the bucket.
- **Inexpensive and bounded.** Steps 2 and 4 are one Redis-class increment each, made before any Firestore read (step 2) or any body decoding (step 4). A refused request is not parsed. The pre-authentication limit cannot reveal key validity: once the failed-auth limit trips, valid and invalid keys from that address get the same 429.
- **Store unavailable.** If the Redis-class store is unreachable, `POST /verifications`, `DELETE` and `cancel` fail closed with 503 `api_unavailable`; reads continue under a conservative per-instance limit (PRD §9.3).
- **Replays.** A replay counts against the `create` bucket. A throttled replay writes nothing and creates nothing (§3.1 step 4); its retry replays the original 202.
- **Concurrency is separate.** 429 `concurrency_limit` (running jobs per organization) is a new-job-only check inside T-create (step 12), never applied to a replay.


## 4. Request text and body rules (C-3)

### 4.1 Media type and encoding

- On a request with a body, the body must be `application/json` in UTF-8. `Content-Type: application/json` with no `charset`, or with `charset=utf-8` (case-insensitive), is accepted. A missing or different media type, or any other charset, is 415 `unsupported_media_type` (§2.1 R-8).
- Bytes that are not well-formed UTF-8 (including overlong forms and encoded surrogate code points) are 400 `invalid_encoding`.
- A byte-order mark, a JSON syntax error, trailing data after the top-level value, or a **duplicate member name** at any level is 400 `invalid_json`. Duplicate names are rejected so that no two components can read different values from the same body.
- A top-level value that is not an object is 400 `invalid_request`.
- After parsing, any string (member name or value) that contains a **lone surrogate** (for example an unpaired `\ud800` escape), a **C0 control character other than tab (U+0009), LF (U+000A) and CR (U+000D)**, including an escaped `\u0000`, **DEL (U+007F)** or a **C1 control (U+0080..U+009F)** is 400 `invalid_encoding`.
- *Addendum 3 (reviewer exception 2):* 0.3.0-draft accepted DEL and the C1 controls. That was a weakness, not intended behaviour: DEL and C1 are general category `Cc` exactly like C0, carry no text meaning in JSON text fields, and C1 includes NEL (U+0085), which some systems treat as a line break, so accepting it lets two components split the same text differently. They are now rejected with C0. Tab, LF and CR remain allowed. Regression tests: `apiOpenapiRequestContract.spec.ts` "rejects: claim with DEL", "…NEL (C1)", "…U+009F (C1)".

### 4.2 Normalization and length units

- The server applies **Unicode NFC** to every string value in the body, server-side, after §4.1 and before any length check, schema check, hashing or processing.
- **Every length limit is counted in Unicode code points of the NFC form.** Not UTF-16 code units, not bytes, not grapheme clusters. (JSON Schema `minLength`/`maxLength` also count code points.) NFC can lengthen a string in rare cases; the limit applies to the NFC form.
- **Input text must have visible content** (Addendum 3, m4; replaces the Addendum 2 whitespace-only rule, which accepted text made only of zero-width characters). After NFC, `input.claim` and `input.question` must contain **at least one visible code point**: a code point that is
  - not `White_Space`,
  - not `Default_Ignorable_Code_Point`, and
  - not of general category `Cc`, `Cf`, `Cs`, `Zs`, `Zl`, `Zp`, `Mn`, `Mc` or `Me`.

  Otherwise 400 `empty_input`. This rejects, among others, text made only of: ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, WJ U+2060, BOM U+FEFF, Mongolian vowel separator U+180E, soft hyphen U+00AD, combining grapheme joiner U+034F, Arabic letter mark U+061C, bidi controls (U+200E, U+200F, U+202A..U+202E, U+2066..U+2069), variation selectors (U+FE00..U+FE0F, U+E0100..U+E01EF), tag characters (U+E0000..U+E007F), Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), interlinear annotation controls, and combining marks.

  **Combining marks.** A string made only of combining marks (`Mn`, `Mc`, `Me`) is rejected: a mark with no base character is not text on its own (it renders on a dotted circle), and every real use of a mark is attached to a base, which makes the string pass. Spacing marks (`Mc`) are treated like nonspacing ones for the same reason. A mark **anywhere** next to at least one visible code point is accepted; the rule does not require the base to precede the mark.

  **Nothing is stripped or rewritten.** The rule is a check only. Valid combining sequences (`e` + U+0301, which NFC composes to `é` exactly as before), ZWJ emoji sequences (👩‍💻), ZWNJ inside Persian or Hindi words, a variation selector after its base (❤️), and bidi controls inside real text are all accepted and processed in their NFC form, unchanged.

  **Deliberately accepted edge cases.** Private-use (`Co`) and unassigned (`Cn`, other than the default-ignorable ranges) code points count as visible: they may be meaningful to the sender, or assigned in a newer Unicode version than the server's, and rejecting them would break legitimate text. U+2800 BRAILLE PATTERN BLANK (`So`) counts as visible: it is a graphic Braille character, not a format character. The owner may narrow either case later (an additive tightening is a breaking change, PRD §8.7).

  The schema states the rule as `minLength: 1` plus `pattern: '[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Cs}\p{Z}\p{M}]'`, which requires a validator that evaluates patterns in ECMAScript Unicode mode (`u` flag), as JSON Schema 2020-12 validators such as Ajv 8 do by default; a validator without Unicode property escapes cannot check it client-side, and the server check is authoritative. `input.context` may be empty, or have no visible content (an invisible context is equivalent to an empty one and is processed as sent). Metadata values are not subject to this rule.

### 4.3 Limits (all placeholders unless stated)

| Item | Limit | Over the limit |
|---|---|---|
| Request body | **524,288 bytes (512 KiB)**, owner-approved (Addendum 3, B); counted as received, from `Content-Length` when present and from the streamed byte count otherwise, **before any JSON parsing** | 413 `request_too_large` (step 1) |
| `input.claim` | 1..4,000 code points (NFC), with at least one visible code point (§4.2) | 400 `input_too_long` / `empty_input` |
| `input.question` | 1..4,000 code points (NFC), with at least one visible code point (§4.2) | 400 `input_too_long` / `empty_input` |
| `input.context` | 0..20,000 code points (NFC); research only | 400 `input_too_long` |
| `models` | 2..5 unique items | 422 `too_few_models` / `model_limit_exceeded`; duplicate → 400 `invalid_model` |
| `models[]` item | 1..64 characters, pattern `^[a-z0-9][a-z0-9._-]{0,63}$` | 400 `invalid_model` |
| `metadata` | ≤ 20 keys; key 1..40 characters, pattern `^[A-Za-z0-9_.-]{1,40}$`; value a string of 0..500 code points (NFC); *Addendum 3:* **aggregate** ≤ 4,000 code points, summed over every key and every value (NFC), placeholder | 400 `invalid_request`, `param` `metadata` or `metadata.<key>` |
| `Idempotency-Key` | 1..255 printable ASCII (unchanged) | 400 `invalid_request`, `param` `Idempotency-Key` |

The body cap is checked first (step 1) and never raised because the infrastructure would allow it (Vercel's own request limit is 4.5 MB). The field limits above stay strict: a body under the cap whose fields exceed their limits still fails at step 7.

#### 4.3.1 Body-cap sizing evidence (Addendum 3, B)

The table is produced by `docs/__tests__/apiRequestBodySizing.spec.ts`, which **builds** each request literally, checks that it is legal (valid JSON; after NFC, question 4,000 and context 20,000 code points exactly; metadata at its worst legal layout under the per-key, per-value and aggregate limits; 5 model IDs of 64 characters; every option present; the contract schema accepts it) and measures its byte length. The spec fails if this table differs from the computation. No insignificant whitespace is included: JSON allows any amount of it, so a client can always exceed any cap with padding, and 413 is the correct answer to that. Non-NFC tiers are computed with Unicode 17.0 (Node's ICU); the spec compares them exactly only on a runtime with that Unicode version.

Worst raw cost per **counted** code point (limits count the NFC form): an exhaustive scan of every code point finds that NFC-stable text costs at most 12 bytes per code point (a surrogate-pair escape `\uD83D\uDE00`). Non-NFC input can carry several raw code points per counted one: the maximal canonical decomposition has 4 code points (for example U+1F82), and the most expensive is U+16D6A (KIRAT RAI), whose decomposition is three supplementary code points, 36 bytes when escaped (12 bytes as raw UTF-8). Upper bound used: raw code points ≤ length of NFD(raw) = Σ over the NFC code points of len(NFD(c)), and a multi-code-point raw element never costs more per decomposed element than a single-code-point equivalent; the spec constructs the bound, so it is attained.

| Tier | Text encoding | Counted text | Bytes | Of 524,288 | Verdict |
|---|---|---|---|---|---|
| T1 | NFC, ASCII | 24,000 | 28,640 | 5.46% | fits |
| T2 | NFC, CJK (3-byte UTF-8) | 24,000 | 84,596 | 16.14% | fits |
| T3 | NFC, supplementary (4-byte UTF-8) | 24,000 | 112,574 | 21.47% | fits |
| T4 | NFC, BMP `\uXXXX` escapes | 24,000 | 170,790 | 32.58% | fits |
| T5 | NFC, surrogate-pair escapes (12 bytes per code point) | 24,000 | 338,658 | 64.59% | fits |
| T6 | non-NFC, raw UTF-8 (decomposed, 12 bytes per counted code point) | 24,000 | 336,458 | 64.17% | fits |
| T7 | non-NFC, escaped (decomposed U+16D6A, 36 bytes per counted code point) | 24,000 | 1,010,418 | 192.72% | exceeds |

**Verdict.** 512 KiB is **sufficient** for every legal request whose strings are NFC, in any JSON encoding (worst 338,658 bytes, 64.59% of the cap), and for non-NFC requests sent as raw UTF-8 (336,458 bytes). It is **insufficient** for a legal request whose text is both decomposed (non-NFC) and fully `\u`-escaped: up to 1,010,418 bytes, 192.72% of the cap. It is not grossly excessive: the cap is 1.55 × the largest NFC request.

**OWNER DECISION REQUIRED** (Addendum 3 §4, item 1). Options, each with its effect, no option chosen here:
- **(a) Also bound raw code points.** Count every text limit on the received (pre-NFC) string as well as on its NFC form. Worst legal body becomes T5 (338,658 bytes): fits. Effect: a decomposed request near the limit is rejected with 400 `input_too_long` although its NFC form fits.
- **(b) Reject non-NFC input.** 400 for any string that is not already NFC. Worst becomes T5: fits. Effect: rejects legitimate text from clients that send NFD (for example some macOS and input-method paths) that the current contract accepts.
- **(c) Raise the cap** to at least 1,010,418 bytes (about 987 KiB). Effect: doubles the unauthenticated-read and authenticated-parse budget, and the bound grows again if a future Unicode version adds longer decompositions.
- **(d) Keep 512 KiB and document the boundary.** A decomposed and fully escaped body over 524,288 bytes gets 413 although its NFC form is within the field limits; every NFC or unescaped request is guaranteed to fit.

Until the owner decides, the approved 524,288-byte cap applies and step 1 (413) governs, which is the documented precedence; nothing else changes.

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
| c4 | `input.claim` / `input.question` with no visible code point (§4.2; `minLength`, `pattern`) | 400 `empty_input` |
| c5 | Text over its `maxLength` | 400 `input_too_long` |
| c6 | `models` item malformed or duplicated | 400 `invalid_model` |
| c7 | `models` fewer than 2 / more than 5 | 422 `too_few_models` / `model_limit_exceeded` |
| c8 | `metadata` rule | 400 `invalid_request` |

C0, DEL and C1 controls and lone surrogates are found at step 7c, before the schema, so the schema's `NoControlCharacters` rule is never the reported cause; it is there so that a client-side validator agrees with the server.

### 4.5 Idempotency implication

The idempotency request hash (`jobs-and-idempotency.md` §5) is computed over the **canonical JSON of the NFC-normalized body** (sorted keys, no insignificant whitespace), only after step 7 passes. Two bodies that differ only in normalization form, member order or insignificant whitespace are the **same** request: the second gets the 202 replay, not 409. Bodies that differ in anything NFC preserves (for example full-width versus ASCII digits, or trailing whitespace inside a string) are **different** requests: the second gets 409 `idempotency_key_reused`. A rejected request stores nothing (unchanged).

## 5. Tests that pin this file

`docs/__tests__/apiOpenapiRequestContract.spec.ts`:
- compiles `CreateVerificationRequest` from `openapi.yaml` with the purpose-built JSON Schema subset validator `docs/__tests__/support/jsonSchemaSubset.ts` (Addendum 3, m6; no transitive Ajv), and checks that every positive request example validates and every negative example (`x-expected-error`) fails, plus a table of cross-type, limit, visible-content and control-character cases;
- checks that the §2 table, `components.x-error-catalog` and the codes named in the OpenAPI response descriptions agree, and that each response description names only codes of its own HTTP status;
- checks that every code in `implementation-snapshots/api-1a-errors.json` is in §2 with the identical status, `type` and message (§2.3), and that the PRD §9.5 and Addendum 1 codes appear with the same status;
- checks that every published error example (PRD, OpenAPI, this file) has the exact envelope and the catalog's status, `type` and message (Addendum 3, m5).

`docs/__tests__/jsonSchemaSubset.spec.ts` proves the validator's keyword semantics, including the attack corpus that Ajv rejected. `docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts` runs the replay truth table and interleavings (`jobs-and-idempotency.md` §5A). `docs/__tests__/apiRequestBodySizing.spec.ts` produces §4.3.1.

What these tests do **not** cover: NFC normalization, code-point counting of NFC forms, lone surrogates and invalid UTF-8 at the byte level, body byte limits on the wire and the precedence order as executed by a server are server behaviours; they are API-3 implementation tests. The reference model of §3.1 (create path) is documentation, not the implementation.

### 5.1 Example envelope

```json
{ "error": { "type": "invalid_request_error", "code": "empty_input",
             "message": "The input text is empty.",
             "param": "input.claim", "request_id": "req_01HF3X",
             "doc_url": "https://docs.convergepanel.com/errors#empty_input" } }
```
