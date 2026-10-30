# Decision Support provenance view: deactivation and rollback runbook

Operational procedure for turning the Decision Support (DS) provenance view **off** in Production, either by a normal configuration change or by an emergency Vercel Instant Rollback, and for recovering Production domain assignment afterwards.

**Status of this document (2026-10-30):** written before any Production activation. The flag has never been enabled in Production. Every Vercel behaviour marked **[REHEARSED]** was observed in a disposable Vercel project, never in Production. Steps marked **[UNTESTED IN PRODUCTION]** have not been executed against the `convergepanel` project. Nothing here records or claims a completed Production rollback.

This runbook does not authorize anything by itself. Every mutating step names the separate owner authorization it needs (§1.4).

---

## 1. Purpose and applicability

### 1.1 The flag

| Item | Value |
|---|---|
| Variable | `DS_PROVENANCE_ROUTE_VIEW_ENABLED` |
| Defined in | `lib/env.ts` (`export const DS_PROVENANCE_ROUTE_VIEW_ENABLED = process.env.DS_PROVENANCE_ROUTE_VIEW_ENABLED === "true";`) |
| ON only when | the value is exactly the string `true`. Absent, empty, `false`, `TRUE` or any other value means OFF |
| Scope | server-only. There is no `NEXT_PUBLIC_` variant; it is never inlined into the browser bundle |
| Read | once, when the server module loads, from the environment of the **deployment** serving the request |
| Intended Production state today | **absent** (dark by configuration) |

### 1.2 What the flag changes

When ON, three authorized read routes may add one optional top-level `dsProvenance` field to a response that already carries a usable Decision Support review (`lib/adaptiveSchema/dsProvenanceRouteAdapter.ts`):

| Surface | Route | Code |
|---|---|---|
| P1 | `GET /api/user/runs/[runId]` | `app/api/user/runs/[runId]/route.ts` |
| P2 | `GET /api/user/runs/[runId]/governance` | `app/api/user/runs/[runId]/governance/route.ts` |
| W1 | `GET /api/workspaces/[workspaceId]/runs/[runId]` | `app/api/workspaces/[workspaceId]/runs/[runId]/route.ts` |

The UI renders the provenance section (`components/adaptive/DsProvenanceSection.tsx`, marked `data-ds-provenance-section`) **only** when that field is present (`AdaptivePanelResponse.tsx`, `PersonalReviewDetail.tsx`).

When OFF, the view builder is never called, no `dsProvenance` field is emitted, and the section never renders. Only the three routes above call the adapter. The Workspace governance surface W2 is deferred (owner ruling D-W2): no route passes it to the adapter, so it never carries the field.

The flag changes **no** authorization decision: every denial returns before the adapter runs. A signed-out request is denied identically ON or OFF.

### 1.3 Boundaries

- **In scope:** turning the flag OFF; Instant Rollback to a known-good dark deployment; restoring Production domain auto-assignment; verifying the result.
- **Out of scope:** turning the flag ON (activation). Activation needs its own owner decision and its own runbook step list; this document only describes how to undo it.
- **Never in scope:** Firebase or Firestore changes, user data, creating test identities, editing other Production variables.

### 1.4 Authorization boundaries

Each of these is a **separate** owner authorization. Approval for one does not extend to the next.

| Code | Action | Changes |
|---|---|---|
| **AUTH-ENV** | Remove (or set to anything other than `true`) `DS_PROVENANCE_ROUTE_VIEW_ENABLED` in the Production environment | Production configuration |
| **AUTH-DEPLOY** | Create a new Production deployment (redeploy) | Production deployment |
| **AUTH-ROLLBACK** | `vercel rollback` to a named deployment | Production domains |
| **AUTH-PROMOTE** | `vercel promote` a named deployment | Production domains and auto-assignment |

Read-only checks (§2.2, §7) need no mutation authorization. They still must not print environment **values**.

The operator must be a member of the `convergepanel-ai` Vercel team with permission for these actions, and must be the person named in the authorization.

---

## 2. Preconditions

### 2.1 Fixed identifiers

| Item | Value |
|---|---|
| Vercel team scope | `convergepanel-ai` |
| Vercel project | `convergepanel` |
| Production domains | `convergepanel.com`, `www.convergepanel.com` |
| Repository | `yasinwarsame/convergepanel`, branch `main` (Production deploys automatically from `main` through the Vercel Git integration) |

Run every CLI command from a checkout linked to the `convergepanel` project, with `--scope convergepanel-ai`. Before any mutating command, confirm the project:

```bash
vercel api /v9/projects/convergepanel --scope convergepanel-ai \
  | python3 -I -B -c 'import json,sys; p=json.load(sys.stdin); print(p["name"], p["id"], "autoAssignCustomDomains=", p.get("autoAssignCustomDomains"))'
```

STOP if the name is not `convergepanel`.

### 2.2 Pre-mutation evidence capture (read-only, UTC timestamps)

Record each of these, with the UTC time, before **any** mutation:

1. **Serving deployment** for both domains:

   ```bash
   for a in convergepanel.com www.convergepanel.com; do
     vercel api "/v4/aliases/$a" --scope convergepanel-ai \
       | python3 -I -B -c "import json,sys; d=json.load(sys.stdin); print('$a', d.get('deploymentId'))"
   done
   ```

2. **That deployment's commit and state:**

   ```bash
   vercel api "/v13/deployments/<SERVING_DPL_ID>" --scope convergepanel-ai \
     | python3 -I -B -c 'import json,sys; d=json.load(sys.stdin); print(d.get("readyState"), d.get("target"), (d.get("meta") or {}).get("githubCommitSha"), d.get("createdAt"))'
   ```

3. **Flag configuration, names and targets only.** Filter in process from the pipe; never write the raw response to disk, never use `vercel env pull`, never decrypt:

   ```bash
   vercel api /v10/projects/convergepanel/env --scope convergepanel-ai \
     | python3 -I -B -c 'import json,sys; e=json.load(sys.stdin).get("envs",[]); print(sorted((x["key"], tuple(sorted(x.get("target") or [])), x.get("updatedAt")) for x in e if x["key"].startswith("DS_PROVENANCE") or "SENTRY" in x["key"]))'
   ```

4. **Project auto-assignment:** `autoAssignCustomDomains` from the §2.1 command.

5. **Known-good dark deployment**: see §2.3.

### 2.3 Choosing the known-good dark deployment

A deployment keeps the environment it was **created** with **[REHEARSED]**. A dark deployment is therefore one created while `DS_PROVENANCE_ROUTE_VIEW_ENABLED` was absent or not `true` in Production.

Select `<DARK_DPL_ID>` as follows:

- it is READY with target `production`;
- its `createdAt` is **earlier** than the time the flag was added to Production (the variable's `updatedAt` in §2.2 step 3, and the activation record);
- it is the **most recent** such deployment, so that the rollback does not also revert unrelated releases.

Rolling back further than necessary has side effects. A deployment built before merge `2b97443` (PR #270) uses the old hard-coded browser Sentry address instead of `NEXT_PUBLIC_SENTRY_DSN`. One built before `76e1a565` (PR #271) restores four known critical contrast defects.

Record `<DARK_DPL_ID>`, its commit SHA and its `createdAt` in the activation record **before** activation, so this choice is not made under pressure.

---

## 3. Normal deactivation (preferred path)

Use this path when there is time for one build, typically a few minutes. It changes no domain-assignment state.

| Step | Action | Authorization |
|---|---|---|
| 3.1 | Capture §2.2 | none |
| 3.2 | Remove the variable from Production: `vercel env rm DS_PROVENANCE_ROUTE_VIEW_ENABLED production --scope convergepanel-ai --yes` | AUTH-ENV |
| 3.3 | Confirm by name that it is gone (§2.2 step 3) | none |
| 3.4 | Create a new Production deployment of the commit currently serving: `vercel redeploy <SERVING_DPL_ID> --target production --scope convergepanel-ai` **[UNTESTED IN PRODUCTION]** | AUTH-DEPLOY |
| 3.5 | Wait for READY; confirm both domains now serve the new deployment (§2.2 steps 1–2) | none |
| 3.6 | Run the verification in §6 | none |

**Why 3.4 is required.** Removing or changing a Vercel variable does **not** change any existing deployment **[REHEARSED: step B0, a variable added without a redeploy had no effect; step G2, a variable removed without a redeploy left the running build ON]**. The flag only goes dark once a deployment created **after** the removal serves the domains.

**Alternative to 3.4.** Merging any reviewed PR to `main` also creates a new Production deployment with the current variables. Use this only if a reviewed change is already approved for merge. Do not create a commit just to trigger a build.

**Assumption to label in the record.** The rehearsal created new deployments with `vercel deploy --prod` from a disposable directory. Do not use `vercel deploy --prod` for `convergepanel`: it would upload the operator's local working tree instead of a reviewed commit. `vercel redeploy` rebuilding with the **current** environment is documented Vercel behaviour but was not exercised in the rehearsal.

**STOP conditions:**
- 3.3 still shows the variable;
- the new deployment fails to reach READY;
- the domains still point at the old deployment after READY.

In each case go to §8.

---

## 4. Emergency Instant Rollback

Use this path only when the flag-ON deployment must stop serving **immediately** and the build time in §3 is not acceptable.

**Prerequisites:**
- AUTH-ROLLBACK naming `<DARK_DPL_ID>` exactly;
- §2.2 captured;
- `<DARK_DPL_ID>` selected per §2.3.

| Step | Action | Authorization |
|---|---|---|
| 4.1 | `vercel rollback <DARK_DPL_ID> --scope convergepanel-ai --yes` **[REHEARSED in a disposable project; UNTESTED IN PRODUCTION]** | AUTH-ROLLBACK |
| 4.2 | `vercel rollback status --scope convergepanel-ai`; then confirm both domains → `<DARK_DPL_ID>` (§2.2 step 1) | none |
| 4.3 | Read the project's `autoAssignCustomDomains` (§2.1 command) and **record it**. Expect `false` **[REHEARSED: step C]** | none |
| 4.4 | Run the §6 checks that apply to the rolled-back deployment | none |
| 4.5 | **Continue immediately with §5.** A rollback alone is not a finished recovery | — |

**What the rollback does and does not do [REHEARSED: steps C and E]:**
- The domains serve `<DARK_DPL_ID>` with **its own creation-time environment**, so the flag is dark at once.
- The Production variable is **not** changed. If it was `true`, it is still `true`.
- Vercel **suspends automatic domain assignment** for the project (`autoAssignCustomDomains=false`).
- While assignment is suspended, a new Production deployment builds to READY but **does not take the domains** **[REHEARSED: step F]**. That includes the deployment from the next merge to `main`.

**The hazard.** After a rollback, a READY deployment is not evidence that Production serves it. Without §5, the next merge to `main` silently fails to reach users. And if the variable was never removed, any later promote serves the flag again.

---

## 5. Post-rollback recovery

Every step is required after §4. The order matters.

| Step | Action | Authorization |
|---|---|---|
| 5.1 | Remove the variable: `vercel env rm DS_PROVENANCE_ROUTE_VIEW_ENABLED production --scope convergepanel-ai --yes`; confirm by name (§2.2 step 3) | AUTH-ENV |
| 5.2 | Create a fresh dark deployment: `vercel redeploy <SERVING_COMMIT_DPL_ID> --target production --scope convergepanel-ai`, where `<SERVING_COMMIT_DPL_ID>` is the most recent Production deployment of current `main`. Wait for READY. **[UNTESTED IN PRODUCTION]** It will **not** take the domains yet (step F) | AUTH-DEPLOY |
| 5.3 | Confirm the new deployment's `createdAt` is **after** the 5.1 removal time, so it was built without the flag | none |
| 5.4 | Promote it: `vercel promote <NEW_DARK_DPL_ID> --scope convergepanel-ai --yes` **[REHEARSED: step G]** | AUTH-PROMOTE |
| 5.5 | Confirm both domains → `<NEW_DARK_DPL_ID>` (§2.2 step 1) | none |
| 5.6 | Confirm `autoAssignCustomDomains` is `true` again (§2.1 command) **[REHEARSED: step G]** | none |
| 5.7 | Run all of §6 against `<NEW_DARK_DPL_ID>` | none |
| 5.8 | Record that the **next** ordinary merge to `main` must be checked to have taken both domains automatically. Do this at that merge with §2.2 steps 1–2 **[REHEARSED: step G2]** | none |

**Never promote the flag-ON deployment.** A promote serves that deployment's own creation-time environment **[REHEARSED: step G, the promoted deployment served the flag ON]**. Only promote a deployment whose `createdAt` is later than the variable's removal.

**Why not promote `<DARK_DPL_ID>` itself?** That would restore auto-assignment, but Production would stay on an older commit. Promoting a fresh build of current `main` returns Production to the current code, dark by configuration.

---

## 6. Verification after any path

Run these read-only checks. Record the UTC time of each and the deployment ID it applies to.

| Check | How | Expected |
|---|---|---|
| Domains | §2.2 step 1 | both → the intended deployment |
| Deployment identity | §2.2 step 2 | READY, `production`, expected commit |
| Flag configuration | §2.2 step 3 | no `DS_PROVENANCE_ROUTE_VIEW_ENABLED` row for `production` |
| Flag effective state | the serving deployment's `createdAt` is after the variable's removal, **or** the deployment is a known-good dark deployment per §2.3 | dark by configuration |
| Signed-out access | `curl -s -o /dev/null -w '%{http_code}' https://convergepanel.com/api/user/runs/<any-id>` | `401` |
| Browser monitoring relay | `curl -s -o /dev/null -w '%{http_code}' -X POST https://convergepanel.com/monitoring` | `400` (configured). `404` means the browser Sentry address is not configured in that build |
| Monitoring configuration | §2.2 step 3, names only | `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` present for `production` |
| Errors and 5xx | `vercel logs --project convergepanel --scope convergepanel-ai -d <DPL_ID> --environment production --since <WINDOW> --status-code 5xx --json`, then the same with `--level error`. Count lines only | 0 new 5xx and 0 error-level entries. Also record the total line count for the window, to show the query returned data |
| Observation window | from the time the domains switched until at least 15 minutes after; state the exact UTC start and end | — |

Do not print log contents or environment values into shared records; record counts.

**Bot checkpoint.** Scripted requests to `convergepanel.com` can receive a Vercel bot-checkpoint `403`. Keep requests to a handful, pause about two minutes and retry once. Never bypass the checkpoint. A checkpoint `403` is not an application result.

**Authenticated dark behaviour is not verifiable by this runbook today.** No Production test identity is authorized. The flag's effect (the presence or absence of `dsProvenance` on an authorized response) cannot be observed by a signed-out request. Record **PRODUCTION_AUTHENTICATED_DARK_STATE: NOT VERIFIED** unless a separately authorized method exists. Dark state in Production is established by configuration and deployment-creation time, not by observation.

**STOP and escalate (§8)** if any check fails, if a result cannot be obtained, or if the log query returns zero total lines for a window in which traffic is expected.

---

## 7. Evidence and limitations

### 7.1 What was rehearsed

Order 6 rollback rehearsal 2, 2026-10-29, ran in the disposable Vercel project `o6-rollback-rehearsal-em805q` in team `convergepanel-ai`. The project was created and deleted by the script. The Production alias was recorded before and after the run and was unchanged.

- **Evidence archive:** `ConvergePanel-Controlled-Verification-Evidence/order6-rollback-rehearsal-2/` (`README.md`, `tools/rehearse.py`, `tools/verify.py`, `verify.json`, `steps/01–14`). The archive is outside this repository; `MANIFEST.sha256` there has sha256 `73433762…`.
- **Verifier:** 12/13 PASS on the scripted record. The one failure was a CLI-table parser defect in the cleanup comparison. Deletion was then verified by a post-hoc API read, `steps/14`.

| Rehearsal step | Observed | Used in |
|---|---|---|
| A | deploy without the variable → dark | §2.3 |
| B0 | add the variable, no redeploy → still dark | §3 |
| B | deploy → ON | — |
| C | `vercel rollback` to A → dark immediately; `autoAssignCustomDomains=false` | §4 |
| E | after the rollback, the variable is still present; the old build stays dark | §4 |
| F | production deploy after the rollback → READY but **not assigned** the domain | §4, §5 |
| G | `vercel promote` of F → domain assigned; auto-assignment `true`; serves F's own environment (ON) | §5 |
| G2 | remove the variable (running build stays ON) → deploy → dark, auto-assigned | §3, §5 |

### 7.2 Limitations

- The rehearsal's flag probe was an **unauthenticated stand-in function** reading a runtime variable the same way `lib/env.ts` does. It was not ConvergePanel's authenticated provenance response.
- The rehearsal created deployments with `vercel deploy --prod`. `vercel redeploy` (§3.4, §5.2) was not exercised.
- **No Production rollback, promote, redeploy or flag change has been performed.** All Production steps here are **[UNTESTED IN PRODUCTION]**.
- **Authenticated Production dark state is NOT VERIFIED.** Authenticated OFF and ON behaviour was verified in the isolated Firebase project `convergepanel-sa-verify-y0ibg9` with a local production build: 718/718 browser checks and 447/447 API checks. That is not a Production observation.
- Vercel CLI behaviour was observed with Vercel CLI 54.x and the team's configuration at the time. Platform behaviour may change. Re-read `autoAssignCustomDomains` and the aliases instead of assuming them.

---

## 8. Recovery and escalation matrix

In every row: **STOP**, record the observed state with UTC times, and take only the action listed, under the named authorization. If that authorization is not already held, escalate to the owner and wait.

| Situation | Likely cause | Action | Authorization |
|---|---|---|---|
| Rollback succeeded but one or both domains are not on `<DARK_DPL_ID>` | rollback still pending, or a domain is assigned separately | `vercel rollback status`; re-read both aliases after the `--timeout`. If still wrong, escalate. Do not issue another rollback or promote without a new decision | none to re-read; AUTH-ROLLBACK or AUTH-PROMOTE for any further change |
| Variable removed but users still get the provenance section | no new deployment since the removal (§3 "Why 3.4 is required") | Run §3.4 (normal) or §4 (emergency) | AUTH-DEPLOY, or AUTH-ROLLBACK |
| New deployment READY but not serving the domains | auto-assignment suspended after an earlier rollback (rehearsal F) | Check `autoAssignCustomDomains`. If `false`, confirm the new deployment was created after the variable's removal, then §5.4 | AUTH-PROMOTE |
| `autoAssignCustomDomains` still `false` after §5.4 | promote not completed | Re-read after a few minutes; escalate. Do not merge to `main` until resolved: merges will not reach Production | — |
| `/monitoring` returns `404`, or a Sentry variable is missing | `NEXT_PUBLIC_SENTRY_DSN` was absent when the serving build was created, or a variable was removed. Builds before PR #270 (`2b97443`) use a different, hard-coded relay configuration, and their `/monitoring` responses are not covered by this check | Record it. Do not re-add values from memory or logs. Escalate: restoring monitoring is a separate configuration decision | separate owner decision |
| Signed-out request does not return `401`, or any authorization result differs from expectation | unexpected build or regression | STOP all further changes; escalate immediately as a security incident. Do not attempt a code fix under this runbook | owner / incident process |
| 5xx or error-level entries appear | regression in the serving build | Record counts and the time window; escalate. If the serving build is flag-ON, §4 may be authorized | AUTH-ROLLBACK |
| A required check cannot be established (API error, bot checkpoint persists, logs empty) | tooling or access | Record it as **NOT VERIFIED** with the reason. Do not report success | — |
| Promoted or rolled-back deployment turns out to be flag-ON | wrong target chosen | STOP; select a correct target per §2.3; escalate | AUTH-ROLLBACK or AUTH-PROMOTE (new) |

---

## 9. Record template

Copy this into the incident or activation record and fill in every line. Leave nothing implied.

```
Operator:                      Authorizations held (codes + who + UTC):
Pre-state (UTC):  domains -> ______ / ______   commit ______   autoAssign ______   flag rows ______
Known-good dark deployment:    ______  commit ______  createdAt ______
Actions (each with UTC, exact command, exit code):
Post-state (UTC): domains -> ______ / ______   commit ______   autoAssign ______   flag rows ______
§6 checks: 401 __  /monitoring __  Sentry names __  5xx __  errors __  total lines __  window ______–______
Authenticated dark state: NOT VERIFIED (reason) | VERIFIED (separately authorized method + evidence)
Next ordinary merge auto-assigned (date, deployment): ______
```
