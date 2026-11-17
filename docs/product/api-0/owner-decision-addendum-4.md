# API-0 Owner Decision Addendum 4: R2 disposition (2026-11-17)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's disposition of the open items of [Addendum 3](owner-decision-addendum-3.md) (Quality Correction R2) and of the independent review of #325 at `e347758`, and the single stabilization pass made in response. **It authorizes no implementation stage, no release and no merge.** |
| **Authority** | Product owner, rulings of 2026-11-17 ("R2 disposition"), including a narrowly scoped authorization to change `package.json` and `package-lock.json` for one devDependency (ruling M6) |
| **Amends** | `error-catalog.md` (§2.2, §3.1, §3.4, §4.3.1, §4.5), `jobs-and-idempotency.md` (§4.2, §5A, new §5B, §6, new §6.1), `openapi.yaml` (cancel 410, response descriptions), `README.md`, `threat-model.md`, `../api-platform-prd.md` (changelog row "4 (A4)", §9.3 note), `package.json` and `package-lock.json` (`js-yaml` only) |
| **Does not change** | Addenda 1, 2 and 3 (append-only; not edited; superseded only where §2 says so). Any other owner ruling: OD-1..OD-21 except the OD-5 narrowing in ruling CC, Addendum 1 D1–D10, OQ-1..OQ-5 and §1.1 (P1–P4 and the rest), Addendum 2 A-1..A-7, Addendum 3 R1–R4, AL, CL, R-7. Every beta exclusion is preserved |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `e347758` |

## 1. Owner rulings

| # | Ruling |
|---|---|
| B | **Body cap: keep 512 KiB raw** (524,288 bytes). A request over the limit gets 413 **even when its NFC field lengths would fit**, including heavily escaped or non-NFC Unicode. Valid non-NFC text remains accepted: **no NFC rejection and no additional raw bound.** The options of Addendum 3 §4 item 1 are closed as decided: **option (d)**. |
| MA | **Metadata aggregate of 4,000 code points is approved as a PROVISIONAL contract limit.** Explicit tests are required for key count, key length, value length, the aggregate (exactly at and over), and Unicode (supplementary and combining characters) in keys and values. |
| M6 | **Authorized:** a narrowly scoped `package.json` and `package-lock.json` change declaring `js-yaml` explicitly as a devDependency, at the version the lockfile already resolves (4.1.1, exact). The guard test must require the set of undeclared imports under `docs/__tests__/` to be **empty**. **Review, do not implement,** whether the bespoke JSON Schema subset validator should be replaced by an explicitly declared, standards-based validator; that would be a further package change needing owner approval. No other dependency is added. |
| DM | An authorized request referencing an **unexpired deleted idempotency marker** gets **410 whatever its body**. Deleted request content is **not retained** to compare hashes. |
| CX | `cancel` on the caller's own **deleted** verification returns **410** `verification_deleted` (not 409), with identical privacy protections: a foreign or nonexistent verification stays 404. |
| RL | **The broad shared-IP failed-authentication lockout is rejected.** It is replaced by a layered, cost-aware design: edge and IP limits only as coarse abuse protection, with high ceilings and **no lockout of other tenants' valid credentials**; per-credential limits, including failed-authentication throttling keyed by the **presented key ID**, not the IP; per-organization limits. **All numeric values are placeholders to be set by load testing**; no SLO is frozen. |
| CC | **Concurrency: exact control for accepted jobs; no over-admission across distinct keys.** Organization and plan concurrency accounting is **Firestore-transactional**: the counter is in the same transaction as the credit reservation and the job create. The Redis-class store is used **only for provider permits**. Recovery and release invariants are specified: release on terminal state, sweeper reconciliation, lease expiry, no negative counts, idempotent release. |
| D6W | **Withdrawing the D6 provider-processing acknowledgement** does not undo a completed provider call, but **prevents new provider calls once effective**: a queued job is canceled with a full release; a running job stops before its next provider call, settles completed work and releases the remainder. Idempotent replays that cause no new processing remain readable where authorized. It is **not** a "new jobs only" condition. |
| TS | The contract tests and the reference model **do not prove the distributed implementation**. API-3 integration, emulator, fault-injection and isolated-environment tests are required. |

## 2. Supersessions (Addendum 3 is not edited)

| Addendum 3 item | Superseded by |
|---|---|
| §3 row B and §4 item 1 (body cap options, "OWNER DECISION REQUIRED") | Ruling B: option (d). `error-catalog.md` §4.3.1 now reads "DECIDED (Addendum 4, ruling B): option (d)" |
| §4 item 2 (deleted marker and a different request, for owner confirmation) | Ruling DM: confirmed |
| §4 item 3 (D6 acknowledgement classified as new-job-only on replay) | Ruling D6W. The replay itself still returns the original body (no new processing); the job it names is canceled or stopped (`jobs-and-idempotency.md` §4.2, §5A.1, §6) |
| §4 item 5 (metadata aggregate placeholder) | Ruling MA: provisional contract limit |
| §3 row m6 and §4 item 6 (`js-yaml` undeclared) | Ruling M6: declared; m6 is now fully corrected |
| §4 item 7 (rate-limit layering; shared-NAT lockout) | Ruling RL (`error-catalog.md` §3.4) |
| §4 item 8 (Redis concurrency over-admission) | Ruling CC (`jobs-and-idempotency.md` §5B). Also narrows OD-5 (PRD §9.3) for the per-organization concurrency counter only; rate windows and provider permits stay in the Redis-class store |
| §4 item 9 (cancel on a deleted verification → 409) | Ruling CX: 410 |

## 3. Engineering decision awaiting owner confirmation (not a ruling)

**Defaults are not filled in before hashing.** A create request that omits a member and one that sends that member's default explicitly (for example no `options` versus `options: { synthesis: false }`) are different canonical requests, so the second gets `409 idempotency_key_reused`. Fail-safe: never a wrong replay and never a second job. Recorded in `error-catalog.md` §4.5 and `jobs-and-idempotency.md` §5A; pinned by a reference-model test. This was attributed to Addendum 3 by mistake; it is not an owner ruling. Owner confirmation requested.

## 4. Package change (ruling M6)

- `package.json` `devDependencies`: `"js-yaml": "4.1.1"`, one line.
- `package-lock.json` root package (`packages[""].devDependencies`): `"js-yaml": "4.1.1"`, one line. The existing `node_modules/js-yaml` entry (4.1.1, `dev: true`, same integrity) is unchanged.
- Made as a minimal manual edit: the worktree's `node_modules` is a symlink to another worktree, so `npm install` was not run in place. Validation: `npm ls js-yaml` → `js-yaml@4.1.1`; and in a scratch copy with the repository's `.npmrc` (`legacy-peer-deps=true`), `npm install --package-lock-only` left the edited lockfile byte-identical.

## 5. Review: replace the bespoke validator with a declared standards-based one? (not implemented)

| | Bespoke subset validator (`docs/__tests__/support/jsonSchemaSubset.ts`, current) | Declared Ajv 8 (`ajv@8` exact as a devDependency; `ajv-formats` only if a `format` keyword is ever used, which the request schemas do not) |
|---|---|---|
| Dependencies | none | one (two with formats); a package change needing owner approval |
| Standards conformance | only what its own tests and the Ajv differential cover; not run against the JSON-Schema-Test-Suite | Ajv 8 is widely used and tested against the official JSON-Schema-Test-Suite for draft 2020-12 |
| Fail-closed on unknown keywords | yes (throws at compile time) | with `strict: true`; but OpenAPI's `discriminator` and the `x-cp-max-total-code-points` vendor keyword then need explicit handling (strip `mapping`, register a custom keyword) |
| Unicode | code-point lengths and `u`-flag patterns, tested | the same by default (`unicodeRegExp: true`) |
| Maintenance risk | semantics can drift from the standard, and every new keyword needs code and tests | the version must be pinned; upgrades can change behaviour |
| Lockfile effect | none | Ajv 8 is already in the lockfile only as `ajv-formats`' nested dependency; declaring it at the root hoists it and changes more of the lockfile than this pass's one-line edit |

**Recommendation.** Replace the bespoke validator with a declared, exactly pinned Ajv 8 in a **separate, owner-approved** change, and keep the bespoke validator only for the length of one release as a differential oracle. A standards-based validator is the stronger evidence for a public contract, and the dependency is development-only. Until that approval, keep the current validator: it is fail-closed and agreed with Ajv on every payload tested.

**What a complete equivalence case would require** before either validator is trusted as a replacement for the other:
1. both compile the **same** dereferenced schema (the request schema and every schema they will validate);
2. the official JSON-Schema-Test-Suite (draft 2020-12) cases for every keyword the subset supports (`type`, `const`, `enum`, `allOf`, `anyOf`, `oneOf`, `not`, `properties`, `required`, `additionalProperties`, `propertyNames`, `minProperties`, `maxProperties`, `minLength`, `maxLength`, `pattern`, `items`, `minItems`, `maxItems`, `uniqueItems`, `minimum`, `maximum`), with zero disagreements;
3. discriminator cases: missing, non-string and unknown tags, and branches that do and do not list the tag in `required`;
4. Unicode cases: supplementary characters in lengths, Unicode property escapes, lone surrogates, combining sequences;
5. the full request corpus (positive and negative examples, the attack corpus, and the sizing-tier bodies) plus generated property-based payloads, with zero disagreements;
6. the vendor keyword `x-cp-max-total-code-points` handled identically (a custom Ajv keyword with its own tests);
7. identical fail-closed behaviour for unsupported keywords;
8. both versions pinned exactly, and the equivalence run in CI.

## 6. Changes in this pass

| Item | Change | Where |
|---|---|---|
| B | §4.3.1 closed as decided (option d); 413 even when NFC lengths fit; non-NFC accepted | `error-catalog.md` §4.3.1 |
| MA | Explicit metadata tests: key count 20/21, key length 40/41, value length 500/501, aggregate 4,000/4,001, supplementary values and aggregate, decomposed values that NFC to the limit, non-composing marks, non-ASCII keys | `apiOpenapiRequestContract.spec.ts` "Addendum 4 MA" |
| M6 | `js-yaml@4.1.1` declared; the guard now requires the undeclared-import set to be empty | `package.json`, `package-lock.json`; `apiOpenapiRequestContract.spec.ts` "m6: no undeclared package…" |
| DM | Marker keeps only `kind`, `verificationId`, `expiresAt`; 410 for same, different and NFC-equivalent bodies | `jobs-and-idempotency.md` §5A.3 T17/T18; spec "Addendum 4 DM" |
| CX | Cancel → 410 for the caller's own deleted verification; foreign deleted, nonexistent and malformed IDs give the identical 404 | `openapi.yaml` cancel; `error-catalog.md` §3.1; `jobs-and-idempotency.md` §6, §6.1 (parsed table); spec "Addendum 4 CX" |
| RL | Coarse edge limit (no lockout), failed-auth throttle per presented key ID, per key, per organization; all placeholders | `error-catalog.md` §3.1 steps 2–3, §3.4 |
| CC | Active-job count in the period document inside T-create; release only with the terminal transition; reconciliation; distinct-key races at the limit never exceed it | `jobs-and-idempotency.md` §5A.2, §5B; spec "Addendum 4 CC" |
| D6W | Queued research jobs canceled with full release; running ones stop before the next provider call | `jobs-and-idempotency.md` §4.2, §5A.1, §6 |
| TS | Statement that the tests do not prove the distributed implementation | `README.md`; this addendum ruling TS |
| Review MINORs | Sizing verdict cells asserted on every runtime; defaults attribution corrected (§3); the reference-model omission wording corrected | `apiRequestBodySizing.spec.ts`; `error-catalog.md` §4.5; `jobs-and-idempotency.md` §5A |

## 7. Merge status

Unchanged: #325 needs an independent review of this head, a fresh approval after that review's record, and an owner merge instruction.
