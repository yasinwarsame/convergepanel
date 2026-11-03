# Jobs, idempotency and webhook delivery (API-0)

**Status:** design for API-3 (jobs, idempotency) and API-5 (webhooks). Queue: managed durable queue preferred, Google Cloud Tasks fallback (OD-3). Nothing here is implemented.

## 1. Why step-wise

Every current research, synthesis and video route sets `maxDuration = 300`, and `lib/adaptiveSchema/retryBudget.ts` sizes retry reserves around `RESEARCH_ROUTE_MAX_DURATION_SECONDS = 300`. A five-model research run with corrective retries plus synthesis can exceed one invocation. The API therefore runs each job as a Firestore-backed state machine advanced by short, idempotent worker steps, each inside one ≤ 300 s invocation, with the existing retry budget passed **per step**.

## 2. Create: transactional outbox, then dispatch

A Firestore transaction cannot include a queue publish, so job creation never "enqueues in the transaction". It uses a **transactional outbox**:

1. **Before any write** (no state is created, the idempotency key stays free): parse and validate the body, authenticate the key, check scope, apply the Redis-class rate limit, and refuse with `503 queue_unavailable` if the dispatcher's health check currently marks the queue unavailable.
2. **One Firestore transaction (T-create)** reads the idempotency record, the org and the current period, then either replays, rejects, or writes **all** of:
   - the job document with internal state `pending_dispatch`, `dispatchAttempts: 0`, `dispatchDueAt: now`;
   - the `reserve_{verId}` ledger entry and the period counter increment (`ledger-and-billing.md` §2.3);
   - the idempotency record (§5) holding the request hash, the verification ID and the exact `202` response body.

   It commits all of them or none.
3. **After commit, dispatch.** The API route publishes the `panel` message (deterministic message ID `verId:panel:1`). On a publish acknowledgement it moves the job `pending_dispatch → queued` in a conditional transaction (only if still `pending_dispatch`). The route returns `202` **whether or not the publish succeeded**: the job and the reservation are already durable.
4. **Sweeper re-dispatch.** A cron sweeper (every 1 min, placeholder) selects jobs in `pending_dispatch` whose `dispatchDueAt` is older than 30 s. It re-publishes with the same message ID, increments `dispatchAttempts` and sets `dispatchDueAt = now + backoff`. A job still undispatched when the max queue wait (default 10 min, placeholder) passes goes to `expired` with a full release.
5. **Idempotent worker.** Publishing more than once is safe: the queue may deduplicate by message ID, and the worker never depends on that (§4: lease, deterministic step documents, per-call records). The worker accepts a `panel` message for a job in `pending_dispatch` or `queued`, so a lost `queued` update changes nothing.

Public status: `pending_dispatch` is internal and is reported as `queued`. The public `JobStatus` vocabulary is unchanged.

## 3. State machine

```
        T-create (job pending_dispatch + reserve + idempotency record, one transaction)
                      │
                      ▼
              pending_dispatch ──(publish ack)──▶ queued        [both public "queued"]
                      │  sweeper re-publishes           │
                      └──────────────┬──────────────────┘
   max queue wait / yield cap ◀──────┤  cancel / suspension / hard abuse / spend ceiling ──▶ canceled
   (expired | failed)                │
                                     ▼ lease(panel) + step-start checks + atomic permits
                                  running ──────────────┐
                                     │ panel ok          │ < 2 usable models / step retries exhausted
                                     ▼                   ▼
                     synthesis requested?           ┌────────┐
                       yes │        no │            │ failed │
                           ▼           │            └────────┘
                     synthesizing      │
                           │ (ok, failed or skipped)
                           ▼           ▼
                         finalize (project → Zod → persist → settle → outbox events)
                           │
              ┌────────────┴─────────────┐
              ▼                          ▼
         completed                    partial
```

| From | Event | To | Side effects |
|---|---|---|---|
| — | T-create commits | `pending_dispatch` | reserve credits, job, idempotency record (one transaction) |
| `pending_dispatch` | publish acknowledged | `queued` | — |
| `pending_dispatch` / `queued` | lease `panel` acquired, step-start checks pass, all step permits acquired | `running` | — |
| `pending_dispatch` / `queued` | wait > max queue wait (default 10 min, placeholder) | `expired` | release reservation; cost 0 |
| `pending_dispatch` / `queued` | panel-step yields > `MAX_YIELDS_PER_JOB` (§4.3) | `failed: capacity_unavailable` | release reservation; any cost entries kept; excluded from failed-job count and ratio (platform-caused) |
| `pending_dispatch` / `queued` | cancel, org suspended, org hard abuse state, platform spend ceiling (step-start check) | `canceled` | release reservation; `failure.code` names the cause |
| `running` | panel step done, synthesis requested | `synthesizing` | persist panel outputs; enqueue `synthesis` |
| `running` | panel step done, no synthesis | (finalize) | enqueue `finalize` |
| `running` | < 2 usable models (`insufficient_usable_models`) | `failed` | release; internal cost recorded; failed-job counters (OD-8) |
| `running` | no primary outcome although ≥ 2 models answered: research `no_comparable_claims` (claims-matrix, empty `alignedClaims`) or `adaptive_finalize_failed` (result-schema §4.0) | `failed` | release; internal cost recorded; excluded from failed-job count and ratio, included in failed-job cost |
| `running` | research routed to a non-executing outcome (handoff, disabled, clarification, graceful limitation) | `failed: query_not_executable` | release; classification cost recorded; excluded from failed-job count and ratio, included in failed-job cost |
| `running` | lease expired 3× | `failed: worker_timeout` | release; internal cost recorded |
| `running` / `synthesizing` | cancel | stops after current step → `canceled` | settle work done |
| `synthesizing` | step-start check fails (hard abuse, suspension, spend ceiling) or synthesis yield cap | (finalize) | synthesis section `failed` with that reason code; synthesis credits released |
| `synthesizing` | ok / synthesis failed | (finalize) | synthesis failure → section `failed`, synthesis credits released |
| finalize | all requested sections `completed`/`unavailable`-by-design | `completed` | settle; outbox `verification.completed` |
| finalize | any requested section `partial`/`failed` and a primary outcome exists | `partial` | settle; outbox `verification.partial` |
| finalize | persistence retries exhausted | `failed: persistence_failed` | release; internal cost recorded |

Terminal states never change, except to deleted (a tombstone, OD-11). Class (a) input, step documents and per-call records are deleted on entering any terminal state unless `retain_input` (which keeps only the input text, never step or call records).

## 4. Steps, leases, permits and budgets

| Step | Work | Budget |
|---|---|---|
| `panel` | shared core. Research: `planAdaptiveRun` (classification) then `executeOrdinaryRun` (PRD §6.1). Claim: the extracted `executeClaimVerification` (**new** in API-3, PRD §6.2) | ≤ 300 s |
| `synthesis` | extracted `executeSynthesis` (**new** in API-3/4, PRD §6.3) | ≤ 300 s |
| `finalize` | `projectResult` → Zod → persist (classes b, d) → settle → outbox | ≤ 60 s |

### 4.1 Lease protocol

1. The worker receives `{ verificationId, orgId, step, attempt }` and trusts nothing else in the message.
2. **Lease transaction.** Read the job and require a `state` compatible with `step`. Require no live lease (`leaseExpiresAt < now`) or the same `leaseOwner`. In the **same transaction** run the step-start checks (§4.2). Write `leaseOwner = invocationId`, `leaseExpiresAt = now + stepBudget + 30 s`, `stepAttempt += 1`.
3. **Atomic step permits** (§4.3). If they cannot all be acquired, release the lease and yield. No provider call has been made in this attempt.
4. Run the step. Every provider call goes through the instrumented call sites (PRD §6.5): the per-call record is checked first (§4.4), and each completed call writes its record and its internal cost entry before its result is used.
5. Step output is written under a deterministic document ID (`steps/{step}`) with `tx.create()` semantics, so a duplicate execution cannot write twice.
6. **Advance transaction.** Advance state, clear the lease, and write the next step's dispatch into the job (`nextStep`, `dispatchDueAt`) in the same transaction. Then publish the next message (ID `verId:step:attempt`). The sweeper re-publishes any job whose `nextStep` dispatch is older than 30 s, which is the same outbox rule as §2.
7. Release all step permits in a `finally`, and also on lease loss. Permits additionally expire by TTL (§4.3).

### 4.2 Step-start checks (every step, not only at create)

Read inside the lease transaction (Firestore) or immediately before it (Redis-class state):

| Check | Source | Before the `panel` step | Before `synthesis` |
|---|---|---|---|
| `cancelRequested` | job | → `canceled`, full release | → finalize with work done; synthesis `not_requested`-by-cancel (`reason.code: canceled`) |
| Org `status = suspended` or `abuseState` hard (`ledger-and-billing.md` §4.3) | org doc | → `canceled`, full release | synthesis `failed` (`org_suspended` / `failed_job_threshold_exceeded`); finalize `partial` |
| Platform daily API spend ceiling reached | `apiPlatformCounters/{YYYY-MM-DD}` (sharded, summed) | → `canceled` (`platform_spend_ceiling`), full release | synthesis `failed` (`platform_spend_ceiling`); finalize `partial` |
| Pipeline switches (research needs `ADAPTIVE_SCHEMAS_ENABLED` and `ADAPTIVE_VERIFICATION_ENABLED`, result-schema §4.0) | `lib/env.ts` values at boot | → `failed: pipeline_disabled`, full release, excluded from failed-job count and ratio | — |
| CR-2 load shedding engaged for this step class | Redis-class shedding state | yield (§4.3) | yield (§4.3) |

`finalize` makes no provider call, so it runs even when the ceiling or a hard abuse state is reached. It settles only work already done.

### 4.3 Provider permits: all-or-nothing per step, bounded yields

The CR-2 provider pools (PRD §13A) are semaphores in the Redis-class store. A step acquires its **whole permit set atomically** (a single Lua script / transaction across the pool keys) before it makes any provider call. Either every permit is granted, or none is.

| Step | Permit set (one permit = one concurrent call on that provider's API pool) |
|---|---|
| Claim `panel` | one per selected slot, on the slot's provider |
| Research `panel` | one per selected slot, on the slot's provider, **plus** auxiliary permits on the Gemini pool for the pipeline's own Gemini calls (classification, claim clustering, stance backfill, bias detection, coverage audit, synthesis narrative; the `GeminiDiagnosticOperation` set in `lib/connectors/types.ts`). Auxiliary permits are sized to the pipeline's **real concurrency**: `lib/adaptiveSchema/alignment.ts` `backfillSilentCells` issues one stance-backfill call per model in parallel (`Promise.all`), each inside `withTimeout(callGemini(...), 6000)`. So the step reserves `max(1, selected slots)` auxiliary permits up front, all-or-nothing with the slot permits, and auxiliary calls are **never serialized**. Serializing them would push later calls past their 6 s timers and change `alignedClaims`, gate and trust relative to the web app (PRD §6, same analysis). Permits are acquired before the step starts, never inside a timed call site |
| `synthesis` | one on the synthesis provider (OpenAI; `app/api/synthesize-panel/route.ts`) |

Calls that do not get a step permit:
- **Transient retries and the adaptive corrective retry** reuse the slot's permit. The slot's earlier call has finished by then, and a slot never has two calls in flight.
- **Fallback calls** (DeepSeek substitution for a research slot, or the Claude synthesis fallback) happen only when the request set `allow_fallback: true` (PRD §6.5). They try a **non-blocking** permit on the fallback provider's pool. If none is free, the fallback is skipped and the slot or synthesis is `failed` (`reason.code: fallback_capacity_unavailable`). It never yields mid-step.

Permit TTL = step budget + 30 s, so a crashed worker cannot leak capacity.

**Yield.** If the atomic acquire fails, or shedding is engaged, the worker releases the lease, increments `yieldCount` in a transaction, and re-publishes with a jittered delay (5–30 s, placeholder). A yield is not a step attempt. Because no provider call is made before the permit set is held, a yield never re-runs or wastes a provider call.

**Yield cap.** `MAX_YIELDS_PER_JOB` (placeholder 40, compile-time in `lib/apiPlatform/limits.ts`, OD-21) bounds the loop, alongside the max queue wait for jobs that have not started:
- `panel` step not yet run: whichever comes first, the max queue wait (`expired`) or the yield cap (`failed: capacity_unavailable`). Either way the reservation is released in full; cost entries, if any, are kept.
- `synthesis` step: at the cap the synthesis section is `failed` (`capacity_unavailable`), its credits are released, and the job finalizes `partial` with the panel work settled.

### 4.4 Per-call records: a resumed step never re-calls a completed provider call

Every instrumented provider call (PRD §6.5) has a deterministic **call key** `{site}:{slot|aux}:{seq}`. Parallel per-model auxiliary calls (stance backfill) are keyed by **slot**, not by invocation order: `stance_backfill:{slotModelId}:{n}`. Their keys therefore don't depend on `Promise.all` scheduling. `site` is one of `primary`, `transient_retry`, `fallback`, `corrective_retry`, `classification`, `claim_cluster`, `stance_backfill`, `bias_detection`, `coverage_audit`, `synthesis_narrative`, `synthesis`, `synthesis_fallback`. `seq` is the per-site sequence number within the step. Completed calls are replayed with identical results, so the pipeline issues the same call sequence on a resumed attempt, and the keys line up.

- The record stores the outcome **the call site observed**, not the provider's eventual result. When a call site's `withTimeout` fires first (classification and every auxiliary call use it), the record is `timeout` with zero reported usage. A provider response that arrives later is discarded for replay purposes; its cost is still estimated into the internal cost ledger. A resumed step therefore replays exactly what the pipeline used.
- **After** a call completes (any outcome) and **before** its result is returned to the pipeline, the hook writes `steps/{step}/calls/{callKey}` with `tx.create()`: `{ status, rawText, tokenUsage (as reported for that attempt), latencyMs, provider, actualModel, completedAt }`. In the same transaction it writes the internal cost entry `apiCostLedger/{verId}:{step}:{callKey}` (`ledger-and-billing.md` §3).
- **Before** each call, the hook reads the call record. If one exists, the hook returns it as a **replay**, and the call site uses that result without calling the provider.
- A record that cannot be written (document over the 1 MiB limit, Firestore error) is logged. That call is not replayable, so a resumed attempt re-issues it and records a second cost entry keyed with the execution attempt. The step retry limit (2 more attempts) bounds this.
- Call records hold raw model text, so they are data class (a). They are deleted at terminal state and never retained, even with `retain_input`.

**Retries.** Provider-level retries are the existing ones: in `lib/panel.ts` a research slot makes a primary call plus up to 2 transient retries, then the DeepSeek fallback (API: only with `allow_fallback`). Claim slots (`runClaimVerificationPanel`) make exactly one call each. The adaptive corrective retry (`retryModelOnce` in `lib/adaptiveSchema/orchestrate.ts`) is bounded by `retryBudget.ts`. Step-level retries: a step whose lease expired is retried up to 2 more times. Queue redelivery without a lease change is a no-op.

**Sweeper (cron).** It re-publishes `pending_dispatch` jobs and jobs with an overdue `nextStep` dispatch (§2, §4.1), expires jobs past the max queue wait, and fails `running` jobs whose lease expired three times (`worker_timeout`). It never touches terminal jobs. It needs the collection-group index (`state` asc, `dispatchDueAt` asc) (PRD §12.2).

**Load shedding (CR-2).** When shedding is engaged, step-start checks yield the affected step classes (§4.2, §4.3) in the PRD §13A order. Provider calls already running finish.

## 5. Idempotency

| Property | Rule |
|---|---|
| Header | `Idempotency-Key`, 1–255 printable ASCII. **Required** for live keys on `POST /v1/verifications`; optional for test keys |
| Scope | `(orgId, appId, mode, key)`. Two applications, or the test and live mode of one application, may use the same key value independently. Stored at `apiOrganizations/{orgId}/idempotency/{sha256(appId + "\|" + mode + "\|" + key)}` |
| Request hash | SHA-256 of the canonical JSON of the request body (sorted keys, no insignificant whitespace) plus `type` and the `Prefer` header |
| Creation | Inside T-create (§2) with `tx.create()` (the `runSnapshotLocks` pattern in `lib/workspaces/runSnapshotLock.ts`), together with the job (`pending_dispatch`) and the reservation. All three commit together or not at all |
| TTL | 24 h from creation (Firestore TTL on `expiresAt`) |
| Same key, same body, record exists | Return the stored original `202` status and body (`id` unchanged) with header `Idempotent-Replayed: true`. No new reservation, job or dispatch. This holds whether the job is still `pending_dispatch` or long terminal |
| Same key, different body | `409 idempotency_key_reused`. Nothing created |
| Two concurrent requests, same key | Firestore serializes the two transactions on the idempotency document. One commits; the other retries inside its own transaction, reads the committed record, and returns the replay (or `409 idempotency_key_reused` if its body differs). Only if a transaction exhausts its contention retries without reading a committed record does the request return `409 request_in_progress` with `Retry-After: 1`. Nothing was written by that request. A retry with the same key gets the replay, or creates the job if no other request committed |
| Rejected before T-create (validation `400`, `401`, `403` scope, `413`, `422`, `429` rate, `503 queue_unavailable` from the pre-write health check) | No record is written. The key may be reused |
| Rejected inside T-create (`402 quota_exceeded` / `spend_limit_reached`, `403 org_suspended` / `failed_job_threshold_exceeded` / `live_key_requires_plan`, `429 concurrency_limit`, `503 capacity_protection` / `platform_spend_ceiling`) | The transaction writes nothing, so no record exists. The key may be reused, and the same request may succeed later. Error responses are never stored or replayed |
| T-create committed but publishing failed | The record exists, the job is `pending_dispatch` and the sweeper dispatches it (§2). Replays return the same `id` and never create a second reservation |
| Verification later deleted (OD-11) | Record kept as a content-free `deleted` marker until TTL; replay returns `410 verification_deleted` |

## 6. Cancellation

`POST /v1/verifications/{id}/cancel`:
- `pending_dispatch` / `queued` → `canceled` immediately in a transaction; reservation released; outbox `verification.canceled`. A worker that later receives the message finds a terminal state and does nothing.
- `running` / `synthesizing` → `cancelRequested = true`. The step-start check (§4.2) stops the job at the next step boundary and settles for work already done (provider work happened). State `canceled`.
- Terminal → `409 not_cancelable`.
- Org suspension cancels all `pending_dispatch` and `queued` jobs with full release. Running jobs are stopped by the step-start check.

## 7. Polling

`GET /v1/verifications/{id}` returns `poll_after_ms` (5,000 ms default) and `progress { models_done, models_total }`. Polling has its own per-key rate limit (default 600/min, placeholder). SDK `waitForCompletion` uses `poll_after_ms` with jittered backoff to a 30 s cap.

## 8. Webhook delivery and replay protection

**Events.** `verification.completed | partial | failed | canceled | expired | deleted`, `usage.threshold_reached`, `org.suspended`, `api_key.revoked`, `webhook.test`. Payloads are thin: IDs, status, application ID. They never carry input, model text or result data (schemas in [`openapi.yaml`](openapi.yaml) `WebhookEvent`).

**Outbox.** The transaction that writes the terminal state also writes `webhookDeliveries/{deliveryId}` (one per subscribed endpoint). The deletion sweeper does the same for `verification.deleted`. The dispatcher reads due deliveries, so an event is never lost if the dispatcher crashes.

**Signing.** `ConvergePanel-Signature: t=<unix>,v1=<hex HMAC-SHA-256(secret, "<t>.<raw body>")>`. Each endpoint has its own secret, envelope-encrypted under managed KMS (OD-12). During rotation both the old and new `v1` values are sent for 24 h.

**Receiver obligations** (implemented in the SDK verifier): verify over the **raw** body; reject `|now − t| > 300 s`; compare in constant time against any `v1`; dedupe on `id` for at least 24 h; respond 2xx quickly and process asynchronously.

**Replay protection on our side.** `evt_` IDs are unique and stable across retries: a retry resends the same event ID with a fresh `t`. Redelivery from the dashboard also sends the same event ID, so a correctly deduping receiver ignores it unless it was never processed.

**SSRF protection (save and every send).**
1. Accept only `https://` URLs with a DNS hostname. Reject userinfo, and reject IP literals in any form (dotted, decimal, octal, hex, bracketed IPv6) unless they pass step 3.
2. Resolve the hostname **once per delivery attempt** and collect every A and AAAA record.
3. Reject the attempt if **any** resolved address is in a blocked range (not only the address that would be used):
   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (includes the `169.254.169.254` metadata address), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`.
   - IPv6: `::/128`, `::1/128`, `fc00::/7` (includes the `fd00:ec2::254` metadata address), `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`, `2001::/23` (IETF special-purpose).
   - IPv6 forms that embed IPv4 are unwrapped and the embedded address is checked against the IPv4 list: IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo `2001::/32`.
4. **Pin the connection to the validated address.** The HTTPS client is given a custom `lookup` that returns only the address validated in step 3. The hostname is never re-resolved at connect time. TLS SNI and certificate verification still use the hostname, and the `Host` header is the hostname. This closes the DNS-rebinding window between check and connect.
5. No redirects are followed (a 3xx counts as a failed attempt). Timeout 10 s. Response bodies are read only to a 4 KB cap.

**Delivery policy.** At-least-once; exponential backoff with jitter over ~24 h (≈ 8 attempts: 1 m, 5 m, 30 m, 2 h, 5 h, 10 h, 18 h, 24 h — placeholders); per-endpoint concurrency 1; auto-disable after 3 days of continuous failure, with an email to the owner through the existing `RESEND_API_KEY` path.

**Ordering.** Not guaranteed. Payloads carry `status`; receivers fetch the verification for the authoritative state.
