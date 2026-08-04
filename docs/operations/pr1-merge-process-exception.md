# PR #1 merge process exception (2026-08-04)

## What happened

PR #1 ("Add adaptive governance, multi-reviewer review, and repository-wide auth hardening") was merged into `main` by the repo owner (`yasinwarsame`) at `2026-08-04T20:06:12Z`, before the requested independent review (`Aliahmedwardheere`) was submitted. `reviewDecision` was empty and `reviews` was an empty array at the time of merge — the human-approval gate that had been established for this PR did not end up gating the actual merge.

This was not initiated by the assistant working the PR; the assistant's last action before the merge was requesting the review and posting a review guide as a PR comment. The merge was discovered after the fact via a screenshot showing the PR's "Merged" state on GitHub.

## Consequence: automatic production deployment

The merge to `main` triggered Vercel's standard GitHub-integration auto-deploy to production (`https://convergepanel.com`). This was not a separate, deliberate deploy action — it is the existing, expected CI/CD behavior for this repo's connected production branch.

## What shipped, and what stayed off

- **Repository-wide auth identity hardening** (`lib/auth/resolveRequestIdentity.ts` as the single hardened resolver for all protected routes, including Claim Verification and Video Verification) went live and unguarded — this was always the non-gated portion of the PR.
- **The multi-reviewer governance feature remained disabled.** `MULTI_REVIEWER_GOVERNANCE_ENABLED` is absent from the Vercel production environment (confirmed via `vercel env ls production`, both before and after the merge). Since the code fails closed on anything but the literal string `"true"`, the feature is deployed but inert. No team has opted in. The production canary described in `docs/operations/multi-reviewer-governance-runbook.md` §11 has not started.

## Verification performed post-merge

A focused production smoke test was run against `https://convergepanel.com` (see conversation record for full detail):

- Sign-in, sign-out, and account switching — verified via isolated `curl` cookie jars (never touched the real browser session).
- Research, Claim Verification, and Video Verification — each exercised end-to-end with real requests against production (a synthetic local video clip was used for Video Verification); all completed successfully.
- Team Reviews page and review-panel data — confirmed reachable and correct via the API, using seed test account credentials.
- Protected-route auth boundary — no credentials, a malformed bearer token, a tampered/invalid-signature token, and a mismatched cookie+bearer pair were all correctly rejected with `401`, never `500`.
- Vercel production logs for the test window: zero `5xx` responses; all `401`s traced to the deliberate negative auth tests above; the two `404`s on `/api/synthesize-panel` are pre-existing, documented cache-miss behavior, unrelated to this change.

One non-security finding from the smoke test: the "Create a multi-reviewer panel" button in `AdaptiveMultiReviewerPanelSection.tsx` is not hidden client-side when the global feature gate is off — it renders whenever no panel exists for a run, with no check against `MULTI_REVIEWER_GOVERNANCE_ENABLED` or team opt-in. Attempting to use it correctly fails server-side (`403 multi_reviewer_disabled`), so this is a UX gap, not a security gap. Not fixed as part of this exception record — tracked for a future, separate change.

## Why no rollback was performed

The production deployment was healthy (clean smoke test, no error spike), and the one feature that had not completed its review process (multi-reviewer governance) remained fully inert via its existing kill switch. Rolling back would have reverted the auth-hardening fix along with it, for no safety benefit, since the code that was actually "live and active" (auth resolution) had already been validated by the smoke test.

## Corrective action

Branch protection was added to `main` immediately after this was discovered:

- 1 required approving review
- Stale reviews dismissed on new commits
- Required status checks: `Vercel`, `Vercel Preview Comments`
- Unresolved conversations block merge
- `enforce_admins: true` — direct pushes to `main` are now blocked for every account, including repository owners/admins, so no future change (including this one) can bypass the PR + review process the same way.

A post-merge review was requested from `Aliahmedwardheere` for the audit trail; any security or correctness finding they raise will be shipped as a separate hotfix PR, now subject to the branch protection above.
