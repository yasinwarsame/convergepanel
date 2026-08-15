# Phase 5D — Personal Workspace Research Experience (Design Only)

Design/audit pass for the real Workspace research list, consuming the already-live
`GET /api/user/workspace/runs` (Phase 5B). **No implementation in this phase.**
Production remains dark throughout (`PERSONAL_WORKSPACE_UI_ENABLED` /
`PERSONAL_WORKSPACE_UI_CANARY_UIDS` both absent) — nothing here changes that.

Baseline this design is built against: `main` at `c7961985f41f3bd9bd27a719496b55ce821f106b`
(PR #48 + PR #49 both present), production deployment confirmed matching the same
commit. Everything below is derived from reading the actual current source, not
from prior design documents' predictions.

## 1–2. Existing Workspace shell (re-audited from source)

- **Page** (`app/workspace/page.tsx`): Server Component, `dynamic = "force-dynamic"`. Calls `resolveServerComponentIdentity()` → `notFound()` if absent; calls `resolvePersonalWorkspaceUiMode()` → `notFound()` if disabled. Renders `<WorkspaceShell />` only on the eligible path.
- **Client shell** (`components/workspace/WorkspaceShell.tsx`): split into a pure `WorkspaceShellView({metadata})` and a default-export wrapper that supplies `useWorkspaceMetadata()`. Currently renders: `<h1>Workspace</h1>`, a loading line, a success block (`workspace.name` + "New research" CTA linking to `/`), or one of 4 sanitized error states (`errorCopy()`).
- **Metadata hook** (`hooks/useWorkspaceMetadata.ts`): calls `GET /api/user/workspace` via `authedFetch`, parses through the pure `parseWorkspaceMetadataResponse()`, resets on `authLoading`/`authReady`/`user` change, cancels in-flight requests on unmount via a `cancelled` flag.
- **Where the run list fits**: inside `WorkspaceShellView`'s success branch, below the current subtitle/CTA block, as a new section. The CTA link and heading are untouched; the list is purely additive markup inside the existing `status === "success"` branch.

## 3. Runs API — exact current contract (re-frozen from source, not prior docs)

`GET /api/user/workspace/runs?limit=<n>&cursor=<opaque>`, `runtime="nodejs"`, `dynamic="force-dynamic"`.

**Success (200):**
```ts
{ ok: true; items: WorkspaceRunSummary[]; hasMore: boolean; nextCursor?: string }
```
`nextCursor` is present iff `hasMore === true`. Empty Workspace returns `{ ok: true, items: [], hasMore: false }` (no `nextCursor` key at all, not `undefined`-valued).

**Failure envelope (uniform across every case):** `{ ok: false; errorCode: string; message: string }`.

| Case | Status | `errorCode` |
|---|---|---|
| No/invalid credentials | 401 | `unauthorized` / `auth_error` |
| Workspaces globally disabled | 503 | `workspace_unavailable` |
| Invalid uid (structurally unreachable for a real authenticated caller) | 400 | `workspace_invalid` |
| No Workspace doc for this owner | 404 | `workspace_missing` |
| Workspace malformed / wrong owner / wrong type | 409 | `workspace_invalid` |
| Workspace lookup failed (Firestore error) | 503 | `workspace_unavailable` |
| Bad/expired cursor | 400 | `invalid_cursor` |
| Missing composite index (should never occur in production — already deployed) | 503 | `index_required` |
| All rows in a page fail integrity post-prerequisite (fail-closed race safety net) | 503 | `workspace_unavailable` |
| Uncaught | 500 | `internal_error` |

`workspace_missing`/`workspace_invalid`/`workspace_unavailable` are **identical in code and message** to what `GET /api/user/workspace` (the metadata endpoint) already returns for the same underlying condition — both call `resolvePersonalWorkspaceForOwner()` + `personalWorkspaceErrorResponse()`. `unauthorized`/`auth_error`/`invalid_cursor`/`index_required`/`internal_error` are specific to the runs endpoint.

`DEFAULT_LIMIT = 20`, `MAX_LIMIT = 50` — already fixed server-side, not a client choice to make from scratch (see §22).

## 4. `WorkspaceRunSummary` — exact current DTO (corrected from assumption)

```ts
type WorkspaceRunSummary = {
  id: string;
  at: string;                    // ISO 8601, NOT `createdAt`
  question: string;
  selectedModels: ModelId[];
  status?: string;
  modelsOk?: number;
  modelsTotal?: number;
  synthesisConsensusScore?: number;   // present in the real DTO, not in the earlier assumed field list
  governanceStatus?: "approved" | "needs_review" | "blocked";
  hasAdaptiveOutput?: boolean;
  adaptiveSchemaId?: QueryType;
};
```

**Needed for Phase 5D's card UI:** `id` (key + link target), `at` (date), `question` (title), `status`/`modelsOk`/`modelsTotal` (status line), `synthesisConsensusScore` (status line suffix), `governanceStatus` (badge). **Available but not needed for the card:** `selectedModels` (§33 — skip, see below), `hasAdaptiveOutput`/`adaptiveSchemaId` (§31 — skip, no human-readable label mapping exists anywhere in the codebase; do not invent one now, and never render the raw internal schema id as UI text).

## 5–6. Existing History presentation, reuse vs. duplicate

The entire History tab lives inline inside `app/page.tsx`'s single 2872-line `Home` component — the row markup (`app/page.tsx:2160-2261`), its state (`historyItems`, `historyLoading`, `historyDetailLoadingId`, etc.), and its open handler (`openHistoryItem`, `app/page.tsx:1471`) are not extracted into any reusable component or hook. This is `Home`'s local closure state, not an importable module.

**Decision: do not extract the History row into a shared component.** Pulling that JSX out (it branches on 3 item types — research/verification/video — and reads 8+ pieces of `Home`'s local state) would touch code this session has no reason to change and creates real regression risk in already-working, unrelated (verification/video) history rendering, for a feature (Workspace) that only ever needs the `research`-type subset of that logic. This matches the explicit instruction not to perform a large History refactor for architectural purity.

**One narrow, genuinely low-risk exception: `HistoryGovernanceChip`.** It's a small (~12 line), pure, prop-driven component (`status → JSX`, no hooks, no closure over `Home`'s state) defined at module scope in `app/page.tsx` but not exported. Recommend extracting it verbatim to `components/shared/GovernanceChip.tsx` and updating `app/page.tsx`'s one usage to import from there — a mechanical, behavior-preserving move (not a redesign), avoiding a third independent copy of the same approved/needs_review/blocked → color/label mapping. This is the one History-adjacent file this phase would touch, and only by extraction, not modification of History's own render logic.

**New component: `components/workspace/WorkspaceRunCard.tsx`.** A new, Workspace-scoped, `research`-type-only card that visually mirrors the existing History row (`app/page.tsx:2160-2261`) — same badge/icon-less layout (Workspace only has one item type, so the type badge and icon-switch present in History are unnecessary; keep this card simpler than History's, not more decorated), same date formatting (`new Date(item.at).toLocaleString()`), same title truncation approach (`line-clamp-2`), same status-line composition pattern (`{modelsOk}/{modelsTotal} model responses` / error / fallback, `· Synthesis {score}/100` suffix), same `HistoryGovernanceChip` reuse, same full-row-as-button click target, same `cp-*` token classnames. This is intentional visual parity without a shared component — the smaller, single-type nature of this card makes duplication of ~40 lines of JSX proportionate, not a maintenance burden.

## 7–8. Report navigation — existing mechanism found (not assumed)

There is **no** `/reports/[runId]` or any owner-side URL-addressable report page (`app/reviews/[runId]` exists but is the *reviewer*-side view, a different auth/data model entirely — not reusable here). Report opening today is 100% client-state-driven inside `Home` via `openHistoryItem(item)`, which fetches `GET /api/user/runs/{id}` and sets ~10 pieces of local React state (`setQuestion`, `setAdaptivePanel`, `setPanelTab("research")`, etc.).

**The actual, already-production-proven deep-link mechanism**, found at `app/page.tsx:1785-1825`: a `useEffect` on `Home` mount reads `?openResearchRun=<runId>` from the URL, builds a minimal placeholder `HistoryItem` stub (empty title/question — irrelevant, since `openHistoryItem` re-fetches the real content from `GET /api/user/runs/{id}` regardless), calls `openHistoryItemRef.current(stub)`, then `router.replace("/", {scroll:false})` to clean the URL. This same mechanism already handles `?openVerification=` and `?openVideoVerification=` for the other two history types, and is reused by at least one other production flow (the `governanceDeepLinkHandled` ref name indicates this is the same link a governance notification email/link already points at).

**Decision: Workspace list entries link to `/?openResearchRun={id}`** using a plain `<Link href={...}>`. Zero new report-rendering code, zero new URL contract — genuinely the same, already-proven path every other entry point into a report uses today. `id` here is the plain Firestore run id, never a Workspace-prefixed identity (§8 requirement satisfied by construction — there's no such prefix anywhere in this scheme).

## 9. Page information architecture

```
Workspace
Your personal workspace

[New research]

Recent research
─────────────────────────
[card] question · date · status · governance
[card] question · date · status · governance
[card] question · date · status · governance

[Load more]
```

`Recent research` (not "History" — that word is reserved for the separate, compatibility-complete tab) as the section heading. No metrics, no dashboard widgets (§10) — the product goal here is find/reopen/start work, matching the existing minimal-CTA-first pattern already established in Phase 5C's shell.

## 10–11. No dashboard metrics; New Research CTA unchanged

No total-count, consensus-average, model-usage-chart, or activity-graph widgets — none are canonical anywhere else in the product today, and inventing them here would be exactly the kind of premature feature the mission explicitly rules out. The existing Phase 5C "New research" CTA (`<Link href="/">`) is preserved exactly as-is — it already correctly avoids any Workspace/Project picker, since new Personal adaptive research is bound server-side (Phase 3) with no client selection step.

## 12. Global History stays fully separate

No code path introduced by Phase 5D touches `app/page.tsx`'s History tab, its query (`GET /api/user/panel-history`), or its state. The only touch to that file is the one-line `HistoryGovernanceChip` export move in §6 — a pure relocation, zero behavior change, verified by keeping the import working identically.

## 13–16. Legacy-only vs. genuinely-new user (the correctness-critical case)

Three real states to distinguish, from `WorkspaceRunSummary[]` alone plus one signal:

1. **Has bound runs** → render the list (trivial — `items.length > 0`).
2. **Zero bound runs, but has prior (legacy) History** → "earlier research is in History" message, never "no research yet."
3. **Zero bound runs, zero prior History at all** → genuine first-time-user empty state.

**Distinguishing 2 from 3 requires an existence signal Workspace's own API cannot provide** — `GET /api/user/workspace/runs` only ever sees Workspace-*bound* rows by its query's own `workspaceId==` filter; it structurally cannot see legacy rows, by design (§13's constraint: never let this signal leak into reassigning legacy runs to the Workspace — it must be read-only, presentation-only).

**Investigated and rejected: reusing `GET /api/user/panel-history` with `limit=1`.** This looked like the obvious "reuse an existing, already-proven endpoint" answer, but re-reading its actual source (`app/api/user/panel-history/route.ts:76-94`) shows it **always** runs 3 parallel collection scans (`runs`/`verifications`/`videoVerifications`) each `.limit(FETCH_CAP)` where `FETCH_CAP = 120`, **regardless of the request's own `limit` parameter** — the requested `limit` only affects the post-merge slice, not the underlying reads. Calling it with `limit=1` still costs up to 360 document reads server-side. That is not the "smallest reliable signal" the mission asks for, and triggering it on *every* `/workspace` page load (including for canary users who never open the History tab) would add a real, avoidable read cost purely to pick empty-state copy.

**Recommended smallest signal: a new, minimal, existence-only check.** Three independent `.where("userId","==",uid).limit(1).get()` queries (`runs`, `verifications`, `videoVerifications`, run in parallel via `Promise.all`) — worst case 3 document reads, best case fewer once any collection returns non-empty (can short-circuit). This is a small, proportionate backend addition (a few lines, reusing the exact same three collections/field names `panel-history` already queries), not the "new expensive API" the mission warns against — it is in fact *cheaper* than the existing endpoint, not an expansion of it. Exposed either as a new tiny field on the existing `GET /api/user/workspace` metadata response (e.g. `hasLegacyHistory: boolean`, resolved server-side alongside the Workspace lookup, since that request already fires on every Workspace page load) or as a new minimal endpoint — the metadata-response route is preferred, since it avoids a third network round-trip on page load (see §19) and the metadata endpoint already runs once per Workspace visit regardless.

**Never** use a raw `runsThisMonth`/global-run-count as this signal (§15) — that's calendar-scoped and plan-usage-scoped, not "has this user ever produced any run," and using it would risk exactly the false-empty/false-legacy misclassification the mission is guarding against.

## 17. New-user empty state

Zero bound runs, `hasLegacyHistory: false`: *"Start your first research run."* + the existing "New research" CTA (no second CTA needed — the top-of-page one already serves this).

## 18. No "Unfiled" anywhere

Confirmed: zero occurrences of "Unfiled" anywhere in Phase 5D's scope. Reserved exclusively for a future known-Workspace-but-`projectId=null` state that does not exist yet.

## 19. Loading strategy

`useWorkspaceMetadata()` (existing) and a new `useWorkspaceRuns()` hook are independent reads with no data dependency on each other (the runs endpoint does its own independent `resolvePersonalWorkspaceForOwner()` call — it does not consume the metadata endpoint's result). **Fire both in parallel** on mount, not sequentially — a waterfall here would be pure, avoidable latency. If `hasLegacyHistory` is folded into the metadata response as recommended in §16, this stays exactly 2 parallel requests, not 3.

## 20–21. Error taxonomy — metadata vs. runs kept distinct

- **Metadata fails** (any of the 4 existing `WorkspaceMetadataErrorCode`s): the whole page is degraded — this is unchanged Phase 5C behavior (`WorkspaceShellView`'s existing error branch), and the run list section never even attempts to render, since there's no Workspace to key it against.
- **Metadata succeeds, runs call fails**: a new, distinct in-section error — the heading/CTA/Workspace name from metadata still render normally; only the "Recent research" section shows a bounded retry state. Never collapse this into the same generic "something went wrong" the metadata path uses — the user's Workspace clearly still exists and works, only the list temporarily doesn't.
- **Runs-specific codes** (`unauthorized`/`auth_error`/`invalid_cursor`/`index_required`/`internal_error`) map to the same retry-eligible in-section error; `workspace_missing`/`workspace_invalid`/`workspace_unavailable` returned from the *runs* endpoint specifically (a possible race between the metadata check and the runs check, both independently calling `resolvePersonalWorkspaceForOwner()`) escalate to the page-level error state instead, since by definition the Workspace prerequisite itself just failed — not merely the list.

## 22. Default page size

**Use the API's own `DEFAULT_LIMIT = 20`** — this was already decided and fixed server-side in Phase 5B, not an open client-side choice. (For comparison: History's existing `HISTORY_PAGE_SIZE = 30`, but that number belongs to a 3-collection merge with a different cost profile — no reason to match it here.) 20 rows of the card shape in §6 is a reasonable single "page" density at 1440px without excessive scroll, and comfortably fits mobile with `Load more`.

## 23–24. Pagination UX — Load More, not infinite scroll

**`Load more`**, mirroring History's exact existing pattern (`app/page.tsx:2263-2273`) both visually and behaviorally: a centered button below the list, disabled + "Loading…" label while in flight. This is the established ConvergePanel pattern already proven at this exact page density, avoids the accessibility/restoration/hidden-retry complexity of an intersection-observer-based infinite scroll, and pairs naturally with a cursor contract that has no "total count" to drive a numbered-pagination UI.

## 25–27. Cursor handling

The client treats `nextCursor` as a fully opaque string — stored, replayed via `?cursor=`, never decoded/inspected/synthesized/edited (it is not even valid JSON on the wire without the server's own base64url+shape validation; treating it as opaque is not just policy, it's the only thing a client could safely do with it anyway). **State shape** for `useWorkspaceRuns()`:

```ts
{
  items: WorkspaceRunSummary[];
  nextCursor: string | undefined;
  hasMore: boolean;
  status: "loading" | "ready" | "error";   // initial-load state
  loadingMore: boolean;
  loadMoreError: string | null;
}
```

**Deduplication**: append-time dedupe by `id` (a `Set` check before pushing into `items`) as a defensive measure only — if a duplicate is ever observed, `logger`-equivalent client telemetry (or simply a dev-console warn, matching this repo's client-side conventions) rather than silently treating it as expected, per the mission's explicit instruction not to mask a server contract violation.

## 28–29. Refresh and back-button behavior

**Refresh reloads page 1** — no cursor persisted to the URL or `sessionStorage`; this matches History's own behavior (a plain page reload also restarts History at page 1) and there's no stated product need to preserve deep pagination position across a hard refresh. **Back-button from an opened report**: since opening a report is `/?openResearchRun=` navigation (§7), the browser's own history stack naturally returns to `/workspace` on Back — Next.js's App Router preserves client component state (including whatever page of Workspace runs was loaded) across a same-tab back navigation by default (no special restoration code needed), the same as it already does for History today. No new scroll/pagination-restoration engineering required for the first release.

## 30–36. Card content and interaction

- **Status display**: reuse History's exact composition logic verbatim (§6's `WorkspaceRunCard`) — `{modelsOk}/{modelsTotal} model responses` (+ non-"complete" status suffix), "Run ended with an error" when `status === "error"` with no counts, "Research panel" fallback otherwise, `· Synthesis {score}/100` suffix when present. No new status vocabulary invented.
- **`adaptiveSchemaId`**: never rendered (§4) — no human-readable mapping exists anywhere in the codebase today, and inventing one is out of this phase's scope.
- **`governanceStatus`**: reuse the exact same badge (`HistoryGovernanceChip`, relocated per §6) with identical color/label semantics — no new governance prominence.
- **`selectedModels`**: not rendered as a chip row — History doesn't surface it as chips either (it folds model info into the `modelsOk/modelsTotal` count line instead); no reason for Workspace to be visually heavier here.
- **Title/truncation**: mirror History's `line-clamp-2` + no truncation-length cap beyond what CSS line-clamping already does (History's `truncateHistoryTitle(text, 88)` operates on a *different*, pre-truncated title field assembled server-side for a different DTO shape — Workspace's `question` field is the raw question text; use the same `line-clamp-2` CSS treatment, no separate JS pre-truncation needed since the DTO doesn't provide a pre-shortened `title`).
- **Dates**: `new Date(item.at).toLocaleString()` — identical to History, no new date-formatting utility.
- **Primary action**: the entire card is the single click target (a `<button>`/`<Link>` wrapping the row, exactly like History), no secondary buttons.

## 37–39. Scope boundaries preserved

No export actions, no reviewer/governance mutation controls, and no client-side Workspace-membership logic on the card — the client only ever renders what the server DTO already vouches for; it never receives (and must never be given) `workspaceId`/`userId`/`ownerUserId` on any list item.

## 40–43. API client shape

- **Query params**: `limit`, `cursor` only — never `workspaceId`/`userId`/`owner` (the server reconstructs scope from the authenticated session on every request, per the route's own doc comment; the client has no legitimate reason to ever send these and no code path should be written that could).
- **No direct Firestore access** — Phase 5B's route is the only path, matching every other client data-fetch in this program.
- **New `useWorkspaceRuns()` hook**, mirroring `useWorkspaceMetadata()`'s established shape (`authedFetch` + a pure response-parsing function separated from the fetch orchestration, for the same no-jsdom testability reason). No SWR/React Query — this codebase doesn't use either anywhere, and introducing one for a single hook would be a new dependency for no proportionate benefit.
- **Cancellation/races**: same `cancelled`-flag-in-`useEffect` pattern already used by `useWorkspaceMetadata`, plus a monotonic request-sequence guard (matching `historyLoadSeq` in `app/page.tsx`) for `Load more` specifically, so a slow first `Load more` response can't clobber a faster subsequent one, and a rapid double-click is naturally suppressed by disabling the button while `loadingMore` is true (mirroring History's existing `disabled={historyLoading}`).

## 44–45. Account-switch and logout isolation

`useWorkspaceRuns()` resets to its initial `{items:[], ...}` state whenever the identity `useAuth()` exposes changes uid (same trigger `useWorkspaceMetadata` already keys its own effect on: `authLoading`/`authReady`/`user`) — no persisted cache keyed only by "the current hook instance," since a hook instance itself doesn't survive a full logout/login remount of the Workspace route tree in this app's structure, and the effect's own dependency array is the enforcement mechanism, not an assumption. **Session expiry mid-view**: both metadata and runs `401`s map to the same "session unavailable, please sign in again" treatment `WorkspaceShellView` already has for the metadata case — no stale content is left rendered past a `401` response.

## 46–50. Error-state details

- **No client caching** exists anywhere in this design, so a plain error state is sufficient for an initial-load failure (§46) — nothing to reconcile against stale cached rows.
- **`Load more` failure** (§47): preserve the already-loaded `items`, show a bounded inline `Retry` near the pagination control — never blank the whole section.
- **`invalid_cursor`** (§48): should not occur in normal UI flow (the browser only ever replays a server-issued cursor), but if it does, treat as an abnormal continuation failure — offer a plain "reload" action that discards client pagination state and refetches page 1, rather than surfacing "cursor" terminology to the user.
- **`workspace_unavailable` during `Load more`** (§49): keep existing rows, offer retry — never reinterpret as "Workspace is empty."
- **Workspace becomes missing/invalid after initial load** (§50): escalate to the page-level (not list-level) error state, matching §21's reasoning — this is a prerequisite failure, not a list failure, and must never silently fall back to showing History content or attempt to reprovision.

## 51–53. Accessibility and responsiveness

- Section heading as a real `<h2>` ("Recent research"), list as a semantic `<ul>`/`<li>`, each row as a single focusable `<Link>`/`<button>` (never a clickable non-interactive `<div>`), `Load more` as a real `<button>` (native keyboard/Enter/Space support, no custom key handling needed).
- Loading skeletons (if used) get `aria-hidden="true"`; the actual loading/empty/error states use a `role="status"`/`role="alert"` text node (mirroring `WorkspaceShellView`'s existing pattern for its own loading/error copy) so assistive technology gets one clear announcement, not per-skeleton noise.
- **Responsive**: audit at 1440/1024/768/414, matching this program's established browser-verification breakpoints. Card content (badge/date/title/status/governance chip) should wrap the same way History's row already does at each of these widths — reuse, don't redesign, the existing flex-wrap treatment.
- No sidebar, no new nav-level chrome — `TopNav` and its existing Workspace-link insertion point (`before "My Reviews"` desktop / `after "Team Reviews"` mobile, both already shipped in Phase 5C) are unchanged.

## 56–57. No Project or team affordances

Confirmed zero occurrences of Project/Folder/Unfiled/Move/Organize/member/avatar/sharing/invite/team language anywhere in this design — all correctly out of scope.

## 58–59. Dark rollout — no new flag

Phase 5D code sits entirely behind the already-shipped Phase 5C route/nav gate (`resolvePersonalWorkspaceUiMode()`); with both `PERSONAL_WORKSPACE_UI_ENABLED`/`PERSONAL_WORKSPACE_UI_CANARY_UIDS` absent, none of this is reachable in production regardless of when the code merges/deploys. **No new `PERSONAL_WORKSPACE_RUNS_UI_ENABLED`-style flag** — introducing one would only add a second gate to keep in sync with the first, for zero rollout benefit while the first gate is already the sole determinant of reachability.

## 60–61. Soft-404 limitation — unchanged, not touched

Phase 5D makes zero changes to `app/loading.tsx`, `middleware.ts`, or the `/workspace` route's root-layout structure — the documented Phase 5C.1 soft-404 characteristic (`docs/workspaces/phase5c1-dark-route-http-status-investigation.md`) is preserved exactly as-is. The SEO/crawler/indexing reassessment stays a Phase 5E concern, ahead of any global activation — not something Phase 5D's dark-only deployment needs to resolve.

## 62–66. Rollout, verification, and fixture strategy

Same sequence as Phase 5C: implement → independent review → merge → deploy dark → verify both flags still absent → verify existing UI (nav, History, root, `/api/user/usage`) byte-for-byte unchanged → Phase 5D code remains unreachable to any real user. During implementation, local-only `process.env` overrides (never persisted to Vercel) can exercise the positive path (list loads, pagination works, both empty states render) — matching the exact technique already used and documented for Phase 5C. Given this session's controlled test accounts (`Td2BOHteYSUIafLh7qL8s0V2CCt2` / `pBoH05Ssj8WgOZWdtI4Ry82dSR22`) may not naturally have both a "has bound runs" state and a "legacy-only, zero bound runs" state simultaneously, those specific empty-state permutations may remain test-backed (component/hook-level) rather than fixture-verified live, consistent with this program's established "do not manufacture production-like data merely to satisfy a UI check" discipline — to be confirmed against actual controlled-account state at implementation time rather than assumed now.

## 67–69. Analytics, performance, prefetch

No new analytics in this phase (no existing lightweight, privacy-safe analytics call site was found for this kind of UI event during this audit; introducing one is disproportionate to a design-only pass and the mission's own default is "no new analytics unless trivial"). Performance: 2 parallel initial requests (metadata + first runs page, per §19), no per-card detail fetch (Phase 5B's route already returns full card-ready summaries server-side — zero N+1 by construction). `Load more` is a single explicit request per click, never a prefetch storm — since Workspace list rows deep-link via `/?openResearchRun=` (a same-origin page, not a route Next would eagerly prefetch report *data* for, only the destination route's JS bundle, same behavior as every other on-page `<Link>` already in this app) there's no new prefetch-driven read amplification risk introduced.

## 70–73. Test architecture

Mirroring this program's established layers (Phase 5B/5C precedent):
- **Pure-logic unit tests**: the runs-response-parsing function (mirroring `parseWorkspaceMetadataResponse`), the empty-state classification logic (bound-runs / legacy-only / new-user), cursor-append/dedupe logic — all as pure functions, no React/mocking required.
- **Hook tests**: `useWorkspaceRuns()` — cancellation, account-switch reset, `Load more` sequencing, error-state transitions — same fake-fetch-injection style already used for `useWorkspaceMetadata`.
- **Component tests**: `WorkspaceRunCard` and the list section, via `renderToStaticMarkup` (no jsdom, matching this repo's established convention) across every state — populated, both empty variants, both error variants, loading.
- **Route-gate/page integration**: extend `app/workspace/__tests__/page.spec.tsx`'s existing matrix only if the page-level wiring changes; the list itself doesn't need new route-gate tests, since it's gated by the exact same, already-tested resolver.
- **Full pagination matrix** (§71) and **full empty-state matrix** (§72), including a dedicated test proving the "has legacy History" signal can never cause a legacy run to appear inside the Workspace list itself (a type-level and runtime assertion that the empty-state classifier's input type carries no run-level data at all, only the boolean signal — mirroring the type-level regression guard already used elsewhere in this program to prove a stale signal can't leak into rendered content).
- **Report-open regression**: a test proving a Workspace card link/click leads to the exact same `/?openResearchRun={id}` URL construction already covered by existing `app/page.tsx` deep-link tests, not a new parser.
- **History regression** (§74): a test (source-level, matching this repo's established regex-assertion convention for `app/page.tsx`, since it has no jsdom harness either) proving no Phase 5D file is imported by or mutates `app/page.tsx`'s History-tab code path, beyond the single `HistoryGovernanceChip` import-source change.

## 75. Protected systems

Zero changes anywhere under `lib/verification/`, `app/api/verify-claim/`, `lib/video/`, `app/api/verify-video/`, `lib/verificationGate/`, or any reviewer/governance/export logic — none of Phase 5D's scope touches any of these.

## 76–77. Implementation PR scope and activation semantics

**Expected to fit one PR**: `useWorkspaceRuns()` hook + its parser, `WorkspaceRunCard`, the list/pagination section wired into `WorkspaceShellView`, the new legacy-vs-new-user empty-state signal (small addition to `GET /api/user/workspace`'s response + `resolvePersonalWorkspaceForOwner`-adjacent read), the `HistoryGovernanceChip` extraction, tests, and this document's implementation-outcome update. Small enough, and every piece depends on the others being present to be independently reviewable — matching Phase 5C's own "one PR" precedent and reasoning.

**Activation semantics, stated precisely**: merging and deploying Phase 5D while both UI flags remain absent is **merge + dark production deployment**, not user-facing activation — identical framing to Phase 5C's. The Phase 5E boundary (§78) — first canary uid, positive-path live verification, eventual global enablement — is not blurred by this phase reaching production in dark form.

## Open items for implementation time (not resolved by design alone)

- Exact placement/response-field name for the "has legacy History" signal (`hasLegacyHistory` on `GET /api/user/workspace`, vs. a dedicated field elsewhere) — recommended above, final call belongs to implementation, since it depends on confirming `resolvePersonalWorkspaceForOwner()`'s call site can cheaply carry one more parallel existence check without restructuring that shared helper.
- Whether the `HistoryGovernanceChip` extraction should also add a lightweight test file of its own, or rely on Workspace's + History's existing coverage after the move — a judgment call once the actual diff exists.
