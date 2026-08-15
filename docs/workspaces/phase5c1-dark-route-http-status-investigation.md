# Phase 5C.1 — Dark-Route HTTP Status Investigation

**Status: CONTENT-CORRECT SOFT-404 ACCEPTANCE REQUIRED, and the population
discrepancy is RESOLVED as a reporting error (no data loss).** No code change
ships from this investigation. `/workspace` remains dark (both
`PERSONAL_WORKSPACE_UI_ENABLED` and `PERSONAL_WORKSPACE_UI_CANARY_UIDS` absent in
production, unchanged by this phase) and content-safe, but its raw HTTP status for
an ineligible request is `200`, not `404`. This document records why, what was
tried, and why each candidate fix was rejected — so this is a known, documented,
permanent characteristic rather than an unexplained gap the next person has to
re-derive. It also records the independent re-reconciliation that confirms the
Phase 5C report's `5/5` population figure was a measurement error (wrong
eligibility definition), not production data loss — the true, re-verified count is
`91/91`, unchanged from the established baseline. See "Population reconciliation
discrepancy" below.

## Trigger

Phase 5C (PR #48) production verification found that `GET /workspace` — for both an
authenticated-but-ineligible account and an unauthenticated request, with both
Workspace UI rollout variables absent — returns the genuine Next.js `notFound()`
result (confirmed via the `NEXT_NOT_FOUND` digest and the literal "404: This page
could not be found." content, both server-rendered and reflected in the browser tab
title) but at HTTP status `200`, not `404`.

This is not a data-exposure issue. No Workspace/Personal-Workspace/New-Research
content, and no rollout configuration, appears anywhere in the response for an
ineligible request — verified by direct string search of the full response body,
both authenticated-ineligible and unauthenticated. `/api/user/workspace` and
`/api/user/workspace/runs` are unaffected (this investigation confirmed, again,
that the UI rollout resolver is never imported by either route). But a `200` where
the acceptance criterion specified `404` is a real, disclosed gap in the literal
contract, with downstream risk for search-engine soft-404 indexing, CDN/edge
caching of a "successful" response for a route that isn't actually available, and
monitoring/alerting that keys off status codes.

## Reproduction

Reproduced identically in three environments: production (`convergepanel.com`),
a from-scratch local `npm run build && npm run start` (Next.js 14.2.35), and via
direct inspection of the raw response.

```
$ curl -sD - -o /dev/null https://convergepanel.com/workspace
HTTP/2 200
...
vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch
x-matched-path: /workspace
```

Locally, the same request returns `Transfer-Encoding: chunked` — the direct,
unambiguous signal that this is a genuinely streamed response, not a status code
picked incorrectly by application code. The response body's initial flush contains
the app's generic loading skeleton (from `app/loading.tsx` — see below), and the
real `notFound()` result (`digest: NEXT_NOT_FOUND`, the literal 404 title/copy)
arrives afterward as a second React Server Components payload chunk pushed via
`self.__next_f.push(...)`.

## Root cause

`app/loading.tsx` is a **pre-existing, app-root-level** file (present since the
initial commit, unrelated to Phase 5C) that Next.js's App Router wraps around
`app/layout.tsx`'s `{children}` slot as a `<Suspense fallback={<Loading />}>`
boundary. This boundary applies to **every route in the app**, not just
`/workspace` — it is what gives every async page in this codebase its skeleton
loading state instead of a blank screen while data resolves.

Next.js's streaming SSR model commits the HTTP status/headers for the response at
the moment the first chunk is flushed. Because `/workspace/page.tsx` is an async
Server Component nested under this root Suspense boundary, Next begins streaming
the shell (header/nav + the generic loading skeleton) with status `200` **before**
`resolveServerComponentIdentity()` and `resolvePersonalWorkspaceUiMode()` resolve
inside the page component. By the time `notFound()` actually throws, the response
has already committed to `200`; the thrown error only changes what streams into the
still-open `<main>` boundary, not the status line already sent.

This is a structural consequence of the app already having a root-level
`loading.tsx` (a decision made independently of, and prior to, Phase 5C) combined
with vanilla Next.js 14 App Router streaming semantics — not a defect specific to
`/workspace`'s own gate logic. Any route in this codebase with an async Server
Component that calls `notFound()` would exhibit the same status-code behavior,
this is simply the first route where it was checked at the HTTP level.

## Candidates investigated (all rejected, with evidence)

**1. Route-local `app/workspace/loading.tsx` override (including a no-op / `null`
return).** Tested directly: build + start locally, same `Transfer-Encoding:
chunked`, same `200`, same streamed `NEXT_NOT_FOUND` content. **Does not fix it** —
any `loading.tsx` in the tree, route-local or inherited, creates a Suspense
boundary that triggers streaming; a route-local file doesn't detach the route from
the inherited root boundary, it just adds another one.

**2. Middleware-based pre-render gating**, reusing the real, trusted
`verifySessionCookieValue()` (the same primitive `resolveServerComponentIdentity()`
and every API route's auth already call) to return a real `404` `NextResponse`
before Next.js starts rendering the page at all. Tested directly: importing
`verifySessionCookieValue` (which transitively imports `firebase-admin`) into
`middleware.ts` and running `npm run build` **fails outright** —

```
node:stream
Module build failed: UnhandledSchemeError: Reading from "node:stream" is not
handled by plugins (Unhandled scheme).
...
Dynamic Code Evaluation (e. g. 'eval', 'new Function', 'WebAssembly.compile')
not allowed in Edge Runtime
The error was caused by importing 'firebase-admin/lib/esm/auth/index.js' in
'./lib/firebase/admin.ts'.
```

Confirmed separately that this installed Next.js version (14.2.35) has no
`nodeMiddleware` / Node.js middleware runtime option at all — `export const
runtime = "nodejs"` on `middleware.ts` is silently ignored (no build warning, no
error; it is simply not a recognized config key for middleware in this version).
Middleware in this app is Edge-only, full stop, which is exactly why the
*existing* `middleware.ts` (the `/admin` gate) deliberately only checks cookie
*presence*, never validity — this constraint predates Phase 5C and this
investigation, it's the reason the codebase's existing admin gate is structured
the way it is. The only way to get a real Firebase-Admin-verified decision in
middleware would be a second, independently-written, Edge-compatible verification
implementation (e.g. hand-rolled JWT verification against Google's public keys) —
which is precisely the "second, subtly different authentication system" this
program has explicitly avoided at every prior phase, and which the Phase 5C.1
authorization explicitly directs to reject rather than build. **Rejected.**

**3. Route group with an independent root layout** (Next.js's "multiple root
layouts" pattern), scoped to `/workspace` only, so it would not inherit
`app/loading.tsx`'s Suspense boundary at all. Tested directly: created
`app/(wstest)/workspace/layout.tsx` with its own `<html><body>`, alongside the
existing top-level `app/layout.tsx` (also `<html><body>`), without touching any
other route. Build succeeded with no error, but the **rendered output contained
two `<html>` tags** — confirmed by direct count against the live response. A
correct multiple-root-layouts configuration requires removing the single
top-level `app/layout.tsx` (and, transitively, `app/loading.tsx`) entirely and
migrating **every** route in the app into sibling groups, each with its own root
layout — there is no partial/single-route opt-out. That is an app-wide structural
migration, not a `/workspace`-local change, and is explicitly the "major App
Router restructure" this phase was authorized to stop short of rather than force.
**Rejected.**

All three experiments were fully reverted; `git diff` against `origin/main` is
empty for every file touched during testing, confirmed before this document was
written.

## Decision

**CONTENT-CORRECT SOFT-404 ACCEPTANCE REQUIRED.** Achieving a literal HTTP `404`
for `/workspace` while ineligible would require one of: a global change to
`app/loading.tsx` (out of scope — broad UX regression surface across every route in
the app, a separate architecture decision), a parallel/weaker authentication
implementation in Edge middleware (out of scope — rejected on principle, not just
difficulty), or a full App Router restructure removing the single root layout
(out of scope — far beyond "route-local"). None of these are safe to do as part of
a narrowly scoped corrective pass, so none were done.

What **is** true, and is the actual safety boundary that matters: the response
content is always the genuine Next.js not-found result, no Workspace-specific
content or configuration is ever disclosed, and both rollout variables remain the
sole (and unmodified) mechanism keeping the feature dark. This is a soft-404 with a
correct body and an incorrect status line — an observability/SEO/caching risk
worth tracking, not a security or content-disclosure one.

## Regression test

No Jest-level HTTP integration test was added. This repository's existing test
infrastructure (confirmed via `app/workspace/__tests__/page.spec.tsx` and the rest
of the suite) calls Server Component functions directly and asserts on their
return value or thrown error — it does not spin up a real Next.js server or
observe actual HTTP responses anywhere in the codebase, and no such harness
(`supertest`, `next-test-api-route-handler`, a programmatic `next()`
request-handler test server, etc.) exists today. `playwright` is present as a
devDependency but is used interactively for manual browser verification in this
program, not as a committed, CI-gated test suite — building genuine
server-spin-up HTTP test infrastructure to cover this one status-code assertion
would be a disproportionate infrastructure addition for a docs-only corrective
pass, and is left as a deliberate option for the team rather than done here.

The existing Jest matrix (`app/workspace/__tests__/page.spec.tsx`) continues to
correctly prove the *content*-level contract — every ineligible branch throws the
real `notFound()` (`digest: "NEXT_NOT_FOUND"`) — which remains the correct and
sufficient thing for a unit test to assert. The *status-code* characteristic
documented here is not something that class of test can observe in principle, not
a coverage gap in how those tests were written.

**Manual verification procedure** (until/unless CI-level HTTP testing is built):

```bash
curl -sD - -o /dev/null https://convergepanel.com/workspace   # unauthenticated
# expect: HTTP/2 200, x-matched-path: /workspace, vary: RSC,... (streaming)
curl -s https://convergepanel.com/workspace | grep -o "NEXT_NOT_FOUND"
# expect: NEXT_NOT_FOUND present
curl -s https://convergepanel.com/workspace | grep -oE "Personal Workspace|New Research"
# expect: no output — zero Workspace-specific content leaked
```

## Population reconciliation discrepancy (5/5 vs 91/91)

The Phase 5C final report's population sweep reported `eligible users = 5` /
`valid Personal Workspaces = 5`, against the previously established production
baseline of `91/91`. This was investigated as a matter of priority, ahead of the
HTTP-status work above, given the possibility of real data loss.

**Root cause: a measurement/reporting error, not production drift.** The ad-hoc
sweep script written during the Phase 5C report derived "eligible users" from
`runs` documents that had a **bound** (`workspaceId`-carrying) run — i.e. it
counted only users who happen to have already produced at least one
Workspace-bound run (9 such runs existed at the time, spanning 5 distinct users).
That is not, and has never been, this program's definition of "eligible." The
canonical definition (established Phase 2B, reused unchanged through 3B/3C/3D) is
every **enabled Firebase Auth user** — independent of whether they have created
any run at all, bound or otherwise — checked against a provisioned Personal
Workspace via `lib/workspaces/existingUserProvisioningRun.ts`.

Re-run via the actual canonical tool (`npm run workspaces:provision-existing --
--dry-run`, zero writes) against the confirmed `convergepanel` project:

```
Project: convergepanel
Scanned: 91
Eligible: 91
Excluded: 0
  existing_valid: 91
Conflicts: 0
Failed: 0
```

Independently cross-checked with a reverse audit (all `workspaces` docs with
`type: "personal"` against a fresh `listUsers()` enumeration): 91 Auth users, 91
Personal Workspace documents, 0 orphans (no Workspace document without a
corresponding enabled Auth user), 0 deterministic-id violations (every
`workspaces/{id}` doc's id matches `personal-{ownerUserId}` exactly), 0 duplicate
owners.

**Correct canonical count: 91/91, unchanged from the established baseline.** No
data loss occurred. The Phase 5C report's `5/5` figure is retroactively corrected
here to reflect that it measured "distinct users with a Workspace-bound run," a
real and non-alarming number given `PERSONAL_RUN_WORKSPACE_WRITES_ENABLED` went
global only the day before Phase 5C's report, not "eligible users with a valid
Personal Workspace."

## Scope confirmation

Zero production mutations from this investigation: no Firestore writes, no
environment variable changes, no index changes, no `P`/`W`/`RW` changes. The three
experimental route/middleware changes were made and fully reverted only in a local
working tree; nothing was pushed, deployed, or merged as part of testing them. The
only artifact this investigation produces is this document.
