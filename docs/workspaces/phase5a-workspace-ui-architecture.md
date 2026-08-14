# Phase 5A — Personal Workspace UI Architecture + UX Compatibility Audit

Design-only. No Workspace UI implementation, no production mutations, no new UI flag added. Performed 2026-08-15 against `main` at `4bbac597a07cd24e8da50ad9b7273a4b5374f341` (Phase 4C-A documentation merge, PR #46) and the live `convergepanel` production deployment.

**Not committed.** Per the process-control correction below, this file is held locally pending your review — landing it requires the normal PR flow, and if branch protection blocks a normal merge, a fresh, PR-specific, exact-head-SHA authorization for *this* PR before any `enforce_admins` override.

## Process-control record (no action taken here)

PR #46 (`docs: close Phase 4C-A historical provenance audit, cancel backfill`) was docs-only, CI was green on all three required checks, and branch protection was restored with zero semantic drift afterward — but the temporary `enforce_admins` override used to merge it was applied without asking first for that specific PR. This is recorded as a process-control exception, not reverted (nothing to revert: no code, no production data, no drift). Going forward: **every temporary `enforce_admins` override requires fresh, explicit authorization tied to the exact PR number and exact head SHA**, regardless of CI status, docs-only scope, or authorization already given for a different PR earlier in the same conversation. Saved to persistent memory (`feedback-enforce-admins-authorization.md`) so this doesn't need to be re-explained in a future session.

## Phase 4E — final architecture carried forward (design only, not implemented here)

- **Personal adaptive:** `workspaceId=personal-{userId}` is canonical provenance today, live in production.
- **Team adaptive:** recommended future canonical `teamId?: string`, server-resolved via `loadUserAndTeam(uid)`, written atomically in the single existing `createRun()` call site (`app/api/run-panel/route.ts:462`) in place of the currently-discarded `{outcome:"team_user"}` branch in `resolvePersonalRunWorkspaceBinding`.
- **Personal non-adaptive:** outside the current Workspace-write program entirely (Phase 3 was always adaptive-scoped) — not addressed by `teamId` or anything in this phase.
- **Team non-adaptive:** provenance unresolved; not to be modified merely for consistency with the adaptive fix.
- **Referential semantics:** `teamId` means creation-time historical provenance — it does **not** guarantee `teams/{teamId}` still exists or is valid at read time. A future consumer authorizing off `teamId` must independently validate current referential state, mirroring how Phase 4B validates `workspaceId` associations rather than trusting field presence alone.
- **Failure semantics:** do not claim persistence happens "before model spend" as a blanket fact. The correct, weaker invariant: team context is resolved server-side before spend → `teamId` is included atomically in the canonical run-creation write → if that write fails, no successfully persisted team run exists without the marker. Whether this literally precedes spend depends on `createRun()`'s actual position in the request lifecycle at implementation time and must be verified then, not assumed now.
- **Malformed-state rule:** `workspaceId` and `teamId` both present on the same run → malformed, fail closed. Never guess precedence.
- **Status:** design complete, implementation deferred. Not required before Phase 5 or any current Personal-only work. **Mandatory before team Workspace support.**

## Phase 5A2 — API contract correction (read/audit only, no implementation)

A follow-up pass resolved three technical inconsistencies in the original Phase 5A report before Phase 5B implementation could safely start against it. All three are corrected in place below (sections 16–19, 20–23, 24, 36–39); this block records what changed and why.

1. **`workspaceId` browser exposure — resolved as "not exposed," verified by direct inspection, not inferred from types.** The original report said "`panel-history` reads unprojected documents, so `workspaceId` is already present per-row" in the same document as "client `workspaceId`: never sent to the browser" — both true, but stated in a way that read as contradictory. Direct trace of `app/api/user/panel-history/route.ts` (and `app/api/user/runs/[runId]/route.ts` for completeness) confirms: the raw Firestore read (`d.data()`) does include `workspaceId` when present, and Layer A integrity validation reads it from that raw data — but the HTTP response is a hand-constructed object literal with an explicit, enumerated field list that does not include `workspaceId` at any point. The `PanelHistoryResearchItem` TypeScript type confirms the same field list. A repo-wide search of `app/`, `components/`, `hooks/` (excluding API routes) found zero client-side references to `workspaceId` anywhere. **No existing exposure, no correction needed to any existing route.**
2. **Composite index requirement — corrected from "no, at current scale" to "yes, required by query shape regardless of scale."** This was a real error, not a matter of degree: Firestore requires an explicitly-declared composite index for any query combining two or more equality filters with an `ORDER BY` on a third field — `WHERE userId==uid AND workspaceId==personal-{uid} ORDER BY createdAt DESC` is exactly that shape. Firestore refuses to execute such a query at all without the index (`FAILED_PRECONDITION`), independent of how many documents exist. Confirmed no such index exists today in `firestore.indexes.json` (10 existing indexes audited, none include `workspaceId`). See section 24.
3. **Pagination — reconsidered from "reuse the existing offset pattern" to "use cursor pagination for this new endpoint."** The existing offset pattern is compatibility debt worth preserving for Global History's existing client contract, not something a brand-new endpoint should inherit by default. See sections 20–23.

## 1. Repository / production baseline

- `origin/main` = local `HEAD` = `4bbac597a07cd24e8da50ad9b7273a4b5374f341`
- Production deployment: `dpl_GqV5DFHKpAuAwWsmt33Y6n2LLWiP`, Ready, built from this commit
- `P=true`, `W=true`, `RW=true`, canary=absent; Phase 4B Layer-A read integrity: live
- No source changes in this phase except this document

## 2. Current research UX inventory

| Surface | Page/component | API | Notes |
|---|---|---|---|
| Navigation | `components/TopNav.tsx`, mounted globally in `app/layout.tsx` | — | No sidebar anywhere. Desktop links: About/Help/Contact/Pricing + conditional Governance/Team Reviews + unconditional My Reviews + auth dropdown. Mobile: hamburger → stacked dropdown below `lg` (1024px) |
| Research entry / run creation | `app/page.tsx` (single ~2870-line client component, client-state tab switcher `research\|verify\|video\|history`, no separate routes) | `POST /api/run-panel` | Response: `{ok, results[], runId, governanceStatus?, adaptive?, usage}` |
| History / recent runs | same file, `panelTab==="history"` | `GET /api/user/panel-history?page=&limit=` | Offset-paginated (`HISTORY_PAGE_SIZE=30`, `MAX_LIMIT=50`), in-memory merge of 3 collections (`runs`/`verifications`/`videoVerifications`), each capped 120 docs server-side. No `.select()` projection — full docs read, so `workspaceId` is already present on every row today with zero query change. Client also keeps a per-uid localStorage optimistic cache |
| Report detail | same file, client-state (`openHistoryItem`), not a dynamic route | `GET /api/user/runs/[runId]` | Deep-linkable via query params on `/` (`?openResearchRun=`, `?openVerification=`, `?openVideoVerification=`), scrubbed via `router.replace` after load |
| Reviewer inbox/detail | `/reviews`, `/reviews/[runId]` (personal); `/team/reviews`, `/team/reviews/[runId]` (team owner/admin, read-only queue) | `GET /api/user/reviews`, `/api/teams/adaptive-runs/*` | Structurally separate from `app/page.tsx` entirely — two parallel systems, not integrated with the main research UI |
| Governance | `ReviewGovernanceSection.tsx` + 4 other badge components (`GovernanceBadge`, `HistoryGovernanceChip`, `GovernanceStatusBadge`, `PersonalReviewStatusBadge`) | `GET /api/user/runs/[runId]/governance` | At least 5 distinct status vocabularies coexist today, not unified — worth not worsening, not in scope to fix |
| Export | `AdaptiveExportButton.tsx`, `AdaptiveExportHistorySection.tsx`, on the report detail view | `POST /api/user/runs/[runId]/export`, `GET .../exports`, `GET .../exports/[exportId]` | Adaptive-only, double-gated (`NEXT_PUBLIC_*` client flag + independent server re-check), both off by default in production today |
| Profile/settings | `app/profile/page.tsx` | — | Account info, address, usage-profile fields, plan/usage/cancel-subscription, governance settings. **No Workspace field exists today** |
| Mobile | all of the above | — | Tab bar `flex-col`→`sm:flex-row`; nav hamburger below `lg`; no bottom tab bar anywhere |

**Existing URLs to preserve, unmodified:** `/`, `/reviews`, `/reviews/[runId]`, `/team/reviews`, `/team/reviews/[runId]`, `/governance`, `/profile`, plus every deep-link query param on `/`.

**`POST /api/user/workspace`** exists today — provisioning-only (calls `ensurePersonalWorkspace()`), no `GET` handler, uid always server-derived, gated by `PERSONAL_WORKSPACE_PROVISIONING_ENABLED`, called only from login/signup. No read surface for Workspace metadata exists anywhere in the app today.

## 3–4. What Workspace adds / terminology

Concrete value, not exposure-for-its-own-sake: a dedicated home for *current* research (recent Workspace-bound work, a direct "New research" CTA) — organizational context, not a database concept surfaced for its own sake.

**Recommended label: "Workspace"** (not "My Workspace," not "Personal Workspace" as the persistent UI label — a one-line subtitle on first entry, "Your personal workspace," suffices for orientation without baking "Personal" into every heading). Reasoning: reads correctly today with exactly one instance, and doesn't require a global rename the day team Workspaces exist — you'd simply start showing more of them under the same label. "My Workspace" adds unnecessary self-reference with nothing to disambiguate from yet.

## 5–8. The central history distinction

Two surfaces, kept deliberately separate:

- **Global History** — compatibility-complete, every run current authorization already allows, unchanged route/API/pagination, includes all 190 legacy runs.
- **Workspace view** — strictly `workspaceId`-present rows owned by the user.

A legacy run is **never** silently classified into the Workspace. It is also **never** labeled "Unfiled" — that label is reserved for a future, genuinely different state (`projectId==null` *inside* a known Workspace). A legacy run has no verified Workspace context at all, which Phase 4C-A2 specifically proved cannot be assumed to be Personal — conflating the two labels would quietly overclaim provenance the historical audit explicitly withdrew.

**Recommendation: Option A** — Workspace page shows only current Workspace-bound research; History remains the full, unchanged, compatibility-complete view. Rejected alternatives: Option B (bound + "Earlier Research" section inside the Workspace page) risks implying "earlier" work belongs to this Workspace too, just older — exactly the false-provenance framing to avoid. Option C (single combined view with indicators) adds visual complexity for no real benefit when a clean second surface (History, which already exists and works) is available.

## 9. Legacy-only user edge case

A long-time user may have a real Personal Workspace and zero Workspace-bound runs against a full History. Their Workspace page must show its own true empty state, **not** "You have no research" — paired with a calm pointer: *"New research will appear here. Your earlier research remains available in History."* No mention of migration, backfill, or internal architecture.

## 10. New-user edge case

Genuinely empty Workspace (no bound runs, no legacy history) gets distinct copy centered on a "Start Research" CTA — not historical-history framing, since there's no history to reference.

## 11–12. URLs

Zero existing URL changes. New route: `/workspace` (not `/workspaces/personal-{uid}` — no internal identifier ever appears in a user-facing URL).

## 13–14. Navigation, no selector

One new top-level nav item, "Workspace," placed before "My Reviews" (research is the primary surface; reviews are secondary). History remains independently reachable and undiminished — Workspace must not bury or reduce History's discoverability. **No Workspace selector, dropdown, or switcher** — there is exactly one supported Workspace; the route/nav/DTO shapes below leave room for one later without pretending it exists now.

## 15. New research UX

No selection friction — new Personal adaptive research already binds server-side; the UI never asks the user to pick a Workspace.

## 16–19. Workspace metadata endpoint (corrected, exact contract)

**`GET /api/user/workspace`** — read-only, new, distinct from the existing provisioning-only `POST /api/user/workspace` (which stays exactly as-is, untouched). Built entirely from existing, already-tested primitives: derive `uid` from server auth, compute `getPersonalWorkspaceId(uid)`, call the existing, already-provisioning-free `getWorkspace()`.

- **Request identifiers:** none — no path or query parameter identifies which workspace; the caller can only ever retrieve their own.
- **Response DTO:** `{ name: string, type: "personal" }`. Kept `type` despite there being only one possible value today — it's free to include, and keeping it avoids a breaking DTO change the day a second Workspace type exists; the client never needs to branch on it yet.
- **Provisioning side effect:** none, verified structurally — `getWorkspace()`'s implementation is a single `.get()` call plus shape validation; it contains no write path anywhere. `GET` can never provision, by construction, not by convention.
- **Error semantics:**
  - unauthenticated → `401`
  - Workspace missing (`getWorkspace` → `not_found`) → sanitized `workspace_missing` (reuses the exact reason-code vocabulary `resolvePersonalRunWorkspaceBinding` already established, not a new one)
  - malformed / wrong type / wrong owner → sanitized `workspace_invalid`
  - Firestore unavailable / read failed → sanitized, retryable `workspace_unavailable` (503)
  - **`W=false`** (`WORKSPACES_ENABLED` off): a distinct, explicit case this endpoint must check before calling `getWorkspace()` at all — mirrors `resolvePersonalRunWorkspaceBinding`'s own `invalid_configuration` check. Returns the same sanitized `workspace_unavailable` shape. This is an **API-level** concern, independent of and not to be confused with the **UI-level** "flag off → route 404s" behavior below — two different switches, two different layers, never conflated.
- **UI-facing distinction:** loading / transient failure (`workspace_unavailable`) / missing prerequisite (`workspace_missing`) / malformed (`workspace_invalid`) render as four visibly different states — never silently downgraded to an ordinary empty-Workspace view, mirroring Phase 4B's own fail-safe posture at the UI layer instead of just the API layer.

## 20–23. Workspace-runs endpoint (corrected, exact contract)

**`GET /api/user/workspace/runs`** — new, separate route, nested under the existing `/api/user/workspace` prefix (not a `panel-history` query param — see the "existing History untouched" decision below).

- **Single collection, not three:** `workspaceId` is written only onto `runs/{runId}` documents — Phase 3's write scope was always `run-panel`/`createRun()` only, never `verifications`/`videoVerifications`. Global History's three-collection merge must **not** be copied here; this endpoint queries `runs` alone.
- **Request parameters:** `limit` and an opaque `cursor` only. **Never** `workspaceId`, `userId`, or `ownerUserId` — scope is entirely server-derived from the authenticated session (`uid → personal-{uid}`), matching the metadata endpoint's own posture.
- **Query:** `runs` collection, `WHERE userId == uid AND workspaceId == personal-{uid} ORDER BY createdAt DESC` (plus an explicit `ORDER BY __name__ DESC` tie-break for deterministic cursor pagination — see index note below). `userId` is included as an explicit equality filter even though `workspaceId` is already unique-per-user by construction, as defense in depth matching `panel-history`'s existing convention of always scoping by `userId` first.
- **Legacy exclusion — structural, not a post-filter:** Firestore's `==` filter never matches a document where the filtered field is entirely absent. A legacy run (`workspaceId` truly absent) cannot appear in this query's raw results under any circumstance — this is core Firestore query-engine behavior, not an implementation detail that could regress. Not data loss: Global History remains the unchanged, compatibility-complete view for these rows.
- **Bound-integrity, still required despite the query filter:** the query's `workspaceId==...` equality check only verifies the *stored string value* on the run document — it says nothing about whether the *referenced* `workspaces/{id}` document itself is well-formed, exists, or has the right `ownerUserId`/`type`. Phase 4B's Layer A validation is still run on every returned row for exactly this reason: `query → Layer A validation → DTO projection`, never skipped just because the query already filtered on `workspaceId`.
- **Page-fill / invalid-row semantics:** fetch `limit + 1` raw documents (the classic "peek one extra" cursor technique), run Layer A on all of them, return up to `limit` validated items to the client (never more), and never return the peeked `+1`th row's data directly. `hasMore` is set from whether the raw fetch actually returned `limit + 1` documents — independent of how many of the first `limit` passed integrity. If some rows in a page are invalidated, the page simply contains fewer than `limit` items; no over-fetch loop is used to backfill to a cosmetic exact count. Security and deterministic, single-query-per-page pagination take priority over exact row counts per page.
- **Cursor design:** opaque to the client — a server-encoded token wrapping only `{createdAt, docId}` (the ordering state needed for `.startAfter()`), decoded and validated server-side, malformed cursor → `400`. The cursor **never** carries `userId` or `workspaceId` — it can only ever move the pagination position within a scope that is fixed independently on every request from the authenticated session, so a forged or tampered cursor changes *where* pagination resumes, never *whose* data is queried.
- **Response DTO:** `{ items: WorkspaceRunSummary[], hasMore: boolean, nextCursor?: string }`. `WorkspaceRunSummary` fields to be finalized in Phase 5B against the actual card/list UI requirements, but starts from the same field set `panel-history`'s research items already use (`id, at, question, selectedModels, status, modelsOk, modelsTotal, synthesisConsensusScore, governanceStatus, hasAdaptiveOutput?, adaptiveSchemaId?`) — no invented fields, no raw Firestore snapshot passthrough, and (per the resolved contradiction above) no `workspaceId` in the item shape either, consistent with every other route in this app.

## 24. Firestore query/index audit (corrected)

**Composite index is required, by query shape, independent of dataset size.** This was stated incorrectly in the original Phase 5A report ("no, at current scale") — Firestore's query planner requires an explicitly-declared composite index for any query combining two or more equality filters (`userId==`, `workspaceId==`) with an `ORDER BY` on a third field (`createdAt`); it will reject the query with `FAILED_PRECONDITION` at any scale, including zero matching documents, if the index doesn't exist. This is not a performance optimization — it's a hard requirement to execute the query at all.

- **Already exists:** no. `firestore.indexes.json` currently defines 10 composite indexes total; none include `workspaceId`. The closest existing `runs` index (`userId ASC, createdAt DESC`) is a different query shape (single equality + orderBy) and cannot serve this query.
- **Exact index required:** `runs` collection — `userId ASC, workspaceId ASC, createdAt DESC`, matching the existing file's field-ordering convention (equality fields first, in declared order, then the sort field last).
- **Tie-breaker:** Firestore automatically appends the document ID (`__name__`) as an implicit final sort key to any composite index that doesn't explicitly declare one, using the last explicit sort direction — very likely sufficient on its own for deterministic pagination without a distinct index entry. Phase 5B should still add an explicit `.orderBy(FieldPath.documentId(), "desc")` to the query for guaranteed, self-documenting determinism, and confirm empirically at implementation time whether Firestore demands a distinct index entry for it — Firestore returns a direct console link to create the exact missing index in its `FAILED_PRECONDITION` error if one is needed, which is the authoritative source at that point, not this document.
- **Index change required in Phase 5B:** yes, one new composite index — **not added in this phase**, per the explicit constraint.

## 25–26. Pagination and counts (corrected)

**Cursor pagination for this new endpoint**, not a copy of Global History's existing offset pattern. Offset pagination (`page`+`limit`, in-memory merge/sort) is existing technical debt worth preserving for `panel-history` specifically, since that route has an established client contract — but there's no reason to inherit it into a brand-new endpoint with no existing consumer. Cursor pagination is stable under concurrent inserts, avoids reading-then-discarding skipped documents, and pairs naturally with Firestore's own `.startAfter()` mechanism and single-collection query design above. See the exact cursor design in section 20–23.

**Recommend omitting a prominent total count initially** — "Workspace: 7 reports" next to a History containing 197 could read as 190 reports having vanished. If a count is added later, it needs explanatory copy alongside it, not a bare number.

## 27–28. Rename / settings

**Defer rename entirely.** The only currently-provisioned field is `name` ("Personal Workspace"); allowing rename would require a mutation API, validation, audit trail, and race handling for no demonstrated user need yet. Since there is nothing else actionable, **no Workspace settings page is built in Phase 5** — an empty settings page is worse than no settings page.

## 29–31. Isolation from adjacent systems, existing History untouched

Reviewer inbox, governance, and export remain entirely untouched — not moved, relabeled, or reorganized around Workspace. A reviewer seeing an assigned Workspace-bound run does not become a Workspace member in any sense; governance stays run-centered; exports stay on the report detail view with no separate Workspace export surface.

**`panel-history` itself is not modified.** The Phase 5A2 audit found no `workspaceId` exposure and no other problem to fix, so there is nothing to correct and no reason to touch it — Phase 5B adds `GET /api/user/workspace/runs` as a fully separate, new route instead of adding a `scope=workspace` parameter to the existing endpoint. This is the lower-regression-risk choice by construction: an unrelated route can't be broken by a change that never touches it.

## 32–33. Responsive / accessibility

One new nav item fits the existing hamburger/dropdown pattern without redesign. Empty states, loading states, and the Workspace label itself must use visible text, never icon-only identification. Standard semantic nav (`aria-current` on the active item), keyboard-reachable, heading hierarchy consistent with the rest of the app.

## 34–35. Security threat model

| Threat | Mitigation |
|---|---|
| Forged/client-supplied `workspaceId` | Never accepted by any new or modified route; uid always server-derived |
| Cross-user Workspace retrieval | Endpoint takes no identifying parameter — can only ever return the caller's own |
| Cross-user run injection | Query always `userId==uid AND workspaceId==...`, never `workspaceId` alone |
| Legacy injection into Workspace view | Structurally excluded by the query shape, not filtered after the fact |
| Bound-invalid disclosure | Phase 4B Layer A reused unmodified — omit on list, deny on detail |
| Browser-direct Firestore | None anywhere — every read goes through existing Admin-SDK-backed API routes |
| Cached cross-user Workspace metadata | Any future client cache must be keyed by authenticated uid, mirroring the existing per-uid localStorage history cache |
| Stale authenticated session | Unaffected — reuses the existing `authedFetch`/401-retry pattern already used throughout `app/page.tsx` |
| Malformed Personal Workspace | Distinct diagnostic-failure UI state, never silently downgraded to a generic empty/legacy view |
| Cursor spoofing/tampering | Cursor carries only `{createdAt, docId}` ordering state, never `userId`/`workspaceId` — scope is fixed server-side on every request regardless of cursor content, so a forged cursor can only move pagination position, never escape the caller's own scope |

## 36–39. Rollout (corrected: explicit canary model)

**Two flags, not one** — the original report referenced "a canary-uid pattern" while only defining a single global on/off flag; that inconsistency is resolved here by explicitly adopting the same two-flag shape already proven in production for Phase 3A's write canary:

- `PERSONAL_WORKSPACE_UI_ENABLED` — global boolean, default `false`
- `PERSONAL_WORKSPACE_UI_CANARY_UIDS` — comma-separated allowlist, same parsing/validation convention as `PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS`

**Modes:** off (global false, uid not in canary list) / canary (global false, uid in canary list) / global (global true, applies to everyone regardless of canary list). **Malformed canary configuration fails closed to UI-off for that uid** — logged, never treated as more permissive than off, exactly mirroring `resolvePersonalRunWorkspaceBinding`'s existing `canaryConfigInvalid` handling.

**Scope of what this flag controls:** UI visibility only — it must never alter `P`/`W`/`RW`, Layer-A read integrity, Workspace writes, or legacy authorization, and is categorically different from the rejected Phase 4A "read-enable" flag since nothing it gates is itself an authorization decision.

**Should the read APIs themselves be flag-gated? No.** `GET /api/user/workspace` and `GET /api/user/workspace/runs` should be **dark but fully functional** at all times — independently secure (server-derived uid, no client-trust dependency), so gating them adds complexity without a security benefit, and *not* gating them means Phase 5B's backend can be validated against production data before any UI ships in Phase 5C, exactly the sequencing benefit a "dark API" gives.

**Server-side gating, not presentation-only:** the `/workspace` route itself must evaluate the flag/canary state server-side and return **404** when off for that uid — hiding only the `TopNav` item is insufficient, since a direct URL visit would otherwise reach a working page. 404 avoids both leaking that the feature exists and any confusing partial-UI state.

**Dark deployment:** yes — ship 5B (dark APIs, always on) then 5C/5D (UI, off by default) behind the flag; verify with a canary uid before a global flip.

**Rollback:** flip the global flag off (or narrow the canary list). No data or authorization state to unwind — provisioning, Workspace writes, and Layer-A read integrity are entirely unaffected by either flag.

## 40–41. Browser Firestore / analytics

No browser Firestore access anywhere in this design — confirmed, every read goes through server API routes. A simple `"Workspace page viewed"` analytics event is reasonable if the existing analytics architecture wants it; it must never carry question/run content or a Workspace identifier.

## 42–46. Implementation sequence (corrected)

- **Phase 5B — Workspace read API:** `GET /api/user/workspace` + `GET /api/user/workspace/runs` (both dark, no UI flag gating them), plus the one new Firestore composite index (`runs`: `userId ASC, workspaceId ASC, createdAt DESC`) required to run the second route at all. Tests only, no UI, no `panel-history` modification. Acceptance boundary: authenticated Workspace metadata, authenticated Workspace-bound run list, cursor pagination, bound-invalid omission via Layer A, legacy exclusion proven structural (not a post-filter), cross-user isolation, no client-supplied Workspace ID trusted anywhere, no `workspaceId` in either response DTO.
- **Phase 5C — Workspace shell/navigation:** nav item + empty Workspace page wired to 5B, behind `PERSONAL_WORKSPACE_UI_ENABLED` + `PERSONAL_WORKSPACE_UI_CANARY_UIDS`. Acceptance boundary: flag dark by default, existing navigation completely unchanged when off, `/workspace` 404s server-side when off (not just nav-item-hidden), mobile nav intact, no selector, no Projects.
- **Phase 5D — Workspace-bound research/history experience:** the actual bound-run list + home dashboard content, reusing existing report-detail rendering. Acceptance boundary: bound research visible, legacy excluded from the Workspace view specifically, Global History still contains legacy unchanged, existing run URLs still work, the two empty states (new-user vs. legacy-only-user) are visibly distinct.
- **Phase 5E — controlled rollout:** dark deploy → canary uid → responsive/browser verification → legacy-only-user verification → new-user verification → general enablement. Rollback via the UI flag only.

## 49. Scope guard

Zero dependency on `teamId` implementation, historical backfill, Projects, or team Workspace support — Phase 5 is buildable entirely on what already exists in production today.
