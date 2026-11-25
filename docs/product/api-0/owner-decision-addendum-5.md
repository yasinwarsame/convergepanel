# API-0 Owner Decision Addendum 5: MAJOR-1 concurrency (2026-11-17)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's ruling on finding MAJOR-1 of the independent review of #325 at `5957174`, and the single bounded correction made in response. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner, ruling of 2026-11-17 ("MAJOR-1 concurrency"), one bounded MAJOR-only correction |
| **Amends** | `jobs-and-idempotency.md` (§5A.2, §5A reference-model note, §5B rewritten, new §5B.1 and §5B.2), `ledger-and-billing.md` §2 (note), `secret-boundary.md` (Redis-class store purpose), `dependencies-and-gates.md` (DEP-4 note), `../api-platform-prd.md` (changelog row "4 (A5)", §9.3 note), the reference model and its spec, and one OpenAPI test for the cancel 410 of Addendum 4 |
| **Does not change** | Addenda 1–4 (append-only; not edited). Any other owner ruling or contract: no billing, identity, research or other contract change. The other open MINOR findings of the review are left as they are |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `5957174` |

## 1. The finding

Addendum 4 §5B kept the accepted-job count in the **monthly, possibly sharded period document** (`periods/{YYYY-MM}`, `ledger-and-billing.md` §2). That record changes identity at a month rollover, so a job admitted in one month and finished in the next has no defined release target (risk of over-admission in the new month, a negative count, an aborted terminal transition, or a capacity leak), and a sharded count cannot be checked and incremented atomically. The reference-model note also wrongly claimed parity with the model, which kept the count on the organization document.

## 2. Owner ruling (MAJOR-1)

The accepted-job count lives in **one organization-scoped, unsharded concurrency record whose identity never changes with the calendar month or billing period**; it must not be a period document. Requirements:

1. the same record at admission and release;
2. concurrency check, increment, job create and credit reservation atomic in the same Firestore transaction (T-create);
3. the monthly billing counters and ledgers remain separate;
4. a job is counted only when its admission commits;
5. every counted job has exactly one release;
6. the release is conditional on the first valid non-terminal → terminal transition, recorded on the job in the same transaction;
7. duplicate workers, retries, sweeper runs, cancellations and deletions cannot double-decrement;
8. never negative: if a release would go negative, the job's terminal transition is **not** aborted silently; the terminal transition commits, the release is recorded as an anomaly, an alert is raised, and the count is corrected by an audited repair;
9. a failed or incomplete release fails safe, and is detectable and recoverable;
10. a month rollover never changes the limit or the release target;
11. the Redis-class provider permits remain separate from organization job admission.

Reconciliation must **not** overwrite the organization's count from a query that is not transactionally consistent; it must be protected against concurrent admissions and releases.

## 3. Design chosen (`jobs-and-idempotency.md` §5B)

| Requirement | Design |
|---|---|
| Record | `apiOrgConcurrency/{orgId}`, field `active` (plus `anomalies`). A dedicated document, not a field on `apiOrganizations/{orgId}`: the organization document holds status, plan and settings written by management actions, and a high-churn counter there would make every admission and completion contend with those writes. Never a period document; never sharded |
| (1), (10) | Admission and release address the same document; its identity depends only on `orgId`. The limit comes from the organization's plan, not from a period |
| (2), (4) | T-create reads the record, checks `active < limit`, and in one commit creates the job (`concurrencyCounted: true`, `concurrencyReleased: false`, `admissionId`), the reservation, the period-counter update and `active + 1` |
| (3) | Period documents hold billing counters only (`ledger-and-billing.md` §2 note) |
| (5)–(7) | The only release is the first non-terminal → terminal transition, in the same transaction, which sets `concurrencyReleased: true`; it is conditional on the job being non-terminal at commit, so later or concurrent terminal events are no-ops |
| (8) | At `active = 0` the terminal transition still commits; the job records `concurrencyReleaseAnomaly: true`, `anomalies` is incremented, `concurrency.release_anomaly` is audited and alerted; `active` never goes below 0 |
| (9) | Release and terminal transition share one transaction, so a failure leaves the job non-terminal and counted (capacity held, never double-freed), detectable by its expired lease or queue deadline, and recovered by the sweeper's terminal transition |
| (11) | The Redis-class store keeps provider permits and rate windows only; it never decides admission |
| Reconciliation | Detection only (`concurrency.drift_detected`, no write). Correction is an audited repair transaction that reads the record first, then every counted-and-unreleased job of the organization transactionally, and sets `active`; any admission or release committing meanwhile aborts and retries it |

## 4. Tests (reference model; doc-parsed where applicable)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`, suites "Addendum 5 MAJOR-1":
- the doc's declared **counter location** and **release and admission markers** (§5B) are parsed and compared with the model's constants, and the location contains no month, period, shard or application;
- the release truth table §5B.1 (rows E1–E10) is parsed and run;
- creates at the limit; last minute of the month; creates racing the month boundary (every interleaving); a job across year-end, with the reservation's ledger month kept and the next month's period document untouched; a sweeper racing normal completion (every interleaving); cancellation followed by a late worker completion; a crashed release; drift detection without a write and the audited repair; the repair racing an admission and a release (every interleaving); a release due at count 0;
- after every scenario, `active` is non-negative and equals the number of counted, unreleased jobs (no silent leak);
- the existing two- and three-request distinct-key races at the limit now run against the same record.

`docs/__tests__/apiOpenapiRequestContract.spec.ts`: `cancel` lists 410 `Gone` in `openapi.yaml` (Addendum 4 CX; the earlier mutant that removed it survived).

## 5. What these tests do not prove

They test the documented rules against an in-memory model. They do **not** prove the distributed implementation. API-3 must add the Firestore-emulator, failure-injection, month and year rollover (controlled clock), and isolated-environment tests listed in `jobs-and-idempotency.md` §5B.2 before any release decision.

## 6. Supersessions

| Earlier text | Superseded by |
|---|---|
| Addendum 4 ruling CC as designed in its §6 row "CC" and in `jobs-and-idempotency.md` §5B at `5957174` ("active-job count in the period document") | §3 above; `jobs-and-idempotency.md` §5B |
| PRD §9.3 "per-org concurrency counters" in the Redis-class store; `secret-boundary.md` and `dependencies-and-gates.md` mentions of Redis concurrency counters | §3 row (11); appended notes in those documents |

## 7. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
