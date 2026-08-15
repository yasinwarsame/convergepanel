# Phase 5C — Workspace Shell + Navigation + UI Rollout Architecture

Design-only. No implementation, no rollout env vars, no production changes. Performed 2026-08-15 against `main`/production at `32224eb87b4ad0421756f00bfb45482d419e6bb2` (Phase 5B production API activation).

## Corrected API contracts (frozen from actual source, not earlier shorthand)

**`GET /api/user/workspace`** (`app/api/user/workspace/route.ts`):
- Success: `{ ok: true, workspace: { name: string, type: "personal" } }`
- Failure: `{ ok: false, errorCode: "unauthorized"|"auth_error"|"workspace_unavailable"|"workspace_invalid"|"workspace_missing", message: string }`, with status `401`/`503`/`400`/`404`/`409` respectively

**`GET /api/user/workspace/runs`** (`app/api/user/workspace/runs/route.ts`):
- Success: `{ ok: true, items: WorkspaceRunSummary[], hasMore: boolean, nextCursor?: string }`
- Failure: same `{ok:false, errorCode, message}` shape, plus `invalid_cursor` (400) and `internal_error`/`index_required` (500/503)

Earlier design documents' `{name, type}` shorthand referred to the `workspace` field's shape, not the full HTTP envelope. Phase 5C/D consume the envelope exactly as shown above.

## 1. Baseline

`origin/main` = local `HEAD` = production deployment = `32224eb87b4ad0421756f00bfb45482d419e6bb2`. Phase 5B merge confirmed present.

## 2–3. TopNav and auth architecture (established, not assumed)

- **`TopNav.tsx` is entirely `"use client"`.** No server component in the render tree currently has access to the authenticated UID — `resolveRequestIdentity()` (the sole credential-resolution contract) takes a `NextRequest` and is only ever called from Route Handlers.
- **Existing precedent for auth-gated nav items** (Governance, Team Reviews, My Reviews): conditionally rendered via `!loading && user && <capability>`, where `<capability>` (`governanceDashboardEligible`, `teamRole`) comes from `useUserPlan()` — a client hook that calls `GET /api/user/usage` (an existing, already-authenticated, server-side-computed capability endpoint), authenticated via `resolveRequestIdentity()` inside that route.
- **`useUserPlan()`'s caching is already uid-scoped and fail-closed**: in-memory `Map` + `sessionStorage`, both keyed by `cp_plan_${uid}`, read/written only against the *current* `uid` from `useAuth()`; the fetch effect's dependency array includes `uid`, so a logout→login-as-different-user transition naturally triggers a fresh fetch under the new uid — the old uid's cache is never read for the new session. On any failure (401, network, parse error) it falls back to `DEFAULT_USAGE`, which has every capability flag `false` — **fails closed already, by existing convention**.
- **`/admin`'s existing gate is a *client-side* redirect** (`"use client"` layout, `useEffect` → `router.push` on ineligibility) — explicitly **not** reused here, since it produces exactly the flash/direct-route exposure this phase's brief requires avoiding. `/workspace` needs a genuinely stricter, server-side gate `/admin` doesn't have today.
- **Next.js version:** 14.2.33, App Router. `notFound()` from `next/navigation` is already used in three existing server-component pages (`app/learn/[slug]/page.tsx` and siblings) — proven, working pattern in this exact version.
- **Server-Component-authenticated-UID gap, confirmed real:** no Server Component today can resolve the authenticated UID — `resolveRequestIdentity()` requires a `NextRequest`, unavailable in Server Component render. Closing this gap is genuinely required for `/workspace`'s `notFound()` gate and is scoped explicitly below (§16).

## 4–8. Canonical rollout resolver

Mirrors `resolvePersonalRunWorkspaceWriteMode()`/`parseCanaryUidAllowlist()` (Phase 3A, `lib/workspaces/personalRunWorkspaceWriteCanary.ts`) structurally — same exact-uid-only matching, same trim/dedupe/max-10 rules, same `getPersonalWorkspaceId().ok` reuse for uid validation, same precedence rule.

```ts
// lib/workspaces/workspaceUiRollout.ts (proposed, not implemented)

export const MAX_WORKSPACE_UI_CANARY_UIDS = 10;

export type WorkspaceUiCanaryParseResult =
  | { ok: true; uids: ReadonlySet<string> }
  | { ok: false; reason: "malformed_entry" | "too_many_entries" };

export function parseWorkspaceUiCanaryUids(raw: string | undefined): WorkspaceUiCanaryParseResult {
  // identical shape to parseCanaryUidAllowlist(): absent/empty -> ok, empty set;
  // trim + dedupe via Set; size > 10 -> too_many_entries; any entry failing
  // getPersonalWorkspaceId(entry).ok -> malformed_entry. Whole-list failure,
  // never partial acceptance.
}

export type WorkspaceUiModeSource = "off" | "canary" | "global";
export interface WorkspaceUiMode {
  enabled: boolean;
  source: WorkspaceUiModeSource;
  canaryConfigInvalid: boolean;
}

export function resolvePersonalWorkspaceUiMode(args: {
  uid: string;
  globalEnabled: boolean;
  canaryUidsRaw: string | undefined;
}): WorkspaceUiMode {
  const parsed = parseWorkspaceUiCanaryUids(args.canaryUidsRaw);
  const canaryConfigInvalid = !parsed.ok;
  if (args.globalEnabled) return { enabled: true, source: "global", canaryConfigInvalid };
  if (parsed.ok && parsed.uids.has(args.uid)) return { enabled: true, source: "canary", canaryConfigInvalid };
  return { enabled: false, source: "off", canaryConfigInvalid };
}
```

- **Global precedence (§5):** `PERSONAL_WORKSPACE_UI_ENABLED=true` always wins, regardless of canary-list validity — a deliberate global rollout must never be silently disabled by an unrelated allowlist typo. `canaryConfigInvalid` is still surfaced for logging even when irrelevant to the decision.
- **Malformed configuration (§7):** global off + malformed/oversized canary → `enabled: false` for everyone, never a broadened default. Never logs the configured UID values themselves, only that parsing failed.
- **True disabled default (§38):** both env vars absent → `globalEnabled: false`, `canaryUidsRaw: undefined` → parses to an empty valid set → `enabled: false` for every uid. This is the exact current production state today.
- **Flag independence (§39):** the resolver takes no dependency on `WORKSPACES_ENABLED`/`PERSONAL_WORKSPACE_PROVISIONING_ENABLED`/`PERSONAL_RUN_WORKSPACE_WRITES_ENABLED`/its canary — pure function of its own three arguments only.
- **API independence (§40):** `GET /api/user/workspace` and `GET /api/user/workspace/runs` never call this resolver and never will — they remain reachable to any authenticated user regardless of UI rollout state, exactly as already proven live in production during Phase 5B's verification (both endpoints answered real requests while zero UI existed).

## 9–13. Nav-eligibility delivery — selected mechanism

**Extend the existing `GET /api/user/usage` response with `workspaceUiEnabled: boolean`**, computed server-side by calling `resolvePersonalWorkspaceUiMode({uid, globalEnabled: PERSONAL_WORKSPACE_UI_ENABLED, canaryUidsRaw: PERSONAL_WORKSPACE_UI_CANARY_UIDS}).enabled` inside that route, using the uid already resolved there via `resolveRequestIdentity()`.

Rejected alternatives:
- **New dedicated endpoint** (`GET /api/user/ui-capabilities` or similar) — rejected as unnecessary: `/api/user/usage` already exists, is already authenticated, is already the established single source `TopNav` reads capability flags from, and is already cache-isolated per uid. A new endpoint would duplicate all of that infrastructure for no benefit, and would add a second network round-trip to nav render.
- **Client environment gating** (`NEXT_PUBLIC_PERSONAL_WORKSPACE_UI_ENABLED`/`_CANARY_UIDS`) — explicitly rejected per the brief: canary membership must never be browser-visible, and a separate client-evaluated flag risks nav/page disagreement with the server-evaluated route gate.
- **Server-derived layout prop** — rejected because no Server Component in the current tree has the authenticated UID available at that point (§2–3's finding); solving that gap for the layout alone, while `/workspace`'s own route gate needs the same resolution independently anyway, doesn't reduce complexity.

**Why this is the right reuse (§12):** `useUserPlan()` already fetches, caches per-uid, fails closed on any error, and re-fetches on uid change — every property items §19–21 ask for is already true of the mechanism I'm extending, proven by existing behavior, not newly designed.

**Additional request (§11):** none — zero new requests. `TopNav` already calls `useUserPlan()` unconditionally today.

**Client UID trusted (§9):** never — `workspaceUiEnabled` is computed entirely server-side from `resolveRequestIdentity()`'s uid; the client only ever reads the boolean the server already decided.

## 14–17. Route gating for `/workspace`

`/workspace` must independently evaluate eligibility server-side — hiding the nav link is not sufficient (§14).

**The Server-Component-UID gap must be closed (§2's finding) — this is in-scope, minimal, additive work, not a workaround:**

```ts
// lib/auth/resolveServerComponentIdentity.ts (proposed, not implemented)
// Mirrors resolveRequestIdentity()'s session-cookie verification branch
// exactly, reusing the same underlying verifySessionCookie() primitive —
// no new Firebase verification logic. Only the cookie-cookie-reading
// entry point differs: next/headers's cookies() instead of a NextRequest.
// Deliberately does NOT replicate the bearer-token / dual-credential
// logic: a top-level browser navigation to /workspace never carries a
// custom Authorization header, so only the session-cookie branch is ever
// relevant here.
export async function resolveServerComponentIdentity(): Promise<{ uid: string } | null> { /* ... */ }
```

`app/workspace/page.tsx` (Server Component, no `"use client"`):
```
identity = resolveServerComponentIdentity()
if (!identity) -> follow existing unauthenticated convention (see §15)
mode = resolvePersonalWorkspaceUiMode({ uid: identity.uid, globalEnabled: env, canaryUidsRaw: env })
if (!mode.enabled) -> notFound()
-> render <WorkspaceShell /> (client component) for the eligible, authenticated case
```

**`notFound()` confirmed scoped correctly (§17):** applies only to the `/workspace` App Router page; has zero effect on `/api/user/workspace`/`/api/user/workspace/runs`, which are independent Route Handlers with their own control flow.

## 15. Auth/flag evaluation ordering

| State | Behavior |
|---|---|
| Unauthenticated + global off | `404` (no identity to evaluate against; feature isn't on for anyone regardless) |
| Unauthenticated + global on | `404` as well — matches this app's existing convention of never inferring "would be allowed if logged in" from a public flag state; avoids revealing global-on status to anonymous requests. Directing to login is a *client* nav concern (the link simply isn't shown), not something the page itself needs to special-case. |
| Authenticated, non-canary, global off | `404` |
| Authenticated, canary match | render |
| Authenticated, global on | render |
| Stale/expired session cookie | treated as unauthenticated by `resolveServerComponentIdentity()` → `404`, matching the row above — never a silent fallback to some other state |

Canary membership is never revealed by response shape — every ineligible case (unauthenticated, non-canary, global-off) returns the identical `404`, so a non-canary authenticated user gets no signal distinguishing "you're logged in but not eligible" from "this route doesn't exist."

## 18–21. TopNav consistency and cross-user safety

- Same canonical resolver output (`workspaceUiEnabled`) drives both the nav item's visibility and the route's `notFound()` decision — computed independently on each request/render from the same pure function, never cached across the two surfaces, so they can only disagree during the brief window `useUserPlan()`'s own fetch is in flight (§19).
- **Loading behavior (§19):** nav item hidden until `workspaceUiEnabled === true` is positively confirmed — never optimistically shown during `loading`, mirroring how `Governance`/`My Reviews` already gate on `!loading && user && ...`.
- **Cross-user cache isolation (§20) and logout/account-switch (§21):** both already solved by `useUserPlan()`'s existing per-uid `Map`/`sessionStorage` keys and `uid`-dependent fetch effect (§2–3's finding) — no new caching logic needed, `workspaceUiEnabled` rides along in the same already-correct payload.

## 22–27. Workspace shell (Phase 5C scope only)

- **Contents:** "Workspace" heading, Personal Workspace name from `GET /api/user/workspace` (consumed via its actual envelope, `body.workspace.name`), a brief one-line subtitle, a "New research" CTA reusing the existing research entry point (§27 — no `workspaceId` parameter, no selection step; new adaptive research is already server-bound).
- **No research list, no history cards, no counts** — Phase 5D's scope entirely. `GET /api/user/workspace/runs` is not called by the Phase 5C shell.
- **No misleading empty-state language (§23):** since no list renders at all in Phase 5C, there is no risk of a false "you have no research" claim — neutral, deferred-content framing only if any placeholder text is shown (e.g., nothing beyond the CTA is likely needed).
- **Metadata failure (§26):** `workspace_missing`/`workspace_invalid`/`workspace_unavailable` each render a distinct diagnostic/retry state — never silently provision, never fall back to a generic view, matching the same fail-safe posture established in Phase 5B's own design.
- **No settings, no rename, no selector (§22, §32)** — unchanged from the Phase 5A/5A2 decisions.

## 28–35. Navigation, responsive, isolation

- **Placement:** "Workspace" inserted before "My Reviews" in both desktop (`lg:flex`) and mobile (`#mobile-menu`) lists, matching Phase 5A's recommendation, reconfirmed against the actual current `navLinks`/conditional-link structure in `TopNav.tsx`.
- **Responsive:** one additional conditional link follows the exact same pattern as `Governance`/`Team Reviews`/`My Reviews` (`!loading && user && workspaceUiEnabled`) — no new breakpoint behavior, no risk of overflow beyond what those three already introduce today (during Phase 5C's dark rollout, the item never renders for anyone, so there is zero responsive risk until Phase 5E's own activation, which will need its own visual check).
- **Active semantics:** `aria-current="page"` on the active nav link when `pathname === "/workspace"`, matching standard practice; visible "Workspace" text always, never icon-only.
- **History, My Reviews, Governance, Export:** all explicitly untouched — no code path in Phase 5C overlaps with any of them.

## 36–48. Resolver API, testing, contract

- **Module location:** `lib/workspaces/workspaceUiRollout.ts` (pure resolver + parser) + a thin server wrapper reading `process.env` at the two call sites (`/api/user/usage`, `resolveServerComponentIdentity`-adjacent `/workspace/page.tsx`) — matching the existing `lib/env.ts`-is-the-single-source-of-truth convention for the env reads themselves.
- **Pure/testable (§37):** `resolvePersonalWorkspaceUiMode()` takes plain arguments, zero I/O, directly unit-testable without mocking `process.env` — same shape as its Phase 3A model.
- **Required future test coverage (§41–46):** exact-uid/prefix-uid/whitespace/duplicate/malformed/>10-entries canary cases; global-true-with-malformed-canary precedence; auth-transition (logout→different-user) leak check; direct-route off/canary-match/canary-miss/global cases; all five metadata error states in the shell.
- **UI contract freeze (§47):** a small client-side parsing helper for the `GET /api/user/workspace` envelope (not a generic data-fetching framework) — Phase 5D reuses the same pattern for `/api/user/workspace/runs` rather than each component re-parsing response shapes inline.

## 49. Implementation split

**One PR.** The full diff (resolver + parser, `/api/user/usage` extension, `resolveServerComponentIdentity`, `/workspace/page.tsx` + shell component, `TopNav` nav-item addition) is small and every piece depends on the others to be independently reviewable — splitting would just create an intermediate state where the resolver exists but nothing consumes it yet, adding review overhead without reducing risk.

## 50–52. Rollout sequence and rollback

1. Merge Phase 5C PR (fresh authorization required, exact head, no carryover from any prior PR's authorization).
2. Production deploy — both `PERSONAL_WORKSPACE_UI_ENABLED`/`PERSONAL_WORKSPACE_UI_CANARY_UIDS` remain **absent** (not merely `false` — genuinely unset, matching current production state).
3. Verify: existing nav/UI byte-for-byte unchanged for every account (the new conditional simply never renders), `GET /workspace` → `404` for every account including canary-eligible-in-the-future ones (since the vars are absent, `mode.enabled` is `false` for everyone), Phase 5B APIs continue answering exactly as before.
4. **No user activation during Phase 5C** — matches the explicit recommendation below.
5. Phase 5D builds the actual Workspace research experience against the now-proven-dark shell.
6. Phase 5E later introduces the first canary activation, once there's real content behind the gate worth showing anyone.

**Rollback (§51):** a Phase 5C code defect while flags are absent → plain code revert, nothing else to unwind (no data, no auth state, no flags were ever set). If UI is later enabled and only the presentation breaks, disable the UI global/canary vars — never `W`, `RW`, Layer A, or the Phase 5B APIs.

## 53. Process control (reconfirmed)

Any future Phase 5C PR requires fresh, PR-specific, exact-head merge authorization — no prior PR's authorization (including this session's PR #45/46/47) carries forward.

## Phase 5C.1 correction (post-deployment production verification)

§50 step 3 above predicted `GET /workspace` → literal `404` for every ineligible
account. Live production verification after PR #48's merge found this to be
imprecise: the response **content** is the genuine Next.js not-found result
(`digest: NEXT_NOT_FOUND`, correct 404 copy, zero Workspace-specific content or
configuration disclosed, confirmed for both authenticated-ineligible and
unauthenticated requests) but the raw **HTTP status code is `200`**, due to a
pre-existing, app-root-level `app/loading.tsx` Suspense boundary that causes
Next.js to commit the response status before the page's `notFound()` call
resolves. This is a structural characteristic of the app's existing streaming
shell, not a Phase 5C code defect, and investigating a safe fix (Phase 5C.1)
concluded no route-local correction exists that doesn't require either a global
loading-behavior redesign, a parallel/weaker Edge-compatible auth implementation
in middleware, or a full App Router root-layout restructure — all explicitly out
of scope. See `docs/workspaces/phase5c1-dark-route-http-status-investigation.md`
for the full investigation, evidence, and the three rejected candidate fixes.
Every other §50 verification point (nav unchanged, no Workspace shell flash, no
content disclosure, Phase 5B APIs unaffected) was reconfirmed accurate as written.
