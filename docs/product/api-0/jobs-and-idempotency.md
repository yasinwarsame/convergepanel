# Jobs, idempotency and webhook delivery (API-0)

**Status:** design for API-3 (jobs, idempotency) and API-5 (webhooks). Queue: managed durable queue preferred, Google Cloud Tasks fallback (OD-3). Nothing here is implemented.

## 1. Why step-wise

Every current research, synthesis and video route sets `maxDuration = 300`, and `lib/adaptiveSchema/retryBudget.ts` sizes retry reserves around `RESEARCH_ROUTE_MAX_DURATION_SECONDS = 300`. A five-model research run with corrective retries plus synthesis can exceed one invocation. The API therefore runs each job as a Firestore-backed state machine advanced by short, idempotent worker steps, each inside one ≤ 300 s invocation, with the existing retry budget passed **per step**.

## 2. State machine

```
             create (tx: reserve + job + idempotency)
                      │
                      ▼
   ┌──────────── queued ───────────┐  cancel / suspension      ┌──────────┐
   │   max queue wait exceeded     ├──────────────────────────▶│ canceled │
   ▼                               │                            └──────────┘
┌─────────┐                        ▼ lease(panel)
│ expired │                     running ──────────────┐
└─────────┘                        │ panel ok          │ < 2 usable models / step retries exhausted
                                   ▼                   ▼
                   synthesis requested?           ┌────────┐
                     yes │        no │            │ failed │
                         ▼           │            └────────┘
                   synthesizing      │
                         │ (ok or synthesis failed)
                         ▼           ▼
                       finalize (project → Zod → persist → settle → events)
                         │
            ┌────────────┴─────────────┐
            ▼                          ▼
       completed                    partial
```

| From | Event | To | Side effects |
|---|---|---|---|
| — | create | `queued` | reserve credits, write job + idempotency record, enqueue `panel` |
| `queued` | lease `panel` acquired | `running` | — |
| `queued` | wait > max queue wait (default 10 min, placeholder) | `expired` | release reservation; cost 0 |
| `queued` | cancel / org suspended | `canceled` | release reservation |
| `running` | panel step done, synthesis requested | `synthesizing` | persist panel outputs; enqueue `synthesis` |
| `running` | panel step done, no synthesis | (finalize) | enqueue `finalize` |
| `running` | < 2 usable models | `failed` | release; internal cost recorded; failed-job counters (OD-8) |
| `running` | lease expired 3× | `failed: worker_timeout` | as above |
| `running` | cancel | stops after current step → `canceled` | settle work done |
| `synthesizing` | ok / synthesis failed | (finalize) | synthesis failure → section `failed`, synthesis credits released |
| finalize | all requested sections `completed`/`unavailable`-by-design | `completed` | settle; emit `verification.completed` |
| finalize | any `partial`/`failed` section with a verdict or gate | `partial` | settle; emit `verification.partial` |
| finalize | persistence retries exhausted | `failed: persistence_failed` | release; internal cost recorded |

Terminal states never change, except to deleted (a tombstone, OD-11). Class (a) input is deleted on entering any terminal state unless `retain_input`.

## 3. Steps, leases and budgets

| Step | Work | Budget |
|---|---|---|
| `panel` | shared core (research: classify + `runPanel` + `finalizeAdaptiveRun`; claim: extracted `executeClaimVerification`, **new** in API-3) | ≤ 300 s |
| `synthesis` | extracted `executeSynthesis` (**new** in API-3/4) | ≤ 300 s |
| `finalize` | `projectResult` → Zod → persist (classes b, d) → settle → enqueue events | ≤ 60 s |

**Lease protocol.**
1. Worker receives `{ verificationId, orgId, step, attempt }`. It trusts nothing else in the message.
2. Transaction: read job; require `state` compatible with `step`; require no live lease (`leaseExpiresAt < now`) or same `leaseOwner`; write `leaseOwner = invocationId`, `leaseExpiresAt = now + stepBudget + 30 s`, `stepAttempt += 1`.
3. Before each provider call: acquire a CR-2 provider-pool permit (Redis-class, TTL = call timeout). No permit → yield: release lease and re-enqueue with delay. This is how API work waits instead of competing with web.
4. Step output is written under a deterministic document ID (`steps/{step}`) with `tx.create()` semantics, so a duplicate execution cannot write twice.
5. Transaction: advance state, clear lease, enqueue next step (enqueue is idempotent by message ID `verId:step:attempt`).

**Retries.** Provider-level retries are the existing ones (`lib/panel.ts`: transient retries + DeepSeek fallback via `PANEL_DEEPSEEK_FALLBACK_FOR`; adaptive corrective retries bounded by `retryBudget.ts`). Step-level retries: a step whose lease expired is retried up to 2 more times. Queue redelivery without a lease change is a no-op.

**Sweeper (cron).** Finds non-terminal jobs with `updatedAt` older than 15 min and expired leases; re-enqueues or fails them per the table. It never touches terminal jobs.

**Load shedding (CR-2).** When shedding is engaged the worker refuses to start `synthesis` and new `panel` steps (re-enqueues with delay) and pauses at step boundaries. Running provider calls finish.

## 4. Idempotency

| Property | Rule |
|---|---|
| Header | `Idempotency-Key`, 1–255 printable ASCII. **Required** for live keys on `POST /v1/verifications`; optional for test keys |
| Scope | `(orgId, appId, key)`. Two applications may use the same key value independently. Stored at `apiOrganizations/{orgId}/idempotency/{sha256(appId + "\|" + key)}` |
| Request hash | SHA-256 of the canonical JSON of the request body (sorted keys, no insignificant whitespace) plus `type` and the `Prefer` header |
| Creation | In the **same transaction** as the credit reservation and the job, using `tx.create()` (the `runSnapshotLocks` pattern in `lib/workspaces/runSnapshotLock.ts`) |
| TTL | 24 h from creation (Firestore TTL on `expiresAt`) |
| Same key, same body | Return the original response status and body (`id` unchanged) with header `Idempotent-Replayed: true`. No new reservation |
| Same key, different body | `409 idempotency_key_reused`. Nothing created |
| Same key while first request still in its transaction | `409 request_in_progress` with `Retry-After: 1` |
| First request failed validation (4xx before transaction) | No record is written; the key may be reused |
| First request hit `503 queue_unavailable` | Transaction rolled back; no record; key may be reused |
| Verification later deleted (OD-11) | Record kept as a content-free `deleted` marker until TTL; replay returns `410 verification_deleted` |

## 5. Cancellation

`POST /v1/verifications/{id}/cancel`:
- `queued` → `canceled` immediately in a transaction; reservation released; webhook `verification.canceled`.
- `running` / `synthesizing` → `cancelRequested = true`; the worker stops at the next step boundary, settles for work already done (provider work happened), state `canceled`.
- Terminal → `409 not_cancelable`.
- Org suspension cancels all `queued` jobs with full release.

## 6. Polling

`GET /v1/verifications/{id}` returns `poll_after_ms` (5,000 ms default) and `progress { models_done, models_total }`. Polling has its own per-key rate limit (default 600/min, placeholder). SDK `waitForCompletion` uses `poll_after_ms` with jittered backoff to a 30 s cap.

## 7. Webhook delivery and replay protection

**Events.** `verification.completed | partial | failed | canceled | expired | deleted`, `usage.threshold_reached`, `org.suspended`, `api_key.revoked`, `webhook.test`. Payloads are thin: IDs, status, application ID; never input, model text or result data (schemas in [`openapi.yaml`](openapi.yaml) `WebhookEvent`).

**Outbox.** Finalize writes `webhookDeliveries/{deliveryId}` (one per subscribed endpoint) in the same transaction as the terminal state. The dispatcher reads due deliveries; the event is never lost if the dispatcher crashes.

**Signing.** `ConvergePanel-Signature: t=<unix>,v1=<hex HMAC-SHA-256(secret, "<t>.<raw body>")>`. Secret per endpoint, envelope-encrypted under managed KMS (OD-12). During rotation both old and new `v1` values are sent for 24 h.

**Receiver obligations** (implemented in the SDK verifier): verify over the **raw** body; reject `|now − t| > 300 s`; constant-time compare against any `v1`; dedupe on `id` for at least 24 h; respond 2xx quickly and process asynchronously.

**Replay protection on our side.** `evt_` IDs are unique and stable across retries (retries resend the same event ID and a fresh `t`). Redelivery from the dashboard sends the same event ID, so a correctly deduping receiver ignores it unless it was never processed.

**Delivery policy.** At-least-once; exponential backoff with jitter over ~24 h (≈ 8 attempts: 1 m, 5 m, 30 m, 2 h, 5 h, 10 h, 18 h, 24 h — placeholders); 10 s timeout; no redirects; per-endpoint concurrency 1; SSRF checks at save and at every send; auto-disable after 3 days of continuous failure with an owner email through the existing `RESEND_API_KEY` path.

**Ordering.** Not guaranteed. Payloads carry `status`; receivers fetch the verification for the authoritative state.
