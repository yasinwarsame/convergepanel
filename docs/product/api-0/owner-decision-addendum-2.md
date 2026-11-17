# API-0 Owner Decision Addendum 2: quality-audit disposition and contract corrections (2026-11-17)

| | |
|---|---|
| **Status** | Append-only design amendment. It records the owner's disposition of the API v1 quality and acceptance audit and the contract corrections made in response. **It authorizes no implementation stage and no merge.** |
| **Authority** | Product owner, disposition of the quality and acceptance audit (`ConvergePanel-Deployment-Evidence/2026-11-17-api-v1/03-quality-and-acceptance-contract.md`), 2026-11-17, and the owner-authorized documentation and contract correction round on PR #325 |
| **Amends** | `openapi.yaml` (0.2.0-draft → 0.3.0-draft), `../api-platform-prd.md` (appended notes in §9 and §9.5, changelog row), `jobs-and-idempotency.md` §5 (appended note), `result-schema.md` §2 (appended note), `tenancy-and-auth.md` §3 (appended note), `README.md`. Adds `error-catalog.md` |
| **Does not change** | Any owner ruling: OD-1..OD-21 (PRD §21), Addendum 1 D1–D10, OQ-1..OQ-5 and §1.1 (P1 no sync wait, P2 no fallback, P3 no full model text, P4 single-owner orgs, SB, Q, R, S, I, PV). Every beta exclusion of Addendum 1 §4 (synthesis, sync wait, fallback, `retain_input`, full model text, webhooks, SDKs, Stripe API plans, video, BYOK, MCP, batch, invites) is preserved |
| **Wins over** | Addendum 1, the PRD and this set **only** where it says so below. Addendum 1 still wins over the PRD and this set elsewhere |
| **Baseline** | PR #325 branch `docs/api-0-amendment-1` at `75c2b86` |

## 1. Owner disposition of the quality audit

| # | Disposition |
|---|---|
| A-1 | The quality and acceptance contract (`03-quality-and-acceptance-contract.md`) is a **preliminary artifact, not frozen**. |
| A-2 | Findings **C-1, C-2 and C-5 need resolution**. |
| A-3 | **PR #325 is NO-GO** until it is corrected and re-reviewed. |
| A-4 | **PR #326 is gated on #325.** |
| A-5 | **PR #327 is NO-GO.** |
| A-6 | **C-5:** do **not** restrict research automatically to nine schemas. The beta uses a **beta-supported schema allowlist based on demonstrated quality**. A research request whose schema is not on the allowlist is **rejected before job creation and before credit reservation**, with a stable documented error. **The scope decision is pending owner approval.** |
| A-7 | The benchmark thresholds in the audit are **proposals, not frozen**. |

## 2. Supersession of the earlier #325 release recommendation

The audit **supersedes** the earlier release recommendation for #325: the exact-head review record `issuecomment-6948271093`, at head `75c2b86`, marked CLEAN. A later review is not overridden by an earlier clean review. That record stays in the PR history as written; it no longer supports a release decision. #325 needs a new independent review of its corrected head before any approval.

## 3. Findings and their disposition in this commit

| Finding | Severity | Disposition | Where |
|---|---|---|---|
| C-1 | MAJOR (contract) | **Corrected.** `CreateVerificationRequest` is a `oneOf` of `ClaimVerificationRequest` and `ResearchVerificationRequest` with `discriminator.propertyName: type`. A claim requires `input.claim` and forbids `question` and `context`; research requires `input.question`, allows `context` and forbids `claim`; every object is closed. Positive and negative request examples added. `options.synthesis` keeps the documented 422 `synthesis_not_supported` on a claim | `openapi.yaml` `components.schemas`; `error-catalog.md` §4.4 |
| C-2 | MAJOR (security) | **Not in this commit. Left to #327:** the management identity resolver (`uid`, `authTimeSeconds`, `emailVerified`, `disabled`) and the checks. This commit only **reserves** the code `identity_not_verified` (403, management) and records that a disabled account returns 401 `session_required`, so no `account_disabled` code is needed | `error-catalog.md` §2.1 R-9, §3.2 |
| C-3 | MINOR | **Corrected.** Lengths are Unicode code points after NFC; NFC is applied server-side before length checks and idempotency hashing; NUL and other C0 controls (except tab, LF, CR) and lone surrogates are 400 `invalid_encoding`; a wrong media type is 415 `unsupported_media_type`; the body cap is 64 KiB as a **placeholder pending owner sizing** (413 `request_too_large`); `models[]` pattern and length, and `metadata` key pattern, key length, key count and value length are defined; an unknown member at any level is 400 `unknown_field` with `param` | `error-catalog.md` §4; `openapi.yaml` |
| C-4 | MINOR | **Corrected.** One catalog (`error-catalog.md` §2) is the single source, mirrored in `openapi.yaml` `components.x-error-catalog` and pinned by a test. Drift decisions R-1..R-10, including `verification_not_found` (data plane, contract name; the implementation adds it) versus the generic `not_found` (management plane) | `error-catalog.md` §2, §2.1 |
| C-5 | MAJOR (report usefulness) | **Pending owner approval** (A-6). This commit only adds `research_schema_unsupported` (422) to the catalog as **proposed, pending owner approval of the C-5 scope decision**. It is an error code, not a section availability value; no new availability value is introduced | `error-catalog.md` §2, §2.1 R-10 |
| C-6 | MINOR | **Corrected.** Normative precedence for the data plane and the management plane, with privacy rules. Beta-unavailable options (422) are evaluated before organization-setting 403s | `error-catalog.md` §3 |

Not addressed here: audit item Q (re-dispatch with the same message ID; Addendum 1 §1.1 Q, to be resolved before API-3) and D-1 (doc/code naming drift, the #327 reconciliation).

## 4. Open items this addendum creates

1. **Body cap sizing.** 64 KiB does not admit a maximal-length research request in most non-Latin scripts (`error-catalog.md` §4.3). Owner sizing decision needed.
2. **C-5 scope.** The allowlist, how the executed schema is known before reservation, and whether `research_schema_unsupported` is approved (`error-catalog.md` §3.1 step 7g).
3. **#327 must** add `verification_not_found` and `identity_not_verified` to `lib/apiPlatform/errors.ts`, and a test in `lib/` that pins `errors.ts` to `error-catalog.md`.
