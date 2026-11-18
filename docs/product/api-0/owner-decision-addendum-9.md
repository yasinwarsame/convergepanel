# API-0 Owner Decision Addendum 9: settlement derived from durable state (2026-11-18)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's rule on MINOR-2 of the independent review of #325 at `34076fe` (CLEAN_WITH_MINOR), and the specification refinement made in response. It also records the test strengthening for MINOR-1, MINOR-3 and MINOR-4 of the same review. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner rule "a worker crash must not change customer charges solely because a DELETE was pending". R4 specification refinement only. |
| **Amends** | `jobs-and-idempotency.md`: §3 (sweeper row), §4.4 (*Sweeper*), §5A (modelled list), §5B (*Failed or incomplete release*), §6.2 (D5 note) and new §6.3. `ledger-and-billing.md` §2.5: new paragraph *Settlement source*. `retention-and-deletion.md` §3.1 (*Behaviour*). `../api-platform-prd.md` (changelog row "4 (A9)"). `README.md`. The reference model and its spec. |
| **Does not change** | The ledger policy (`ledger-and-billing.md` §2.4–§2.5, OD-8) and owner ruling E1 (Addendum 8). Addenda 1–8 are append-only and are not edited; they are superseded only where §6 says so. `openapi.yaml` and `error-catalog.md` were checked and nothing in them changes: the cancel description already says a running job "settles for work already done", and no status or error code changes. No price, fee, identity or research change. |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `34076fe` |

## 1. The finding (R4 MINOR-2)

A worker crash ended in a different settlement depending on whether a `DELETE` was pending:
- **Without a pending deletion,** the crash ended `failed: worker_timeout` and was charged 0 (Addendum 8, E1).
- **With a pending deletion,** the same crash ended `canceled: deletion_requested`, and the job's usable calls were charged ("canceled during execution settles for work done").

The asymmetry came from the sweeper rule written in Addendum 6 §3 (row (8)) and in `jobs-and-idempotency.md` §3, §4.4 and §5B. Addendum 8 kept that rule and did not disclose the asymmetry.

## 2. Owner rule (binding)

A worker crash must **not** change customer charges solely because a `DELETE` was pending. Settlement must be derived from durable states and from independently verifiable completed work, never from whether a `DELETE` is in flight. Further:
- A fully failed job with no usable committed output is charged zero and its reservation is released.
- Completed, partial and cancel-after-work charges remain governed by the rules already approved, provided no contradictory outcome is introduced.
- No new fee policy is invented, and uncommitted work is never assumed billable.
- Any ambiguity stays unresolved rather than being charged speculatively.

## 3. Contradiction check (performed before any change)

Each source was read for a statement that the rule would contradict.

| Source | Text | Finding |
|---|---|---|
| Addendum 6 §2, owner requirement (8) | "a crashed or unresponsive worker is finalized by a bounded recovery mechanism (sweeper deadline, including `synthesizing` and `pending_dispatch`)" | **No conflict.** The owner requirement names the mechanism, not the terminal state or the charge. |
| Addendum 6 §3, design row (8) | "The sweeper ends `running` and `synthesizing` jobs after three expired leases (`worker_timeout`, or `canceled: deletion_requested`)" | **Design text, not an owner ruling.** It is the source of the asymmetry and is superseded in §6. |
| Addendum 8 §2, ruling E1 | "This does not override the existing settlement rules for completed jobs, partially completed jobs, and canceled jobs with already completed chargeable work." | **No conflict.** The canceled-after-work rule is unchanged. The change is which terminal state crash recovery writes (`failed`, as without a deletion). It does not change how a canceled job is charged. A job that really stops at a safe boundary is still `canceled` and still settles its committed work. |
| `ledger-and-billing.md` §2.5 | "`failed`, `canceled` (before execution), `expired`: `release_{verId}` for the whole estimate, `charged = 0` (OD-8). Canceled during execution settles for work done." | **No conflict.** It is unchanged. |
| `jobs-and-idempotency.md` §3, row "lease expired 3×" | "`failed: worker_timeout`; `canceled: deletion_requested` when a deletion is pending" | **Design text.** It is superseded in §6. |
| `jobs-and-idempotency.md` §6 | "`running` / `synthesizing` → `cancelRequested = true`. The step-start check (§4.2) stops the job at the next step boundary and settles for work already done" | **No conflict.** It applies to a worker that reaches a boundary, not to a crash. |
| PRD §13.1 (*Lease*) and the §13.2 failure matrix | "After that the job fails with `worker_timeout`, the customer's credits are released"; "Worker crash mid-step \| Lease expiry → retry step" | **Consistent with the rule.** The PRD never had the deletion exception. |
| PRD §10.3 item 3, §21A P-4, J6 | Fully failed, expired or canceled-before-execution jobs are charged 0 | **No conflict.** |
| `openapi.yaml` (`cancelVerification`, `deleteVerification`), `error-catalog.md` | The cancel description says a running job "settles for work already done" | **No conflict.** No status code changes. |

**No owner decision contradicts the rule, so nothing had to stop.** One case cannot be decided from the existing documents without choosing between two of them. It is left unresolved: see §7 Q1.

## 4. Design

The specification is `jobs-and-idempotency.md` §6.3. It defines:
- the durable state (lifecycle state, lease count, reservation, admission markers, committed work and the single settlement);
- the atomicity of a call commit and of the terminal transaction;
- the charge rule (unchanged);
- crash recovery;
- the transition table T1–T24 (state × pending request × event → next state, charge, release).

| Item | Design |
|---|---|
| Reservation | T-create writes `reserve_{verId}` (*R* credits), the job and the admission in one transaction (unchanged, §2, §5B) |
| Provider execution | An in-flight call has no durable effect. The call is committed only when its record and its cost entry commit together, conditional on a non-terminal job (§4.4). |
| Durable usage accounting ("committed usable") | A committed call record with status `ok` or `substituted`, plus synthesis and retry output committed the same way (`ledger-and-billing.md` §2.5, *Settlement source*). Worker memory, an uncommitted transaction and a late result never count. |
| Committed usable results | They are written by the winning terminal transaction only. Late content writes are refused by the late-write barrier (unchanged). |
| Cancellation requests, including `DELETE` | They record `cancelRequested` (and the deletion intent). The worker stops at the next safe boundary, and that stop settles the committed usable work (T10–T13). A queued job is canceled at once and charged 0 (T1, T2). **The request is never an input to the charge.** |
| Worker crash or lease expiry | Fewer than three expiries: the job keeps its state, and nothing settles (T6). On the third, the sweeper ends it `failed: worker_timeout`, charged 0, with the whole reservation released, **whatever is pending** (T14–T17). A pending deletion then completes. |
| Retries and duplicate events | A crashed or conflicting terminal transaction commits nothing. Its retry recomputes the settlement from fresh reads (T12, T13, T17). Duplicate terminal events, late results and repeated `DELETE`s change nothing (T9, T22–T24). The first committed terminal transition wins (§5B). |
| Final settlement | Exactly one settlement, charged + released = *R*, 0 ≤ charged ≤ *R*. It is computed in the terminal transaction and copied unchanged to the tombstone. |
| Reservation release | It happens in the same terminal transaction as the settlement and the admission release (unchanged). |

## 5. Changes to other documents

| Document | Change |
|---|---|
| `jobs-and-idempotency.md` §3 | Row "lease expired 3×": `failed: worker_timeout` also when a cancellation or a deletion is pending |
| `jobs-and-idempotency.md` §4.4, §5B | The sweeper sentence and the *Failed or incomplete release* bullet say the same |
| `jobs-and-idempotency.md` §5A | The modelled list names the settlement transitions, the call-commit crash point and the acceptance-identity generator seam |
| `jobs-and-idempotency.md` §6.2 | D5 note. The table's columns (one release, one settlement, completed, purged) are unchanged |
| `jobs-and-idempotency.md` §6.3 | New: the settlement state transitions (normative; parsed) |
| `ledger-and-billing.md` §2.5 | New paragraph *Settlement source (Addendum 9)* |
| `retention-and-deletion.md` §3.1 | *Behaviour*: crash recovery settles as without the deletion |
| PRD changelog, `README.md` | Row "4 (A9)"; index row 22 |

## 6. Supersessions (earlier text not edited)

| Earlier text | Superseded by |
|---|---|
| Addendum 6 §3 row (8): "(`worker_timeout`, or `canceled: deletion_requested`)" | `failed: worker_timeout` whether or not a deletion is pending (§4) |
| `jobs-and-idempotency.md` §3, §4.4 and §5B (Addendum 6 wording): `canceled: deletion_requested` as a sweeper outcome | Edited in place (§5). `canceled: deletion_requested` now arises only when a worker stops at a boundary with a deletion pending, or when a queued job is deleted. Both settle per `ledger-and-billing.md` §2.4–§2.5, as before. |

## 7. Owner questions (not decided here)

1. **Q1. A retried `panel` step with a cancellation pending (T18).** Example: a worker commits some provider calls mid-`panel` and then crashes. Before the third expiry, a cancellation (`cancel` or `DELETE`) is recorded. The retried step's start check then finds the cancellation. The documents disagree on what happens next:
   - `jobs-and-idempotency.md` §4.2: "`cancelRequested` … Before the `panel` step → `canceled`, full release". Read literally, this charges 0.
   - `ledger-and-billing.md` §2.5: "Canceled during execution settles for work done". This charges the committed usable work.

   This addendum does not choose; the reference model charges the committed work. The tests require only that the charge is 0 or the committed usable work, that it conserves, and that `cancel` and `DELETE` agree. Either reading satisfies the owner rule, because a pending `DELETE` and a pending `cancel` are treated alike.
2. **Q2. Cost entry of an uncommitted call (T5).** A provider call whose worker dies after the provider returned but before the record transaction commits leaves no call record and no cost entry. That means:
   - `ledger-and-billing.md` §3.1 ("one entry per provider call attempt") and the reconciliation check (§6) cannot see it;
   - the failed-job cost limit undercounts it.

   The customer is never charged for it. Writing a cost estimate **before** the call (an intent entry) would close the gap, but that is a cost-ledger design change and is not made here.
3. **Q3. Lease fencing of a slow worker's terminal write.** A slow (not dead) worker can reach its boundary after its third lease expiry, before the sweeper commits. The first committed terminal transition wins: either `canceled` with the committed work charged, or `failed: worker_timeout` charged 0. The set of possible outcomes is identical for `cancel` and `DELETE` (tested), so the owner rule holds. Whether a worker that has lost its lease may still commit a terminal transition is not specified in §4.1.

## 8. Tests (reference model; doc-parsed)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`, describes "Addendum 9 …".

**Failing first.** Commit `315d75a` added the tests. 12 failed against `34076fe`; the fix follows in a separate commit.

**Transition table.** §6.3 is parsed: rows T1–T24, with a closed vocabulary for every column. Every row is executed:
- for each pending request it names, 0–3 committed usable calls and 0–1 failed calls, and every terminal starting state;
- each run checks the terminal state, the failure code (read from the outcome record, which survives the purge), the charge, the release, conservation, a single settlement, the balance, the concurrency count, and the tombstone after a pending deletion completes;
- the results for each pending request a row names must be identical.

**Crash with and without `DELETE`.**
- Exhaustive: `running` and `synthesizing`, 0–8 usable calls, 0–2 failed calls, and none, `cancel` or `DELETE` pending. Every case ends `failed: worker_timeout`, charged 0, with the whole reservation released, the balance restored and one cost entry per committed call. The three pending variants are equal.
- Crash after the provider returned but before the record committed: the call is not billable, and a later stop charges only committed calls.
- Cancel before and after committed work, for `cancel` and `DELETE`.
- Duplicate and late events after a crash with `DELETE` pending.
- Every interleaving of a slow worker's stop with the sweeper: identical outcome sets for `cancel` and `DELETE`.
- Every interleaving of the crash sweeper with an in-flight call result.

**Ledger rule.** *Settlement source* is parsed: the crash state and its charge, the usable statuses, and independence from a pending request.

**MINOR-1 (acceptance identity).**
- The model draws the identity through an injectable generator. Its default is asserted to be `crypto.randomBytes`.
- A scripted generator proves that the ID is exactly the drawn 16 bytes, drawn once per acceptance and never on a replay.
- A constant generator proves that nothing else enters the ID.
- `Math.random` is never called.
- Statistics over 4,096 default IDs: every bit is set 40–60 % of the time, consecutive IDs differ in at least 24 of 128 bits, and the mean distance is 60–68. Statistics also hold over 64 IDs drawn through T-create.

**MINOR-3 (soft ratio).** A second concurrent create is refused `429 concurrency_limit` exactly when the ratio is above the parsed threshold and the job count is at least the parsed minimum.

**MINOR-4 (ledger paragraphs).**
- The *Fully failed* paragraph is parsed into its charge, its release and its named failure codes. These drive the settlement check for each code with 0–3 usable calls.
- The *Short-circuit attribution* paragraph is parsed into its attributable and platform code lists. These are compared with the model's lists and with the short-circuit feed.

These tests do **not** prove the distributed implementation. The API-3 obligations of `jobs-and-idempotency.md` §5B.2 apply: emulator, failure-injection and isolated-environment tests of crash recovery with and without a pending deletion.

## 9. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
