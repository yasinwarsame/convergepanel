# API-0 Owner Decision Addendum 10: owner decisions Q1–Q3 on settlement, provider cost and lease fencing (2026-11-19)

| | |
|---|---|
| **Status** | Append-only design amendment (corrected by §9 for the R6 review). It records the owner's decisions on the three questions that Addendum 9 §7 left open, the specification and test changes made to apply them, and the corrections for the R5 independent review of #325 at `3cf36cc` (CLEAN_WITH_MINOR: MINOR-1, MINOR-2, NIT-1 to NIT-3). **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner decisions Q1, Q2 and Q3 (reaffirmed 2026-11-19), quoted in §2. R5 specification refinement only. |
| **Amends** | `jobs-and-idempotency.md`: §4.1 (new step 8, *Lease fencing*), §4.2 (`cancelRequested` row), §4.4 (dispatch record bullet; sweeper sentence), §5A (modelled list), §5B.2 (new item 5), §6.3 (durable state, atomicity, charge rule, crash recovery, row T18, new rows T25–T26, notes on T5, T18 and T25–T26). `ledger-and-billing.md`: §2.5 (new paragraph *Committed work and stale workers*), §3.1 (new paragraph *Dispatch record and cost recovery*), §6 (new row *Dispatch vs cost*). `retention-and-deletion.md` §1 class (c) contents. `../api-platform-prd.md` (changelog row "4 (A10)"). `README.md`. The reference model and its spec. |
| **Does not change** | The ledger policy (`ledger-and-billing.md` §2.4–§2.5, OD-8), owner ruling E1 (Addendum 8) and the owner rule of Addendum 9 §2. No price, fee, tariff, status code, error code, identity or research change. Addenda 1–9 are append-only and are not edited; they are superseded only where §6 says so. `openapi.yaml` and `error-catalog.md` were checked: nothing in them changes (`lease_lost` and the dispatch record are internal and never appear in a response). |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `3cf36cc` |

## 1. What was open

Addendum 9 §7 left three questions undecided:
- **Q1 (T18).** A retried `panel` step that finds a cancellation. `jobs-and-idempotency.md` §4.2 read "full release"; `ledger-and-billing.md` §2.5 reads "canceled during execution settles for work done". The table marked the charge `unresolved`.
- **Q2.** The cost of a provider call whose worker died after the provider returned and before the call record committed. No cost entry was written.
- **Q3.** Whether a worker that has lost its lease may still commit a terminal transition. Two outcomes were possible for one race.

The R5 review also found that two tests pinned the open answers (MINOR-1), that the exact 30 % boundary of the soft failed-job ratio was untested (MINOR-2), and three NITs.

## 2. Owner decisions (binding)

- **Q1.** "Bill only durably committed, usable work that qualifies under the existing approved settlement tariff. A crash does not erase already committed billable work; uncommitted work is not billable."
- **Q2.** "Maintain internal provider-cost accounting independently from customer charges. Record incurred costs, including failed or uncommitted calls, when supported by reliable evidence."
- **Q3.** "Workers that have lost their lease must not commit final transitions or charges. Use fencing and controlled recovery to reconcile previously committed work."

## 3. Consistency review of Addendum 9 and T1–T24

Every row of `jobs-and-idempotency.md` §6.3 was checked against the decisions, E1 and the Addendum 9 rule.

| Row | Rule | Finding |
|---|---|---|
| T1–T3 | Queued cancel, DELETE and expiry: no committed work, charged 0 (ledger §2.5) | Consistent |
| T4 | A committed call is committed usable work (ledger §2.5 *Settlement source*) | Consistent |
| T5 | Uncommitted work is not billable (Q1) | Consistent for the charge. **Conflicts with Q2** for cost: the note said the cost entry "is lost with the worker". Corrected (§4) |
| T6–T9 | Lease expiries below the bound and pending requests settle nothing | Consistent |
| T10–T13 | Stop at a safe boundary settles committed usable work (ledger §2.4, §2.5) | Consistent with Q1. **Q3 adds a condition:** the stop commits only while the worker's lease is current (§4) |
| T11 | Same | **R5 NIT-3:** §4.2's synthesis column read "finalize with work done", while §3, §6 and T11 say `canceled`. The charge is the same. §4.2 reconciled to `canceled` (§4) |
| T14–T17 | Crash recovery: `failed: worker_timeout`, charged 0, whatever is pending (Addendum 9 rule, E1) | Consistent. Under Q1 only work that **qualifies under the tariff** is billed, and E1 makes every `failed` job charged 0 whatever it committed. See §7 OQ-A |
| T18 | Q1 | **Decided:** `canceled`, charged the committed usable work, the rest released. §4.2's "full release" is the special case with nothing committed |
| T19–T21 | Finalize and job failure settle under ledger §2.4–§2.5 | Consistent |
| T22–T24 | Late results, duplicate terminal events and DELETE of a terminal job change nothing | Consistent. Q2 refines T22: the late result's cost is recorded once per call attempt |
| *(not covered)* | Q3 | **Gap.** No row covered a worker whose lease was revoked. Added as T25–T26 (§4) |

No owner decision contradicts another, so nothing had to stop. Two places need owner confirmation (§7).

## 4. Design

| Item | Design |
|---|---|
| Lease fencing (Q3) | `jobs-and-idempotency.md` §4.1 step 8. The fencing token is the job's `leaseEpoch` (incremented by every grant) with its recorded `leaseExpiries`. Recording an expiry revokes the lease. Every worker transaction that writes a call record, step output, an advance or a terminal transition commits only if the token is still the one the worker was granted. The read is version-checked, so a revocation that commits during the transaction aborts it and the retry is refused. The sweeper and API transactions hold no lease and are conditional on state, as before |
| Controlled recovery (Q3) | Committed call records of a revoked lease stay committed. A retried step under a new lease replays them (§4.4) and the job's single terminal transition settles them; otherwise the sweeper ends the job (T14–T17). The first committed terminal transition still wins (§5B) |
| T18 (Q1) | The retried step's start check ends the job `canceled` and settles the committed usable work (ledger §2.4); uncommitted work is not billed |
| Dispatch record (Q2) | `ledger-and-billing.md` §3.1. A content-free record is written before each provider request. The call's cost entry is created exactly once, by the call-record transaction, by a refused result (late or fenced), or by the sweeper from the dispatch record (estimate, `costEstimated: true`) once no worker can still commit the call |
| Two ledgers (Q2) | The cost ledger and dispatch records are never an input to a charge; the customer ledger never reads them. Each is conserved on its own: per job, charged + released = reserved; per call attempt, exactly one cost entry |
| Soft ratio (MINOR-2) | Unchanged threshold. The model compares in integer percent (`failed × 100 > 30 × jobs`), so exactly 30 % is not soft |

## 5. Tests (reference model; doc-parsed)

`docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts`, describes "Addendum 10 …" and the Addendum 9 describes they amend.

**Failing first.** Commit `474b1b0` added the tests, with model seams that behave as the documents stood (no fencing, no cost recovery). 15 failed; the fix follows in a separate commit.

- **Table.** §6.3 is parsed: rows T1–T26. `unresolved` is no longer a valid value. The Pending expansion of every row is derived from the cell's own words, and the number of executed cases is computed from the parsed cells, so a row that loses a pending case fails (R5 NIT-2). Every stop, crash and fencing row must name both `cancel` and `DELETE`.
- **MINOR-1.** The test of a crash before the call record commits now drives the recorded expiry and the retried step and asserts exactly the committed usable work (Q1) and the recovered cost (Q2). The slow-worker test now revokes the worker's lease first and asserts the single outcome `failed: worker_timeout`, charged 0, with the worker fenced (Q3). A second test enumerates every interleaving of the worker's stop with the revocation: exactly one of them commits.
- **MINOR-2.** Literal expectations at and around 30 %: 6/20 and 9/30 (exactly 30 %, not soft), 7/24 (29.2 %), 8/27 (29.6 %), 7/23 (30.4 %), 8/26 (30.8 %), 7/20 (35 %), and 19 jobs above 30 % (not soft). They are also checked against the parsed threshold in integer arithmetic.
- **Stale workers.** A revoked worker makes no call, commits no call record and no terminal transition; its result's cost is recorded; the new lease holder re-issues the unrecorded call and settles once. A revoked worker's stop is refused with none, `cancel` or `DELETE` pending, and recovery writes the same settlement in all three cases.
- **Cost (Q2).** Exhaustive: 0–3 usable, 0–2 failed and 0–1 uncommitted calls, ending by the sweeper, by a retried step that stops, or by a retried step that finalizes `partial`. Each case checks one cost entry per dispatch record, the cost total, the charge from an independent oracle, and a customer ledger that holds only `reserve` and `settle`. Late results after recovery, and repeated sweeps, add no entry. Recovery skips a call whose worker still holds its lease.
- **Conservation.** A mixed workload covers every settlement path. The customer ledger is conserved per job and in the balance (initial − Σ charged − open reservations). The cost ledger has one entry per attempt and the expected total. Multiplying every provider cost by 10 changes no customer entry, balance or outcome (×10 keeps the failed-job cost below the hard cost limit, which reads cost by design).
- **Durable partial work and repeated settlement.** Committed calls survive a crash and are settled once by the retried step. For every terminal kind, every later event by every actor changes nothing: one settlement, one release, the same balance.
- **NIT-1.** `newAcceptanceId()` with no argument is spied: it draws exactly once from `crypto.randomBytes` (16 bytes), and the ID is those bytes.
- **Doc rules.** §4.1 *Lease fencing*, §4.2 `cancelRequested` (both columns), ledger §2.5 *Committed work and stale workers* and §3.1 *Dispatch record and cost recovery* are parsed.

These tests do **not** prove the distributed implementation. The API-3 obligations of `jobs-and-idempotency.md` §5B.2 apply, including the new item 5 (lease-fencing and cost-recovery tests with failure injection).

## 6. Supersessions (earlier text not edited)

| Earlier text | Superseded by |
|---|---|
| Addendum 9 §7 Q1, and `jobs-and-idempotency.md` §6.3 row T18 `unresolved` | §2 Q1; T18 settles the committed usable work |
| Addendum 9 §7 Q2, and the §6.3 T5 note "Its cost entry is lost with the worker" | §2 Q2; the dispatch record and cost recovery (ledger §3.1) |
| Addendum 9 §7 Q3, and the §6.3 note "Rows not covered" (two possible outcomes for a slow worker) | §2 Q3; lease fencing (§4.1 step 8), rows T25–T26 |
| `jobs-and-idempotency.md` §4.2 `cancelRequested` before `panel`: "full release" | Settles the committed usable work; a full release when none is committed |
| `jobs-and-idempotency.md` §4.2 `cancelRequested` before `synthesis`: "finalize with work done" | `canceled`, settling the committed usable work (as §3, §6, T11). The charge is unchanged |
| Addendum 9 §8: "Statistics also hold over 64 IDs drawn through T-create" | That test checks only that consecutive T-create IDs differ in at least 24 bits; the bit statistics are over the 4,096 default IDs. The default generator itself is now checked directly (§5, NIT-1) |
| Addendum 9 §8, the slow-worker bullet ("identical outcome sets for `cancel` and `DELETE`") | One outcome when the lease was revoked (§5, MINOR-1) |

## 7. Owner questions (not decided here)

*Revised by the R6 corrections (§9): OQ-A and OQ-C are reworded, and OQ-B is now also marked inline in `jobs-and-idempotency.md` §4.2.*

- **OQ-A. Q1 and sweeper-ended jobs.** The same committed usable work is billed or not depending on how many leases expire before the job ends:
  - one crash, then a cancellation found by the retried step (T18): `canceled`, the committed usable work is charged;
  - the same crash with the same cancellation pending, where the third expiry comes before any retried step (T15): `failed: worker_timeout`, charged 0.

  Two options, presented neutrally:
  1. **Keep E1 at 0** for every `failed` job, including sweeper-ended ones. This is what the documents say today and what this addendum applies. The asymmetry above remains.
  2. **Bill committed usable work for sweeper-ended jobs.** This removes the asymmetry, but it changes E1 (Addendum 8) and the Addendum 9 rule (T14–T17), and it needs a new owner ruling.
- **OQ-B. Other step-start cancellations at a retried panel step.** §4.2 still reads "→ `canceled`, full release" before the `panel` step for an org suspension, a hard abuse state and the platform spend ceiling. Those rows are now marked "open: Addendum 10 §7 OQ-B". On a retried `panel` step with committed calls, the reading of Q1 applied to T18 would settle that work instead. The documents do not decide this, and the transition table does not cover it.
- **OQ-C. May an estimate from a dispatch record alone count toward the customer-facing failed-job gate?** A dispatch record is written before the request is sent, so the request may never have been sent. The estimate it yields is the §3.1 upper bound, and it often comes from a platform-caused `worker_timeout`. Today `ledger-and-billing.md` §3.1 lets it count toward the failed-job provider-cost limit (§4.3). That limit drives the customer-facing `403 failed_job_threshold_exceeded` and `abuseState = review`, not only margin reporting. The documents mark this as pending OQ-C. Options:
  - it counts, as written now;
  - it counts only toward the platform spend ceiling and margin estimates, never toward the customer's gate;
  - it counts only after a provider usage report or invoice confirms the call was sent.
- **OQ-D. §4.2 synthesis column (confirmation of a wording reconciliation).** §4.2 now says `canceled`, matching §3, §6 and T11. Before, it read "finalize with work done". The charge is the same either way.

## 8. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.

## 9. R6 corrections (independent review of `97fcb15`, NOT CLEAN: 1 MAJOR)

| Finding | Correction |
|---|---|
| **MAJOR-1.** The cost-entry and dispatch-record ID `{verId}:{step}:{callKey}` is per call, but a resumed attempt re-issues an unrecorded call under the same call key (§4.4). A T5 crash followed by a re-issue under a new lease collides in either order: the recovered estimate blocks the new attempt's record-and-cost transaction (committed work cannot commit, against Q1), or the new dispatch record overwrites the old one and its cost is lost (against Q2). A fenced result and the new holder's re-issue collide in the same way. The model hid this by drawing a fresh key per attempt | The ID is now **per attempt**: `{verId}:{step}:{callKey}:{leaseEpoch}`, in `ledger-and-billing.md` §3.1 (both places), PRD §12.1 and `jobs-and-idempotency.md` §4.4. The per-call record `steps/{step}/calls/{callKey}` stays per call, so replays find it. The model now reuses the deterministic call key on a re-issue and keys cost entries and dispatch records per attempt. Tests cover both collision orders for the crash case and for the fenced-result case |
| MINOR-1 | The §4.2 suspension, hard-abuse and spend-ceiling rows are marked "open: Addendum 10 §7 OQ-B" |
| MINOR-2 | OQ-C is reworded (§7). §3.1 marks the current counting as pending OQ-C |
| MINOR-3 | Test: a revocation committed between a retried step's grant and its stop refuses the stop |
| NIT-1 | The model's lease transaction can record the unrecorded expiry it replaces (§4.1 step 8). The re-grant test now uses it, so it no longer contradicts §4.4 (a redelivery during a live lease is a no-op) |
| NIT-2 | README row 23 and the PRD changelog "4 (A10)" now state that sweeper-ended `failed` jobs stay at 0 under E1 (OQ-A) |
| OQ-A | Reworded (§7) to state the T18/T15 asymmetry and both options neutrally |

