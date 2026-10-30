# Decision Support provenance view: deactivation and rollback runbook

Operational procedure for turning the Decision Support (DS) provenance view **off** in Production, either by a normal configuration change or by an emergency Vercel Instant Rollback. It also covers recovering Production domain assignment afterwards, and containing flag-ON builds that stay reachable at generated deployment addresses.

**Status of this document (2026-10-30):** written before any Production activation. The flag has never been enabled in Production.

| Label | Meaning |
|---|---|
| **[OBSERVED]** | seen in the disposable-project rehearsal (§8.1); never in Production |
| **[INFERRED]** | expected from the rehearsal, Vercel documentation or the code, but not demonstrated |
| **[UNTESTED IN PRODUCTION]** | never executed against the `convergepanel` project |

Nothing here records or claims a completed Production rollback.

This runbook does not authorize anything by itself. Every mutating step names the separate owner authorization it needs (§1.4).

**Shell:** the helpers and commands are written for `bash`. Run them in `bash`, not `zsh` or `sh`.

---

## 1. Purpose and applicability

### 1.1 The flag

| Item | Value |
|---|---|
| Variable | `DS_PROVENANCE_ROUTE_VIEW_ENABLED` |
| Defined in | `lib/env.ts`: `export const DS_PROVENANCE_ROUTE_VIEW_ENABLED = process.env.DS_PROVENANCE_ROUTE_VIEW_ENABLED === "true";` |
| ON only when | the value is exactly the string `true` |
| Scope | server-only. There is no `NEXT_PUBLIC_` variant; it is never inlined into the browser bundle |
| Read | once, when the server module loads, from the environment of the **deployment** serving the request |
| Intended Production state today | **absent** (dark by configuration) |

**Absent versus `false`.** In code, any value other than exactly `true` is OFF. This runbook nevertheless supports **only removal** of the variable as deactivation. A remaining row with some other value cannot be verified as OFF without reading the value, and this runbook never reads environment values (§2.2). So "not `true`" can only be established by the row being absent.

### 1.2 What the flag changes

When ON, three authorized read routes may add one optional top-level `dsProvenance` field to a response that already carries a usable Decision Support review (`lib/adaptiveSchema/dsProvenanceRouteAdapter.ts`):

| Surface | Route | Code |
|---|---|---|
| P1 | `GET /api/user/runs/[runId]` | `app/api/user/runs/[runId]/route.ts` |
| P2 | `GET /api/user/runs/[runId]/governance` | `app/api/user/runs/[runId]/governance/route.ts` |
| W1 | `GET /api/workspaces/[workspaceId]/runs/[runId]` | `app/api/workspaces/[workspaceId]/runs/[runId]/route.ts` |

The UI renders the provenance section only when that field is present: `components/adaptive/DsProvenanceSection.tsx`, marked `data-ds-provenance-section`, rendered from `AdaptivePanelResponse.tsx` and `PersonalReviewDetail.tsx`.

When OFF, the view builder is never called, no `dsProvenance` field is emitted, and the section never renders. Only the three routes above call the adapter. The Workspace governance surface W2 is deferred (owner ruling D-W2): no route passes it to the adapter, so it never carries the field.

The flag changes **no** authorization decision: every denial returns before the adapter runs. A signed-out request is denied identically ON or OFF. These routes accept the `__session` cookie **or** an `Authorization: Bearer <Firebase ID token>` header (`lib/auth/resolveRequestIdentity.ts`). That is why §6 treats any reachable flag-ON deployment as exposed to any signed-in user, at whatever host serves it.

### 1.3 Boundaries

- **In scope:**
  - turning the flag OFF;
  - Instant Rollback to a known-good dark deployment;
  - restoring Production domain auto-assignment;
  - containing flag-ON deployments at generated addresses;
  - verifying the result.
- **Out of scope:** turning the flag ON (activation). Activation needs its own owner decision and its own runbook steps; this document only describes how to undo it.
- **Never in scope:**
  - Firebase or Firestore changes;
  - user data;
  - creating test identities or signing in;
  - editing any other Production variable.

### 1.4 Authorization boundaries

Each of these is a **separate** owner authorization. Approval for one does not extend to the next. Each must name the exact target, whether a deployment ID, alias or setting.

| Code | Action | Changes |
|---|---|---|
| **AUTH-ENV** | Remove the `DS_PROVENANCE_ROUTE_VIEW_ENABLED` row that targets **only** `production` (§3.2 gate) | Production configuration |
| **AUTH-DEPLOY** | Create a new Production deployment (redeploy) | Production deployment |
| **AUTH-ROLLBACK** | `vercel rollback` to a named deployment | Production domains |
| **AUTH-PROMOTE** | `vercel promote` a named deployment | Production domains and auto-assignment |
| **AUTH-CONTAIN** | One named containment action from §6.4 | Project protection settings, an alias, or (last resort) a deployment |

Read-only checks (§2.2, §6.1–§6.3, §7) need no mutation authorization. They must still never print environment **values** or log contents.

**The operator must:**
- be a member of the `convergepanel-ai` Vercel team with permission for the action;
- be the person named in the authorization.

---

## 2. Preconditions

### 2.1 Fixed identifiers

| Item | Value |
|---|---|
| Vercel team scope | `convergepanel-ai` |
| Vercel project | `convergepanel` |
| Production custom domains | `convergepanel.com`, `www.convergepanel.com` |
| Repository | `yasinwarsame/convergepanel`, branch `main`. Production deploys automatically from `main` through the Vercel Git integration |

Run every CLI command from a checkout linked to the `convergepanel` project, with `--scope convergepanel-ai`.

**Record the CLI version:** run `vercel --version` and record the output. This document's CLI usage was checked against **Vercel CLI 54.4.1** (help output and bundled source, 2026-10-30). If your version differs, re-check each command's `--help` before use.

### 2.2 Read-only helpers (load once per shell)

The local `vercel` CLI can print a line such as `<claude-code-hint v="1" … />` before the JSON body of `vercel api`. A strict JSON parse then fails. This is why the rehearsal recorded no Production project ID.

The helper below:
- skips only blank lines and recognized `<claude-code-hint … />` lines at the start;
- requires the rest to be exactly **one** JSON object;
- fails closed on malformed or extra output, on an API error object, and on any missing required field;
- preserves a nonzero `vercel` exit status (`pipefail`);
- prints only the fields it is asked for. It never prints the raw response or any `value` field.

```bash
VJSON=$(cat <<'PY'
import json, re, sys
HINT = re.compile(r"\s*<claude-code-hint\b[^<>]*/>\s*")
def die(code, msg):
    sys.stderr.write("STOP: " + msg + "\n"); sys.exit(code)
lines = sys.stdin.read().split("\n")
while lines and (lines[0].strip() == "" or HINT.fullmatch(lines[0])):
    lines.pop(0)
body = "\n".join(lines).strip()
if not body:
    die(3, "empty output")
try:
    doc, end = json.JSONDecoder().raw_decode(body)
except ValueError:
    die(3, "output is not a JSON document")
if body[end:].strip():
    die(3, "unexpected extra output after the JSON document")
if not isinstance(doc, dict):
    die(3, "JSON document is not an object")
if isinstance(doc.get("error"), dict):
    die(3, "API error: " + str(doc["error"].get("code")))
def get(d, path):
    for part in path.split("."):
        if not isinstance(d, dict) or d.get(part) is None:
            die(4, "missing required field: " + path)
        d = d[part]
    return d
def scalar(v, path):
    if isinstance(v, (dict, list)):
        die(4, "field is not a scalar: " + path)
    return v
mode, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
if mode == "fields":
    for p in args:
        print(p + "=" + str(scalar(get(doc, p), p)))
elif mode == "list":
    items = get(doc, args[0])
    if not isinstance(items, list):
        die(4, args[0] + " is not a list")
    for it in items:
        print(" ".join(c + "=" + str(scalar(get(it, c), c)) for c in args[1].split(",")))
    nxt = doc.get("pagination", {}).get("next") if isinstance(doc.get("pagination"), dict) else None
    print("count=" + str(len(items)) + " more_pages=" + ("yes" if nxt else "no"))
elif mode == "env":
    rows = get(doc, "envs")
    if not isinstance(rows, list):
        die(4, "envs is not a list")
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("key"), str):
            die(4, "malformed env row")
        if r["key"] in args:
            print("key=%s target=%s type=%s createdAt=%s updatedAt=%s fields=%s" % (
                r["key"], ",".join(sorted(r.get("target") or [])), r.get("type"),
                r.get("createdAt"), r.get("updatedAt"),
                ",".join(sorted(k for k in r if k not in ("value", "decrypted")))))
    print("rows_total=" + str(len(rows)))
else:
    die(2, "unknown mode")
PY
)
vapi() {  # vapi <fields|list|env> <api-path> [args...]
  local mode="$1" api_path="$2"; shift 2
  ( set -o pipefail
    vercel api "$api_path" --scope convergepanel-ai | python3 -I -B -c "$VJSON" "$mode" "$@" ) \
    || { echo "STOP: vapi failed (exit $?) for $api_path" >&2; return 1; }
}
```

**How the helper fails.** Any `STOP:` line or a nonzero return means the result is **NOT VERIFIED**. Never fall back to printing the raw response.

The helper was exercised before publication against synthetic input, with a stand-in `vercel` function and no network:

| Case | Result |
|---|---|
| valid JSON | fields printed |
| JSON after a hint line | fields printed |
| malformed JSON | `STOP`, exit 3 |
| missing field | `STOP`, exit 4 |
| extra trailing output | `STOP`, exit 3 |
| two JSON documents | `STOP`, exit 3 |
| unrecognized text before the JSON | `STOP`, exit 3 |
| API error object | `STOP`, exit 3 |
| non-scalar field | `STOP`, exit 4 |
| `vercel` exiting nonzero with valid JSON | `STOP`, nonzero |
| env mode | never prints `value` |
| list mode with a next-page cursor | `more_pages=yes` |

### 2.3 Pre-mutation evidence capture (read-only, UTC timestamps)

Record each of these, with the UTC time, before **any** mutation:

1. **Project identity and auto-assignment.** STOP if `name` is not `convergepanel`:

   ```bash
   vapi fields /v9/projects/convergepanel name id autoAssignCustomDomains
   ```

2. **Serving deployment for each custom domain:**

   ```bash
   for a in convergepanel.com www.convergepanel.com; do echo "$a"; vapi fields "/v4/aliases/$a" deploymentId; done
   ```

3. **That deployment's identity:**

   ```bash
   vapi fields "/v13/deployments/<SERVING_DPL_ID>" id url readyState target createdAt meta.githubCommitSha
   ```

4. **Flag and monitoring configuration, names only.** This lists every row for each name, with its targets, creation and update times and field names:

   ```bash
   vapi env /v10/projects/convergepanel/env DS_PROVENANCE_ROUTE_VIEW_ENABLED NEXT_PUBLIC_SENTRY_DSN SENTRY_DSN
   ```

   Never use `vercel env pull`, never pass `decrypt=true`, and never write an API response to disk.

5. **Deployment protection settings** (needed for §6). Run the two commands below and record the results. A missing field ends that command with `STOP: missing required field`; record that field as **not set / NOT VERIFIED**, which is not an error:

   ```bash
   vapi fields /v9/projects/convergepanel ssoProtection.deploymentType
   vapi fields /v9/projects/convergepanel passwordProtection.deploymentType
   ```

6. **Known-good dark deployment:** see §2.4.

### 2.4 Choosing the known-good dark deployment

A deployment keeps the environment it was **created** with **[OBSERVED: rehearsal steps C, E and G]**. A dark deployment is one created while no `DS_PROVENANCE_ROUTE_VIEW_ENABLED=true` row applied to Production.

**Use the activation record, not metadata.** The activation operator must record, before and at activation (UTC):
- `<DARK_DPL_ID>`: the Production deployment serving immediately **before** activation, with its commit and `createdAt`;
- the activation time and the first flag-ON deployment ID.

Choose `<DARK_DPL_ID>` from that record.

Do **not** infer activation time from the variable's `createdAt` or `updatedAt`. A row can be edited, or deleted and re-created, which moves both. And a deployment created after the row existed may still have been built before the value was `true`, or the other way round.

**If no activation record exists:** STOP. A dark target cannot be established from Vercel metadata alone. Escalate, and use §3 (remove and redeploy, which needs no dark target) instead of §4.

**Prefer the most recent dark deployment.** Rolling back further than necessary has side effects:
- a deployment built before merge `2b97443` (PR #270) uses the old hard-coded browser Sentry relay, not `NEXT_PUBLIC_SENTRY_DSN`;
- one built before `76e1a565` (PR #271) restores four known critical contrast defects.

---

## 3. Normal deactivation (preferred path)

Use this path when there is time for one build. It changes no domain-assignment state.

| Step | Action | Authorization |
|---|---|---|
| 3.1 | Capture §2.3 | none |
| 3.2 | **Gate**, from §2.3 step 4: proceed only if there is **exactly one** `DS_PROVENANCE_ROUTE_VIEW_ENABLED` row, its `target` is exactly `production`, and its `fields` list has no field whose name contains `shared` or `configuration`. Otherwise STOP (§3.6) | none |
| 3.3 | Remove the row: `vercel env rm DS_PROVENANCE_ROUTE_VIEW_ENABLED production --scope convergepanel-ai --yes` | AUTH-ENV |
| 3.4 | Re-run §2.3 step 4. It must show no row for the name. Record the UTC removal time | none |
| 3.5 | Create a new Production deployment of the commit currently serving: `vercel redeploy <SERVING_DPL_ID> --target production --scope convergepanel-ai` **[UNTESTED IN PRODUCTION]**. Wait for READY. Confirm its `createdAt` is after the 3.4 removal time, and that both custom domains now serve it (§2.3 steps 2–3) | AUTH-DEPLOY |
| 3.6 | Run §6 (generated addresses) and §7 (verification) | AUTH-CONTAIN for any containment |

**Why 3.5 is required [OBSERVED]:**
- **Step B0:** a variable added without a redeploy had no effect.
- **Step G2:** a variable removed without a redeploy left the running build ON.

The flag only goes dark once a deployment created **after** the removal serves the custom domains.

**Shared or multi-target rows (3.2 STOP).** If the row also targets `preview` or `development`, or is a team-level shared or integration-managed variable, `vercel env rm … production` may affect other environments or projects, or may not remove the value that Production sees. That behaviour is **NOT VERIFIED** in this document. A separate owner decision must enumerate every affected environment and project, and its authorization boundary, before any change.

If the flag appears ON but the project list shows no row, check team-level shared environment variables (Vercel dashboard → Team Settings → Environment Variables) and STOP.

**Alternative to 3.5.** Merging a reviewed PR to `main` also creates a new Production deployment with the current variables. Use this only if a reviewed change is already approved for merge. Do not create a commit just to trigger a build.

**Do not use `vercel deploy --prod`** for `convergepanel`: it uploads the operator's local working tree instead of a reviewed commit.

`vercel redeploy` rebuilding with the **current** environment is documented Vercel behaviour **[INFERRED]**. The rehearsal never exercised it.

**STOP conditions** (go to §9):
- 3.4 still shows the row;
- the new deployment does not reach READY;
- the custom domains still point at the old deployment after READY.

---

## 4. Emergency Instant Rollback

Use this path only when the flag-ON deployment must stop serving the custom domains **immediately**, and the build time in §3 is not acceptable.

**Prerequisites:**
- AUTH-ROLLBACK naming `<DARK_DPL_ID>` exactly;
- §2.3 captured;
- `<DARK_DPL_ID>` taken from the activation record (§2.4).

**Merge freeze:** from step 4.1 until §5.6 is complete, **no merge to `main`**. While the variable is still `true`, any new Production build is flag-ON (§4, "What the rollback does").

| Step | Action | Authorization |
|---|---|---|
| 4.1 | `vercel rollback <DARK_DPL_ID> --scope convergepanel-ai --yes` **[OBSERVED in a disposable project; UNTESTED IN PRODUCTION]** | AUTH-ROLLBACK |
| 4.2 | Run `vercel rollback status --scope convergepanel-ai`, then confirm both custom domains → `<DARK_DPL_ID>` (§2.3 step 2) | none |
| 4.3 | Re-read `autoAssignCustomDomains` (§2.3 step 1) and record it. The rehearsal showed `false` after a rollback **[OBSERVED: step C]** | none |
| 4.4 | Run §6 (generated addresses) and the §7 checks that apply to the rolled-back deployment | AUTH-CONTAIN for any containment |
| 4.5 | **Continue immediately with §5.** A rollback alone is not a finished recovery | — |

**What the rollback does [OBSERVED: steps C and E, disposable project]:**
- The project's production alias served `<DARK_DPL_ID>` with **its own creation-time environment**, so the flag was dark at once.
- The variable was **not** changed. If it was `true`, it stays `true`.
- The project's `autoAssignCustomDomains` became `false`.

**What a new build does while auto-assignment is off (rehearsal step F):**

| Label | Behaviour |
|---|---|
| [OBSERVED] | The rehearsal project had **no custom domain**. A new deployment created with **`vercel deploy --prod`** reached READY. The project's production alias (`<project>.vercel.app`) **stayed** on the rolled-back deployment |
| [OBSERVED] | That new deployment **did** receive a generated, team-suffixed alias (`<project>-<team>.vercel.app`), which was **publicly reachable** in the rehearsal |
| [INFERRED, not demonstrated] | A deployment created by a **Git merge to `main`** behaves the same way |
| [INFERRED, not demonstrated] | The **custom domains** `convergepanel.com` and `www` likewise stay on the rolled-back deployment |
| [INFERRED, not demonstrated] | Whether a generated address of a ConvergePanel deployment is publicly reachable. This depends on Deployment Protection (§6) |

**The hazards:**
1. After a rollback, a READY deployment is not evidence that the custom domains serve it.
2. Without §5, the next merge to `main` may fail to reach users.
3. If the variable is still `true`, every new build, and any later promote, is flag-ON. Such a build can be reachable at generated addresses even while the custom domains are dark (§6).

---

## 5. Post-rollback recovery

Every step is required after §4. The order matters.

| Step | Action | Authorization |
|---|---|---|
| 5.1 | §3.2 gate, then remove the row (§3.3) and confirm it is gone by name (§3.4). Record the UTC removal time | AUTH-ENV |
| 5.2 | Create a fresh dark deployment: `vercel redeploy <MAIN_DPL_ID> --target production --scope convergepanel-ai`, where `<MAIN_DPL_ID>` is the most recent READY Production deployment of current `main` **[UNTESTED IN PRODUCTION]**. Wait for READY. While auto-assignment is off it is expected **not** to take the custom domains **[INFERRED from step F]** | AUTH-DEPLOY |
| 5.3 | Confirm the new deployment's `createdAt` is **after** the 5.1 removal time (§2.3 step 3) | none |
| 5.4 | Promote it: `vercel promote <NEW_DARK_DPL_ID> --scope convergepanel-ai --yes` **[OBSERVED: step G, disposable project]** | AUTH-PROMOTE |
| 5.5 | Confirm both custom domains → `<NEW_DARK_DPL_ID>` (§2.3 step 2) | none |
| 5.6 | Confirm `autoAssignCustomDomains` is `true` again (§2.3 step 1) **[OBSERVED: step G]**. The merge freeze ends here | none |
| 5.7 | Run §6 again (every flag-ON deployment, including any created during the freeze window) and all of §7 against `<NEW_DARK_DPL_ID>` | AUTH-CONTAIN for any containment |
| 5.8 | At the **next** ordinary merge to `main`, confirm with §2.3 steps 2–3 that its deployment took both custom domains automatically. Until then, auto-assignment is shown by the project setting only. The rehearsal showed an auto-assigned deploy after a promote **[OBSERVED: step G2, `vercel deploy --prod`, project alias only]** | none |

**Never promote a flag-ON deployment.** A promote serves that deployment's own creation-time environment **[OBSERVED: step G, the promoted deployment served the flag ON]**. Only promote a deployment whose `createdAt` is later than the variable's removal.

**Why not promote `<DARK_DPL_ID>` itself?** That would restore auto-assignment, but Production would stay on an older commit. Promoting a fresh build of current `main` returns Production to the current code, dark by configuration.

**Promoting does not contain anything.** Promoting a dark deployment moves the custom domains only. It does **not** make any flag-ON deployment, or its generated addresses, inaccessible. That is §6.

---

## 6. Generated deployment address exposure and containment

**Hazard.** A build created while `DS_PROVENANCE_ROUTE_VIEW_ENABLED=true` applied to Production can remain reachable through its own generated deployment URL and through generated aliases, even after the custom domains are restored to a dark deployment.

| Label | Basis |
|---|---|
| [OBSERVED] | In step F a non-promoted deployment held a generated alias |
| [INFERRED from Vercel's documented model] | Deployments are immutable and keep their own URLs; rollback and promote move domains, not access |

Because the routes accept a Firebase ID token as a Bearer header (§1.2), any signed-in user can call a flag-ON deployment's API routes at such an address unless Vercel blocks the request first.

**This exposure cannot be ruled out by checking the custom domains.** Run this section after §3, §4 and §5.

### 6.1 Identify every flag-ON deployment and its addresses (read-only)

The window is from the activation time in the activation record (§2.4) to the removal time recorded in §3.4 or §5.1, in epoch milliseconds:

```bash
vapi list "/v6/deployments?projectId=<PROJECT_ID>&target=production&since=<ACTIVATION_MS>&until=<REMOVAL_MS>&limit=100" deployments uid,url,created,state
```

- `<PROJECT_ID>` is the `id` from §2.3 step 1.
- The row fields `uid`, `url`, `created` and `state`, and the `projectId`, `target` and `until` parameters, match how CLI 54.4.1 itself reads this endpoint.
- The `since` parameter is from Vercel's API documentation **[INFERRED]**. Confirm every returned `created` is inside the window, and re-run with a wider window if in doubt.
- `more_pages=yes` means the list is incomplete. Narrow the window and repeat until every sub-window shows `more_pages=no`.

Add any deployment the activation record names as flag-ON. A deployment that started building before the removal but finished after it is flag-ON. For each flag-ON `<DPL_ID>`:

```bash
vapi list "/v2/deployments/<DPL_ID>/aliases" aliases alias
```

The address list is that deployment's own `url` plus every alias returned, other than the two custom domains.

### 6.2 Determine reachability (read-only, signed-out only)

For every address `<HOST>`:

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' "https://<HOST>/api/user/runs/runbook-reachability-probe"
```

| Observed | Classification |
|---|---|
| HTTP `401` with `content_type` `application/json` (the application's own `{"ok":false,"errorCode":"unauthorized",…}`) | **EXPOSED**: the application is reachable; a signed-in user's Bearer token would reach the flag-ON route |
| A Vercel authentication or password challenge (a redirect to a Vercel login, or a Vercel-served `401`/`403` page that is not `application/json`) | **CONTAINED by Deployment Protection**. The exact challenge format is **[INFERRED]**; record the raw status, content type and redirect |
| `404 DEPLOYMENT_NOT_FOUND` or similar from Vercel | **NOT REACHABLE** at that address |
| A Vercel bot-checkpoint `403`, a timeout, or anything else | **UNKNOWN**: retry once after about two minutes; never bypass |

**Never sign in, mint a token or send a credential to confirm exposure.** Authenticated confirmation is not authorized. Classify by the signed-out result only: an application `401` counts as exposed.

### 6.3 Applicable protection

Interpret the §2.3 step 5 values **[INFERRED from Vercel documentation; not verified for this project]**:
- `ssoProtection.deploymentType` of `all_except_custom_domains` or `all` (Vercel Authentication) requires a Vercel team login for generated deployment URLs.
- `prod_deployment_urls_and_all_previews` also covers production deployment URLs.
- `preview` covers previews only, so production deployment URLs are **not** protected.
- Not set: generated URLs are public.

Treat the §6.2 observation as authoritative over this interpretation.

### 6.4 Containment (each action needs its own AUTH-CONTAIN)

Use the least destructive option that contains every EXPOSED address:

1. **Enable or extend Deployment Protection** so production deployment URLs require Vercel authentication: project setting `ssoProtection.deploymentType`, in the Vercel dashboard → Project → Settings → Deployment Protection.
   - This is a project-wide change and affects every non-custom-domain URL, including Preview deployments and their testers.
   - The authorization must state that scope.
2. **Remove a generated alias:** `vercel alias rm <ALIAS_HOST> --scope convergepanel-ai`.
   - This removes that alias only. The deployment's own `url` stays reachable, so this alone is never sufficient.
3. **Last resort, destructive and irreversible: delete a specific flag-ON deployment** with `vercel remove <DPL_ID> --safe --scope convergepanel-ai`.
   - Never routine and never a first step.
   - Never the dark target or any deployment named in the activation record as a rollback target.
   - `--safe` skips deployments that still hold an active alias; if it skips, STOP.
   - It requires an authorization naming the exact deployment ID.

After each action, repeat §6.2 for every affected address. **Containment is effective only when every flag-ON address is CONTAINED or NOT REACHABLE.**

If any address stays EXPOSED or UNKNOWN, record **GENERATED_ADDRESS_EXPOSURE: NOT CONTAINED / NOT VERIFIED** with the address, the time and the reason, and escalate (§9). Do not report the deactivation as complete.

---

## 7. Verification after any path

Run these read-only checks. Record the UTC time of each and the deployment ID it applies to.

### 7.1 Configuration, routing and access

| Check | How | Expected |
|---|---|---|
| Domains | §2.3 step 2 | both custom domains → the intended deployment |
| Deployment identity | §2.3 step 3 | READY, `production`, expected commit |
| Flag configuration | §2.3 step 4 | no `DS_PROVENANCE_ROUTE_VIEW_ENABLED` row |
| Flag effective state | the serving deployment's `createdAt` is after the recorded removal time, **or** it is the activation record's dark deployment | dark by configuration |
| Generated addresses | §6 | every flag-ON address CONTAINED or NOT REACHABLE |
| Signed-out access | `curl -s -o /dev/null -w '%{http_code}\n' https://convergepanel.com/api/user/runs/runbook-reachability-probe` | `401` |
| Browser monitoring relay | `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://convergepanel.com/monitoring` | `400` (configured; `app/monitoring/route.ts`). `404` means `NEXT_PUBLIC_SENTRY_DSN` did not resolve when the serving build was created |
| Monitoring configuration | §2.3 step 4 | `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` rows present for `production` |

### 7.2 Errors and 5xx: deployment-scoped, bounded, completeness-checked

Facts about `vercel logs`, read from the installed CLI 54.4.1 source (`dist/commands-bulk.js`, `src/util/logs-v2.ts` and `src/commands/logs/index.ts`):

- **Window:** `--since` and `--until` are sent to the API as `startDate` and `endDate`, so the window is bounded server-side. A relative value (`30m`) is recomputed from the current time on **every page request**, so the window can drift. **Use absolute ISO UTC times only** (`2026-10-30T17:25:00Z`).
- **Defaults:** without `--since`, the window is the last 24 hours; without `--until`, it is "now".
- **Deployment:** `--deployment <DPL_ID>` sends `deploymentId`. When a deployment is given, the CLI does **not** auto-detect a git branch. The command still passes `--no-branch`, so a missing deployment can never fall back to the current branch.
- **Limit and paging:** `--limit` (default `100`) caps the rows **returned**. The CLI pages until the limit or until the API reports no more rows. The CLI does not print whether more rows remained, so a count equal to the limit means the result **may be truncated**.
- **Missing timestamps:** a row with no timestamp is given the current time by the CLI. The counter below therefore treats any row outside the window as an INCOMPLETE result.
- **Two different questions:**
  - `--status-code 5xx` filters on the HTTP response status;
  - `--level error` (or `fatal`) filters on requests that carry a log entry at that level.

  Neither implies the other, so both are run. `--level` takes one value per query.
- **Output:** `--json` prints one row per line, and rows include log **message text**. The counter prints counts only.

```bash
VLOGS=$(cat <<'PY'
import datetime, json, re, sys
HINT = re.compile(r"\s*<claude-code-hint\b[^<>]*/>\s*")
dpl, start, end, limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ms = lambda s: int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
lo, hi = ms(start), ms(end)
rows = malformed = other = outside = 0
for line in sys.stdin:
    s = line.strip()
    if not s or HINT.fullmatch(s):
        continue
    try:
        r = json.loads(s)
    except ValueError:
        malformed += 1; continue
    if not isinstance(r, dict) or not isinstance(r.get("timestamp"), (int, float)) or "deploymentId" not in r:
        malformed += 1; continue
    rows += 1
    other += r["deploymentId"] != dpl
    outside += not (lo <= r["timestamp"] <= hi)
complete = malformed == 0 and other == 0 and outside == 0 and rows < limit
print("rows=%d malformed=%d other_deployment=%d outside_window=%d limit=%d result=%s" % (
    rows, malformed, other, outside, limit, "COMPLETE" if complete else "INCOMPLETE"))
sys.exit(0 if complete else 5)
PY
)
vlogs() {  # vlogs <DPL_ID> <START_ISO_UTC> <END_ISO_UTC> <LIMIT> [one extra filter]
  local dpl="$1" start="$2" end="$3" limit="$4"; shift 4
  ( set -o pipefail
    vercel logs --project convergepanel --scope convergepanel-ai --deployment "$dpl" --no-branch \
      --environment production --since "$start" --until "$end" --limit "$limit" --json "$@" \
    | python3 -I -B -c "$VLOGS" "$dpl" "$start" "$end" "$limit" ) \
    || { echo "INCOMPLETE: log query failed or could not be shown complete (exit $?)" >&2; return 1; }
}
```

Run all four, using the **same** window and limit:

```bash
vlogs <DPL_ID> <START> <END> 1000                        # total rows (proves the query returns data)
vlogs <DPL_ID> <START> <END> 1000 --status-code 5xx      # HTTP 5xx responses
vlogs <DPL_ID> <START> <END> 1000 --level error          # error-level log entries
vlogs <DPL_ID> <START> <END> 1000 --level fatal          # fatal-level log entries
```

- **Window:** `<START>` is the UTC time the custom domains switched to `<DPL_ID>`. `<END>` is at least 15 minutes later and must already be in the past.
- **Valid only if** every run prints `result=COMPLETE` and returns 0. Record the four output lines and the exact command.
- **INCOMPLETE** (for any reason, including `rows` reaching the limit) means:
  - split the window into smaller absolute windows and re-run each one;
  - or record that run as **INCOMPLETE** and **do not claim zero errors**.
- **Zero total rows** for a window in which traffic was expected is **INCOMPLETE**, not "no errors".
- The helper behaviour was exercised before publication against synthetic JSON lines, with a stand-in `vercel` and no network:

  | Case | Result |
  |---|---|
  | complete | COMPLETE |
  | rows reaching the limit | INCOMPLETE |
  | malformed line | INCOMPLETE |
  | other deployment | INCOMPLETE |
  | outside window | INCOMPLETE |
  | hint line skipped | COMPLETE |
  | CLI `deployment_error` object | INCOMPLETE |
  | nonzero `vercel` exit | INCOMPLETE |

**Bot checkpoint.** Scripted requests to `convergepanel.com` can receive a Vercel bot-checkpoint `403`. Keep requests to a handful, pause about two minutes and retry once. Never bypass the checkpoint. A checkpoint `403` is not an application result.

**Authenticated dark behaviour is not verifiable by this runbook today.** No Production test identity is authorized. The flag's effect, the presence or absence of `dsProvenance` on an authorized response, cannot be observed by a signed-out request. Record **PRODUCTION_AUTHENTICATED_DARK_STATE: NOT VERIFIED** unless a separately authorized method exists. Dark state in Production is established by configuration and deployment-creation time, not by observation.

**STOP and escalate (§9)** if any check fails or a result cannot be obtained.

---

## 8. Evidence and limitations

### 8.1 What was rehearsed

Order 6 rollback rehearsal 2 ran on 2026-10-29 in the disposable Vercel project `o6-rollback-rehearsal-em805q` (team `convergepanel-ai`).
- The project was created and deleted by the script.
- It had **no custom domain**. Only Vercel-generated `*.vercel.app` addresses were observed.
- New deployments were created with `vercel deploy --prod`.
- The ConvergePanel Production alias was recorded before and after the run and was unchanged.

**Evidence archive:** `ConvergePanel-Controlled-Verification-Evidence/order6-rollback-rehearsal-2/`, outside this repository:
- `README.md`
- `tools/rehearse.py`, `tools/verify.py`
- `verify.json`
- `steps/01–14`
- `MANIFEST.sha256` (sha256 of the manifest file: `73433762…`)

**Verifier:** 12/13 PASS on the scripted record. The one failure was a CLI-table parser defect in the cleanup comparison. Deletion was then verified by a post-hoc API read (`steps/14`).

| Step | Observed (disposable project, project alias `<project>.vercel.app`) | Used in |
|---|---|---|
| A | deploy without the variable → dark | §2.4 |
| B0 | add the variable, no redeploy → still dark | §3 |
| B | deploy → ON | — |
| C | `vercel rollback` to A → alias back on A, dark immediately; `autoAssignCustomDomains=false` | §4 |
| E | after the rollback, the variable is still present; the old build stays dark | §4 |
| F | `vercel deploy --prod` after the rollback → READY; project alias **stayed** on A; the new deployment **did** get the generated alias `<project>-<team>.vercel.app` | §4, §5, §6 |
| G | `vercel promote` of F → project alias moved to F; auto-assignment `true`; F served its own environment (ON) | §5 |
| G2 | remove the variable (running build stays ON) → `vercel deploy --prod` → dark, auto-assigned | §3, §5 |

### 8.2 Limitations

- The rehearsal's flag probe was an **unauthenticated stand-in function** that reads a runtime variable the same way `lib/env.ts` does. It was not ConvergePanel's authenticated provenance response.
- **Not exercised in the rehearsal:**
  - custom-domain behaviour;
  - Git-integration (merge) deployments;
  - `vercel redeploy`;
  - Deployment Protection;
  - generated-address reachability for ConvergePanel.

  Statements about these are **[INFERRED]**.
- The rehearsal archive does not record the local CLI version (build logs in it show the build container's CLI 65.4.0). The CLI facts in §2.2 and §7.2 come from the author's local Vercel CLI 54.4.1. Operators record their own version (§2.1).
- **No Production rollback, promote, redeploy, flag change, protection change or containment has been performed.** All Production steps here are **[UNTESTED IN PRODUCTION]**.
- **Authenticated Production dark state is NOT VERIFIED.** Authenticated OFF and ON behaviour was verified in the isolated Firebase project `convergepanel-sa-verify-y0ibg9`, with a local production build: 718/718 browser checks and 447/447 API checks. That is not a Production observation.
- Vercel platform behaviour may change. Re-read aliases, `autoAssignCustomDomains` and protection settings instead of assuming them.

---

## 9. Recovery and escalation matrix

In every row: **STOP**, record the observed state with UTC times, and take only the action listed, under the named authorization. If that authorization is not already held, escalate to the owner and wait.

| Situation | Likely cause | Action | Authorization |
|---|---|---|---|
| Rollback succeeded but one or both custom domains are not on `<DARK_DPL_ID>` | rollback still pending, or a domain is assigned separately | `vercel rollback status`; re-read both aliases after the `--timeout` (default 3m). If still wrong, escalate. Do not issue another rollback or promote without a new decision | none to re-read; AUTH-ROLLBACK or AUTH-PROMOTE for any further change |
| Variable removed but the custom domains still serve a flag-ON build | no new deployment since the removal (§3, "Why 3.5 is required") | §3.5 (normal) or §4 (emergency) | AUTH-DEPLOY or AUTH-ROLLBACK |
| §3.2 gate fails: several rows, a non-`production` target, or a shared or integration field | shared or multi-target variable | STOP. A new decision must enumerate every affected environment and project | separate owner decision |
| New deployment READY but not serving the custom domains | auto-assignment suspended after an earlier rollback (step F) | Check `autoAssignCustomDomains`. If `false`, confirm the new deployment was created after the variable's removal, then §5.4. Keep the merge freeze | AUTH-PROMOTE |
| `autoAssignCustomDomains` still `false` after §5.4 | promote not completed | Re-read after a few minutes, then escalate. Keep the merge freeze: merges may not reach the custom domains | — |
| Any flag-ON address EXPOSED or UNKNOWN (§6) | generated URL or alias not covered by protection | §6.4, least destructive option first; re-check §6.2 | AUTH-CONTAIN (one per action) |
| `/monitoring` returns `404`, or a Sentry row is missing | `NEXT_PUBLIC_SENTRY_DSN` absent when the serving build was created, or a row removed. Builds before PR #270 (`2b97443`) use a different, hard-coded relay configuration, and their `/monitoring` responses are not covered by this check | Record it. Do not re-add values from memory or logs. Escalate: restoring monitoring is a separate configuration decision | separate owner decision |
| Signed-out request does not return `401`, or any authorization result differs from expectation | unexpected build or regression | STOP all further changes and escalate immediately as a security incident. Do not attempt a code fix under this runbook | owner / incident process |
| §7.2 shows 5xx, error or fatal rows | regression in the serving build | Record the counts and window, then escalate. If the serving build is flag-ON, §4 may be authorized | AUTH-ROLLBACK |
| A required check cannot be established (helper `STOP`, `INCOMPLETE`, API error, persistent bot checkpoint) | tooling or access | Record it as **NOT VERIFIED** or **INCOMPLETE** with the reason. Do not report success | — |
| A promoted or rolled-back deployment turns out to be flag-ON | wrong target chosen | STOP; select a correct target from the activation record (§2.4); escalate | AUTH-ROLLBACK or AUTH-PROMOTE (new) |

---

## 10. Record template

Copy this into the incident or activation record and fill in every line. Leave nothing implied.

```
Operator:            vercel --version:            Authorizations held (code, who, UTC, exact target):
Pre-state (UTC):     domains -> ______ / ______   commit ______   autoAssign ______   flag rows ______   protection ______
Dark deployment (from activation record): ______  commit ______  createdAt ______
Actions (each: UTC, exact command, exit code):
Removal time (UTC): ______        New dark deployment: ______  createdAt ______
Post-state (UTC):    domains -> ______ / ______   commit ______   autoAssign ______   flag rows ______
Generated addresses (§6): flag-ON deployments ______  each address -> EXPOSED | CONTAINED | NOT REACHABLE | UNKNOWN
§7.1: 401 __  /monitoring __  Sentry rows __
§7.2 window ______–______ limit ____: total __ 5xx __ error __ fatal __  (each COMPLETE | INCOMPLETE)
Authenticated dark state: NOT VERIFIED (reason) | VERIFIED (separately authorized method + evidence)
Next ordinary merge auto-assigned to both custom domains (date, deployment): ______
```
