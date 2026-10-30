# Decision Support provenance view: deactivation and rollback runbook

Operational procedure for turning the Decision Support (DS) provenance view **off** in Production, either by a normal configuration change or by an emergency Vercel Instant Rollback. It also covers recovering Production domain assignment afterwards, and containing flag-ON builds that stay reachable at generated deployment addresses.

**Status of this document (2026-10-30):** written before any Production activation. The flag has never been enabled in Production. Nothing here records or claims a completed Production rollback.

This runbook does not authorize anything by itself. Every mutating step names the separate owner authorization it needs (§1.4).

## Evidence labels

Every behavioural statement carries one of these labels:

| Label | Meaning |
|---|---|
| **[OBSERVED]** | Seen directly in a recorded run, with the record named: the disposable-project rehearsal (§8.1), or the Order 6 release verification records of 2026-10-30. Never a Production rollback |
| **[SOURCE]** | Read from source code: this repository at the commit containing this document, or the installed Vercel CLI 54.4.1 bundle (`vercel/dist/…`) |
| **[HARNESS]** | Exercised by the local, no-network test harness against synthetic input (§8.3) |
| **[INFERRED]** | Expected from Vercel documentation or reasoning, but not demonstrated |
| **[UNTESTED IN PRODUCTION]** | Never executed against the `convergepanel` project |

**Shell:** the helpers in §2.2 are written for `bash` (tested with GNU bash 3.2). Run them in `bash`, not `zsh` or `sh`.

---

## 1. Purpose and applicability

### 1.1 The flag

| Item | Value |
|---|---|
| Variable | `DS_PROVENANCE_ROUTE_VIEW_ENABLED` |
| Defined in | `lib/env.ts`: `export const DS_PROVENANCE_ROUTE_VIEW_ENABLED = process.env.DS_PROVENANCE_ROUTE_VIEW_ENABLED === "true";` [SOURCE] |
| ON only when | the value is exactly the string `true` [SOURCE] |
| Scope | server-only. There is no `NEXT_PUBLIC_` variant [SOURCE] |
| Read | once, when the server module loads, from the environment of the **deployment** serving the request [SOURCE] |
| Intended Production state today | **absent** (dark by configuration) |

**Absent versus `false`.** In code, any value other than exactly `true` is OFF [SOURCE]. This runbook nevertheless supports **only removal** of the variable as deactivation. A remaining record with some other value cannot be verified as OFF without reading the value, and this runbook never reads environment values. "Not `true`" is therefore established only by the record being absent (§2.3 step 4).

### 1.2 What the flag changes

When ON, three authorized read routes may add one optional top-level `dsProvenance` field to a response that already carries a usable Decision Support review (`lib/adaptiveSchema/dsProvenanceRouteAdapter.ts`) [SOURCE]:

| Surface | Route | Code |
|---|---|---|
| P1 | `GET /api/user/runs/[runId]` | `app/api/user/runs/[runId]/route.ts` |
| P2 | `GET /api/user/runs/[runId]/governance` | `app/api/user/runs/[runId]/governance/route.ts` |
| W1 | `GET /api/workspaces/[workspaceId]/runs/[runId]` | `app/api/workspaces/[workspaceId]/runs/[runId]/route.ts` |

The UI renders the provenance section only when that field is present [SOURCE]: `components/adaptive/DsProvenanceSection.tsx`, marked `data-ds-provenance-section`, rendered from `AdaptivePanelResponse.tsx` and `PersonalReviewDetail.tsx`.

When OFF, the view builder is never called, no `dsProvenance` field is emitted, and the section never renders. Only the three routes above call the adapter. The Workspace governance surface W2 is deferred (owner ruling D-W2): no route passes it to the adapter [SOURCE].

The flag changes **no** authorization decision: every denial returns before the adapter runs [SOURCE].
- A signed-out request to P1 gets HTTP `401` with a JSON body `{"ok":false,"errorCode":"unauthorized",…}` [SOURCE: `getUid` in the P1 route].
- These routes accept the `__session` cookie **or** an `Authorization: Bearer <Firebase ID token>` header (`lib/auth/resolveRequestIdentity.ts`) [SOURCE].

That is why §6 treats any reachable flag-ON deployment as exposed to any signed-in user, at whatever host serves it.

### 1.3 Boundaries

- **In scope:**
  - turning the flag OFF;
  - Instant Rollback to a known-good dark deployment;
  - restoring Production domain auto-assignment;
  - containing flag-ON deployments at generated addresses;
  - verifying the result.
- **Out of scope:** turning the flag ON (activation). This document only describes how to undo it.
- **Never in scope:**
  - Firebase or Firestore changes;
  - user data;
  - creating test identities or signing in;
  - reading or writing any environment **value**;
  - editing any other Production variable.

### 1.4 Authorization boundaries

Each of these is a **separate** owner authorization. Approval for one does not extend to the next. Each must name the exact target, whether a deployment ID, record or setting.

| Code | Action | Changes |
|---|---|---|
| **AUTH-ENV** | Delete the single `DS_PROVENANCE_ROUTE_VIEW_ENABLED` record that passed the §3.2 gate (production-only) | Production configuration |
| **AUTH-ENV-SHARED** | Any change to a record that **failed** the §3.2 gate. The authorization must list every affected target, branch, custom environment and integration (§3.7) | Every listed environment |
| **AUTH-DEPLOY** | Create a new Production deployment (redeploy) | Production deployment |
| **AUTH-ROLLBACK** | `vercel rollback` to a named deployment | Production domains |
| **AUTH-PROMOTE** | `vercel promote` a named deployment | Production domains and auto-assignment |
| **AUTH-CONTAIN** | One named containment action from §6.4 | Project protection settings, an alias, or (last resort) a deployment |

Read-only checks need no mutation authorization. They must still never print environment values or log contents; the helpers in §2.2 enforce this for their own output.

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

**Record the CLI version:** run `vercel --version`. The CLI statements in this document come from Vercel CLI **54.4.1** [SOURCE]. If your version differs, re-check every command's `--help` before use, and treat the [SOURCE] statements as unconfirmed for your version.

### 2.2 Read-only helpers (load once per bash shell)

**Output streams.** The CLI writes progress and notices to stderr, and `vercel api` writes the response body to stdout.

- When the `CLAUDECODE` environment variable is set, the CLI also writes a `<claude-code-hint … />` line to **stderr** [SOURCE: `dist/index.js`, which writes it with `process.stderr.write`]. The rehearsal's raw records show that line in stderr, not stdout [OBSERVED: rehearsal `steps/14`].
- An earlier inspection by this document's author **merged stderr into stdout** (`2>&1`), and so misattributed the line to stdout. That claim is withdrawn.
- The rehearsal recorded no Production project ID (`steps/01`, `productionProjectIdRecorded: false`). **The cause is unexplained.** It is not attributed to the hint line.

**The helpers therefore:**
- never merge stderr into stdout, and never strip anything from stdout;
- leave stderr on the terminal;
- require stdout to be exactly **one** JSON object;
- treat any other stdout content as a failure.

**What the helpers guarantee, each covered by §8.3 [HARNESS]:**
- **Output format:** every result is **one line of JSON** (`json.dumps`, ASCII-escaped), so newlines or control characters inside any input value cannot forge extra output lines. Booleans are JSON `true`/`false`.
- **No values:**
  - `fields` and `list` refuse to output any field path containing a segment named `value` or `decrypted`;
  - the `env-*` modes output field **names**, scope fields and timestamps only, never a value.
- **Fail closed** (exit code in brackets):
  - empty stdout, non-JSON stdout, more than one JSON document, a non-object document, or an `error` object in the response [3];
  - a missing or null required field, a wrong type, or a non-scalar where a scalar is required [4];
  - an incomplete listing [6];
  - a gate decision of STOP [7];
  - an invalid log window or filter [8].
- **Failure messages:** they go to stderr as JSON and never contain values from the response.
- **CLI failure:** if `vercel` exits nonzero, the helper **withholds** stdout entirely, prints `STOP` with both exit codes, and returns nonzero.

**What the helpers do not guarantee:**
- that the Vercel API schema is unchanged;
- the meaning of fields beyond those listed per mode.

```bash
VJSON=$(cat <<'PY'
import json, sys
DENY = {"value", "decrypted"}
def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True, sort_keys=True) + "\n")
def fail(code, reason):
    sys.stderr.write(json.dumps({"status": "STOP", "reason": reason}, ensure_ascii=True) + "\n"); sys.exit(code)
def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
def load():
    body = sys.stdin.read().strip()
    if not body:
        fail(3, "empty stdout")
    try:
        doc, end = json.JSONDecoder().raw_decode(body)
    except ValueError:
        fail(3, "stdout is not a JSON document")
    if body[end:].strip():
        fail(3, "unexpected output after the JSON document")
    if not isinstance(doc, dict):
        fail(3, "JSON document is not an object")
    if "error" in doc:
        err = doc["error"]
        code = err.get("code") if isinstance(err, dict) else None
        fail(3, "API error " + json.dumps(code if isinstance(code, str) else None))
    return doc
def check_path(path):
    parts = path.split(".")
    if any(p == "" or p in DENY for p in parts):
        fail(2, "refused field path " + json.dumps(path))
    return parts
def scalar(d, path):
    for p in check_path(path):
        if not isinstance(d, dict) or d.get(p) is None:
            fail(4, "missing required field " + json.dumps(path))
        d = d[p]
    if isinstance(d, (dict, list)):
        fail(4, "field is not a scalar " + json.dumps(path))
    return d
def more_pages(doc):
    pg = doc.get("pagination")
    if pg is None:
        return False
    if not isinstance(pg, dict):
        fail(4, "pagination is not an object")
    return pg.get("next") is not None
def env_rows(doc):
    rows = doc.get("envs")
    if not isinstance(rows, list):
        fail(4, "envs is not a list")
    if more_pages(doc):
        emit({"complete": False}); sys.exit(6)
    for r in rows:
        if not isinstance(r, dict) or not isinstance(r.get("key"), str):
            fail(4, "malformed env record")
    return rows
def targets(r):
    t = r.get("target")
    if isinstance(t, str):
        return [t]
    if isinstance(t, list) and all(isinstance(x, str) for x in t):
        return sorted(t)
    return None
def summary(r):
    ce = r.get("customEnvironmentIds")
    return {
        "id_present": isinstance(r.get("id"), str) and r["id"] != "",
        "target": targets(r),
        "type": r["type"] if isinstance(r.get("type"), str) else None,
        "gitBranch_set": r.get("gitBranch") not in (None, ""),
        "configurationId_set": r.get("configurationId") is not None,
        "customEnvironmentIds_count": len(ce) if isinstance(ce, list) else (0 if ce is None else None),
        "createdAt": r["createdAt"] if is_num(r.get("createdAt")) else None,
        "updatedAt": r["updatedAt"] if is_num(r.get("updatedAt")) else None,
        "field_names": sorted(k for k in r if isinstance(k, str)),
    }
mode, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
if mode == "fields" and args:
    doc = load()
    emit({p: scalar(doc, p) for p in args})
elif mode == "list" and len(args) == 2:
    doc = load(); cols = args[1].split(",")
    for c in cols:
        check_path(c)
    items = doc.get(args[0])
    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
        fail(4, json.dumps(args[0]) + " is not a list of objects")
    complete = not more_pages(doc)
    emit({"items": [{c: scalar(i, c) for c in cols} for i in items], "count": len(items), "complete": complete})
    sys.exit(0 if complete else 6)
elif mode == "deployments" and len(args) == 1 and args[0].isdigit():
    doc = load(); since = int(args[0]); items = doc.get("deployments")
    if not isinstance(items, list):
        fail(4, "deployments is not a list")
    rows = [{c: scalar(i, c) for c in ("uid", "url", "created", "state")} for i in items]
    if not all(is_num(r["created"]) for r in rows):
        fail(4, "created is not a number")
    covered = (not more_pages(doc)) or any(r["created"] < since for r in rows)
    emit({"items": [r for r in rows if r["created"] >= since], "covers_window": covered})
    sys.exit(0 if covered else 6)
elif mode == "env-gate" and len(args) == 1:
    rows = [r for r in env_rows(load()) if r["key"] == args[0]]
    reasons = []
    if len(rows) != 1:
        reasons.append("records=%d, exactly 1 required" % len(rows))
    else:
        s = summary(rows[0])
        if not s["id_present"]: reasons.append("record id missing")
        if s["target"] != ["production"]: reasons.append("target is not exactly [production]")
        if s["gitBranch_set"]: reasons.append("gitBranch set")
        if s["configurationId_set"]: reasons.append("configurationId set (integration-managed)")
        if s["customEnvironmentIds_count"] != 0: reasons.append("custom environments attached or unreadable")
        if s["type"] not in ("encrypted", "sensitive", "plain"): reasons.append("type is not encrypted, sensitive or plain")
    emit({"name": args[0], "records": [summary(r) for r in rows], "reasons": reasons,
          "decision": "PRODUCTION_ONLY_RECORD" if not reasons else "STOP"})
    sys.exit(0 if not reasons else 7)
elif mode == "env-absent" and len(args) == 1:
    n = sum(1 for r in env_rows(load()) if r["key"] == args[0])
    emit({"name": args[0], "records": n, "absent": n == 0})
    sys.exit(0 if n == 0 else 7)
elif mode == "env-present" and args:
    rows = env_rows(load()); res = {}
    for name in args:
        m = [r for r in rows if r["key"] == name]
        res[name] = {"records": len(m), "production_records": sum(1 for r in m if "production" in (targets(r) or []))}
    ok = all(v["production_records"] >= 1 for v in res.values())
    emit({"names": res, "all_present_for_production": ok})
    sys.exit(0 if ok else 7)
else:
    fail(2, "unknown mode or wrong arguments")
PY
)
vapi() {  # vapi <mode> <api-path> [args...]   (read-only GET via `vercel api`)
  local mode="$1" api_path="$2"; shift 2
  local res codes vc pc
  res=$(vercel api "$api_path" --scope convergepanel-ai | python3 -I -B -c "$VJSON" "$mode" "$@"; printf '\n#rc %s %s' "${PIPESTATUS[0]}" "${PIPESTATUS[1]}")
  codes=${res##*#rc }; res=${res%$'\n'#rc *}; vc=${codes% *}; pc=${codes#* }
  if [ "$vc" != 0 ]; then
    printf '{"status":"STOP","reason":"vercel exited %s; output withheld","check_exit":%s}\n' "$vc" "$pc" >&2
    return "$vc"
  fi
  [ -n "$res" ] && printf '%s\n' "$res"
  return "$pc"
}
VPROBE=$(cat <<'PY'
import json, sys
from urllib.parse import urlsplit
host, rc = sys.argv[1], sys.argv[2]
parts = sys.stdin.read().split("\t")
res = {"host": host, "curl_exit": int(rc) if rc.isdigit() else None}
if rc != "0" or len(parts) != 3:
    res["class"] = "INCONCLUSIVE"
else:
    code, ctype, redirect = parts
    rhost = (urlsplit(redirect).hostname or "") if redirect else ""
    res.update({"http_code": code, "content_type": ctype, "redirect_host": rhost})
    if code == "401" and ctype.lower().startswith("application/json"):
        res["class"] = "APP_401"
    elif code in ("301", "302", "303", "307", "308") and (rhost == "vercel.com" or rhost.endswith(".vercel.com")):
        res["class"] = "VERCEL_REDIRECT"
    elif code == "401":
        res["class"] = "NON_APP_401"
    else:
        res["class"] = "INCONCLUSIVE"
print(json.dumps(res, ensure_ascii=True, sort_keys=True))
PY
)
vprobe() {  # vprobe <host>   (signed-out GET, bounded timeouts, classification only)
  local host="$1" w rc
  case "$host" in ""|*[!a-z0-9.-]*) echo '{"status":"STOP","reason":"invalid host"}' >&2; return 2;; esac
  w=$(curl -sS -o /dev/null --proto '=https' --connect-timeout 10 --max-time 20 \
        -w '%{http_code}\t%{content_type}\t%{redirect_url}' \
        "https://$host/api/user/runs/runbook-reachability-probe" 2>/dev/null); rc=$?
  printf '%s' "$w" | python3 -I -B -c "$VPROBE" "$host" "$rc"
}
```

**How to read helper results:** any `STOP`, `INCOMPLETE` or `INVALID_WINDOW` line, or a nonzero return, means that check is **NOT VERIFIED**. Never fall back to printing a raw response, and never re-run with stderr merged into stdout.

**`vprobe` classes**, used in §6.2 and §7.1:

| Class | Meaning |
|---|---|
| `APP_401` | ConvergePanel's own JSON 401, so the application answered [SOURCE: P1 route] |
| `VERCEL_REDIRECT` | a redirect to a `vercel.com` host |
| `NON_APP_401` | a `401` that is not JSON |
| `INCONCLUSIVE` | anything else, including a curl timeout or connection failure (`--connect-timeout 10`, `--max-time 20`) and a bot-checkpoint `403` |

A timeout is **never** evidence of containment.

### 2.3 Pre-mutation evidence capture (read-only, UTC timestamps)

Record each of these, with the UTC time, before **any** mutation.

1. **Project identity and auto-assignment.** STOP if `name` is not `convergepanel`. Response fields `name`, `id` and `autoAssignCustomDomains` [OBSERVED: Order 6 release verification, 2026-10-30]:

   ```bash
   vapi fields /v9/projects/convergepanel name id autoAssignCustomDomains
   ```

2. **Serving deployment for each custom domain** (`deploymentId` [OBSERVED: Order 6 release verification]):

   ```bash
   vapi fields /v4/aliases/convergepanel.com deploymentId
   vapi fields /v4/aliases/www.convergepanel.com deploymentId
   ```

3. **That deployment's identity:**

   ```bash
   vapi fields /v13/deployments/<SERVING_DPL_ID> id url readyState target createdAt meta.githubCommitSha
   ```

   - `readyState`, `target` and `meta.githubCommitSha` [OBSERVED: Order 6 release verification].
   - `id`, `url` and `createdAt` [SOURCE: the CLI reads these from the same endpoint].

4. **Flag record scope (never values).** `env-gate` inspects the complete project listing. The fields it reads (`key`, `type`, `target` as a string or list, `gitBranch`, `configurationId`, `customEnvironmentIds`, `id`, `createdAt`, `updatedAt`) are the ones the CLI itself reads from this endpoint [SOURCE: `dist/commands/env/index.js`]:

   ```bash
   vapi env-gate /v10/projects/convergepanel/env DS_PROVENANCE_ROUTE_VIEW_ENABLED
   ```

   - Before deactivation, the expected result is `decision: PRODUCTION_ONLY_RECORD`.
   - After removal, use `vapi env-absent /v10/projects/convergepanel/env DS_PROVENANCE_ROUTE_VIEW_ENABLED`, which expects `absent: true`.

   The CLI reads this listing in a single request with no paging [SOURCE: `getEnvRecords`]. The helper still STOPs (exit 6) if the response carries a `pagination.next` cursor. Note that the listing returns plaintext values for `plain`-type records [SOURCE: `env ls`]. The helper never outputs them.

5. **Monitoring configuration (names only):**

   ```bash
   vapi env-present /v10/projects/convergepanel/env NEXT_PUBLIC_SENTRY_DSN SENTRY_DSN
   ```

6. **Deployment protection settings** (needed for §6). The field names are from Vercel's API documentation [INFERRED]. A `missing required field` STOP here means "not set or not readable". Record it as such, and treat it as **no protection established**:

   ```bash
   vapi fields /v9/projects/convergepanel ssoProtection.deploymentType
   vapi fields /v9/projects/convergepanel passwordProtection.deploymentType
   ```

7. **Known-good dark deployment:** see §2.4.

**Team-level shared variables.** The CLI reads only the project listing [SOURCE]. Whether a team-level shared variable linked to this project appears in it is **NOT VERIFIED**. If the activation record says the flag was set at team level, or step 4 finds no record while the activation record says one was created, STOP.

### 2.4 Choosing the known-good dark deployment

A deployment keeps the environment it was **created** with [OBSERVED: rehearsal steps C, E and G]. A dark deployment is one created while no `DS_PROVENANCE_ROUTE_VIEW_ENABLED=true` record applied to Production.

**Use the activation record, not metadata.** The activation operator must record, at activation (UTC):
- `<DARK_DPL_ID>`: the Production deployment serving immediately **before** activation, with its commit and `createdAt`;
- the activation time, as epoch milliseconds `<ACTIVATION_MS>`;
- the first flag-ON deployment ID.

Choose `<DARK_DPL_ID>` from that record.

**Do not infer activation time from the variable's `createdAt` or `updatedAt`.** A record can be edited, or deleted and re-created. A deployment created after the record existed may still have been built before the value was `true`, and the reverse.

**If no activation record exists:** STOP. Neither a dark target nor `<ACTIVATION_MS>` can be established from Vercel metadata alone. Escalate.

**Prefer the most recent dark deployment.** Rolling back further than necessary has side effects:
- a deployment built before merge `2b97443` (PR #270) uses the old hard-coded browser Sentry relay [SOURCE: `2b97443^1`];
- one built before `76e1a565` (PR #271) restores four known critical contrast defects.

---

## 3. Normal deactivation (preferred path)

Use this path when there is time for one build. It changes no domain-assignment state.

| Step | Action | Authorization |
|---|---|---|
| 3.1 | Capture §2.3 | none |
| 3.2 | **Gate:** `vapi env-gate …` (§2.3 step 4) must return `decision: PRODUCTION_ONLY_RECORD` and exit 0. On anything else, go to §3.7 | none |
| 3.3 | Delete that record: `vercel env rm DS_PROVENANCE_ROUTE_VIEW_ENABLED production --scope convergepanel-ai --yes` [UNTESTED IN PRODUCTION] | AUTH-ENV |
| 3.4 | `vapi env-absent …` must return `absent: true`. Record the UTC removal time as `<REMOVAL_MS>` | none |
| 3.5 | Create a new Production deployment of the commit currently serving: `vercel redeploy <SERVING_DPL_ID> --target production --scope convergepanel-ai` [UNTESTED IN PRODUCTION]. Wait for READY. Confirm that its `createdAt` is after `<REMOVAL_MS>`, and that both custom domains now serve it (§2.3 steps 2–3) | AUTH-DEPLOY |
| 3.6 | Run §6, post-removal phase, then §7 | AUTH-CONTAIN for any containment |

**What `vercel env rm … production` deletes [SOURCE: `dist/commands/env/index.js`]:**
1. The CLI lists records with `target=production`.
2. It selects the record whose key matches. With several matches it refuses non-interactively.
3. It sends `DELETE /v10/projects/<id>/env/<record id>`, which deletes the **whole record**: every target, branch and custom environment that record covers, not only Production.

That is why 3.2 requires a production-only record. For such a record, whole-record deletion affects Production only.

**Why 3.5 is required [OBSERVED: rehearsal]:**
- **Step B0:** a variable added without a redeploy had no effect.
- **Step G2:** a variable removed without a redeploy left the running build ON.

The flag goes dark only once a deployment created **after** the removal serves the custom domains.

**`vercel redeploy`** rebuilding with the **current** environment is documented Vercel behaviour [INFERRED]; the rehearsal never exercised it.

**Alternative to 3.5.** Merging a reviewed PR to `main` also creates a new Production deployment [INFERRED for a post-removal build]. Use this only if a reviewed change is already approved. Do not create a commit just to trigger a build.

**Do not use `vercel deploy --prod`** for `convergepanel`: it uploads the operator's local working tree instead of a reviewed commit.

**STOP conditions** (go to §9):
- 3.2 is not `PRODUCTION_ONLY_RECORD`;
- 3.4 is not `absent: true`;
- the new deployment does not reach READY;
- the custom domains still point at the old deployment after READY.

### 3.7 Shared, multi-target or unclear records: STOP

If the gate STOPs (several records, a target other than exactly `production`, a branch, custom environments, a `configurationId`, an unexpected type, or an incomplete listing), **do not run `vercel env rm`**. It would delete the whole record across every scope it covers.

1. **Record the gate output.** It lists every affected target, branch flag, custom-environment count and integration flag, and no values.
2. **Escalate for AUTH-ENV-SHARED.** That authorization must list each affected environment and the effect on it.
3. **Safer alternative to propose:** edit the record so that it no longer targets Production, keeping its other targets, in the Vercel dashboard (Project → Settings → Environment Variables → edit the record's environments). Then redeploy (3.5) [INFERRED, UNTESTED; the CLI's `env update` always writes a new value, so it is **not** used].
4. **Integration-managed record** (`configurationId` set): change it only through that integration's owner.
5. **If no environment-specific change can be shown safe:** STOP and use §4 if the situation is an emergency. A rollback changes no environment configuration.

---

## 4. Emergency Instant Rollback

Use this path only when the flag-ON deployment must stop serving the custom domains **immediately**, and the build time in §3 is not acceptable.

**Prerequisites:**
- AUTH-ROLLBACK naming `<DARK_DPL_ID>` exactly;
- §2.3 captured;
- `<DARK_DPL_ID>` and `<ACTIVATION_MS>` from the activation record (§2.4).

**Merge freeze:** from 4.1 until 5.6, **no merge to `main`**. While the record still applies, any new Production build is flag-ON.

| Step | Action | Authorization |
|---|---|---|
| 4.1 | `vercel rollback <DARK_DPL_ID> --scope convergepanel-ai --yes` [OBSERVED in the rehearsal only; UNTESTED IN PRODUCTION] | AUTH-ROLLBACK |
| 4.2 | `vercel rollback status --scope convergepanel-ai`; then confirm both custom domains → `<DARK_DPL_ID>` (§2.3 step 2) | none |
| 4.3 | Re-read `autoAssignCustomDomains` (§2.3 step 1) and record it. The rehearsal showed `false` after a rollback [OBSERVED: step C] | none |
| 4.4 | Run §6 **pre-removal phase** (no `<REMOVAL_MS>` exists yet) | AUTH-CONTAIN for any containment |
| 4.5 | **Continue immediately with §5.** A rollback alone is not a finished recovery | — |

**What the rollback did in the rehearsal [OBSERVED: steps C and E]:**
- The project's production alias served `<DARK_DPL_ID>` with **its own creation-time environment**, so the flag was dark at once.
- The variable was **not** changed.
- `autoAssignCustomDomains` became `false`.

**What a new build did while auto-assignment was off (rehearsal step F):**

| Label | Behaviour |
|---|---|
| [OBSERVED] | The rehearsal project had **no custom domain**. A new deployment created with **`vercel deploy --prod`** reached READY. The project's production alias (`<project>.vercel.app`) **stayed** on the rolled-back deployment |
| [OBSERVED] | That new deployment was **assigned** a generated, team-suffixed alias (`<project>-<team>.vercel.app`), shown in the CLI's deploy output and in the deployment's alias list |
| **Not tested** | Whether that generated alias, or the deployment's own URL, was **anonymously reachable**. The rehearsal requested only `<project>.vercel.app` |
| [INFERRED, not demonstrated] | A deployment created by a **Git merge to `main`** behaves the same way |
| [INFERRED, not demonstrated] | The **custom domains** `convergepanel.com` and `www` stay on the rolled-back deployment the same way |

**The hazards:**
1. After a rollback, a READY deployment is not evidence that the custom domains serve it.
2. Without §5, the next merge to `main` may fail to reach users.
3. While the record still applies, every new build, and any later promote of it, is flag-ON. Such a build is assigned generated addresses whose reachability must be established by §6, never assumed.

---

## 5. Post-rollback recovery

Every step is required after §4. The order matters.

| Step | Action | Authorization |
|---|---|---|
| 5.1 | §3.2 gate; if it passes, §3.3 and §3.4 (record `<REMOVAL_MS>`). If it fails, §3.7 | AUTH-ENV (or AUTH-ENV-SHARED) |
| 5.2 | Create a fresh dark deployment: `vercel redeploy <MAIN_DPL_ID> --target production --scope convergepanel-ai`, where `<MAIN_DPL_ID>` is the most recent READY Production deployment of current `main` [UNTESTED IN PRODUCTION]. While auto-assignment is off, it is expected **not** to take the custom domains [INFERRED from step F] | AUTH-DEPLOY |
| 5.3 | Confirm the new deployment's `createdAt` is **after** `<REMOVAL_MS>` (§2.3 step 3) | none |
| 5.4 | `vercel promote <NEW_DARK_DPL_ID> --scope convergepanel-ai --yes` [OBSERVED: step G, rehearsal] | AUTH-PROMOTE |
| 5.5 | Confirm both custom domains → `<NEW_DARK_DPL_ID>` (§2.3 step 2) | none |
| 5.6 | Confirm `autoAssignCustomDomains` is `true` (§2.3 step 1) [OBSERVED: step G]. The merge freeze ends here | none |
| 5.7 | Run §6 **post-removal phase**, then all of §7 against `<NEW_DARK_DPL_ID>` | AUTH-CONTAIN for any containment |
| 5.8 | At the **next** ordinary merge to `main`, confirm with §2.3 steps 2–3 that its deployment took both custom domains automatically. The rehearsal showed an auto-assigned deploy after a promote, for the project alias only and via `vercel deploy --prod` [OBSERVED: step G2]. For a Git merge and for custom domains this is [INFERRED] until 5.8 is done | none |

**Never promote a flag-ON deployment.** A promote serves that deployment's own creation-time environment [OBSERVED: step G, the promoted deployment served the flag ON]. Only promote a deployment whose `createdAt` is later than `<REMOVAL_MS>`.

**Why not promote `<DARK_DPL_ID>` itself?** That would restore auto-assignment, but Production would stay on an older commit.

**Promoting does not contain anything.** It moves the custom domains only. It does **not** make any flag-ON deployment, or its generated addresses, inaccessible. That is §6.

---

## 6. Generated deployment address exposure and containment

**Hazard.** A build created while the flag record applied to Production may remain reachable through its own deployment URL and generated aliases, even after the custom domains are restored to a dark deployment.

| Label | Basis |
|---|---|
| [OBSERVED] | A non-promoted deployment was assigned a generated alias (rehearsal F) |
| [INFERRED from Vercel's documented model] | Deployments keep their URLs, and rollback and promote move domains, not access |

Because the routes accept a Bearer token (§1.2), any signed-in user could call a reachable flag-ON deployment's API routes.

**Checking the custom domains cannot rule this out.**

### 6.1 Identify flag-ON deployments and their addresses (read-only)

**Pre-removal phase** (from §4.4): the window is `<ACTIVATION_MS>` to now. Omit `until`:

```bash
vapi deployments "/v6/deployments?projectId=<PROJECT_ID>&target=production&limit=100" <ACTIVATION_MS>
```

**Post-removal phase** (from §3.6 or §5.7): the window is `<ACTIVATION_MS>` to `<REMOVAL_MS>`:

```bash
vapi deployments "/v6/deployments?projectId=<PROJECT_ID>&target=production&until=<REMOVAL_MS>&limit=100" <ACTIVATION_MS>
```

How `vapi deployments` reports [HARNESS]:
- It returns the deployments whose `created` is at or after `<ACTIVATION_MS>`.
- It sets `covers_window: true` only when the listing is complete, or when it already reaches a deployment older than `<ACTIVATION_MS>`.
- Otherwise it exits 6. Re-run with `until=<oldest created returned>` until coverage is reached.

The `projectId`, `target` and `until` parameters and the `uid`, `url`, `created` and `state` fields are those the CLI itself uses with this endpoint [SOURCE].

**Which deployments count as flag-ON:**
- every listed deployment;
- any deployment the activation record names;
- in the post-removal phase, any deployment that **started** before `<REMOVAL_MS>`, even if it finished after.

For each flag-ON `<DPL_ID>`, list its aliases. The `aliases[].alias` shape is [OBSERVED: rehearsal step F record]:

```bash
vapi list /v2/deployments/<DPL_ID>/aliases aliases alias
```

The address list is the deployment's `url` plus every alias, excluding the two custom domains.

### 6.2 Determine reachability (read-only, signed-out only)

For every address, run `vprobe <HOST>` (§2.2).

| Probe class on a flag-ON address | Meaning |
|---|---|
| `APP_401` | **EXPOSED.** The application is reachable, and a signed-in user's Bearer token would reach the flag-ON route |
| `VERCEL_REDIRECT` or `NON_APP_401` | Not the application. Containment still requires §6.3 |
| `INCONCLUSIVE` | **UNKNOWN.** Retry once after about two minutes. Never bypass a bot checkpoint |

**Never sign in, mint a token or send a credential to confirm exposure.** Authenticated confirmation is not authorized.

### 6.3 When an address counts as contained

An address is **CONTAINED** only if both hold:
- its `vprobe` class is `VERCEL_REDIRECT` or `NON_APP_401`;
- §2.3 step 6 shows a Deployment Protection setting that covers production deployment URLs.

Per Vercel's documentation [INFERRED; not verified for this project], `ssoProtection.deploymentType` values `all`, `all_except_custom_domains` and `prod_deployment_urls_and_all_previews` cover them. `preview` does not.

An address is **NOT REACHABLE** only if the deployment is confirmed deleted: `vapi fields /v13/deployments/<DPL_ID> id` returns `API error "not_found"`.

Every other combination is **NOT CONTAINED**.

### 6.4 Containment (each action needs its own AUTH-CONTAIN)

Use the least destructive option that contains every exposed or unknown address:

1. **Enable or extend Deployment Protection** so production deployment URLs require Vercel authentication (Vercel dashboard → Project → Settings → Deployment Protection).
   - This is project-wide: it also affects Preview deployments and their testers.
   - The authorization must state that scope.
   - [INFERRED, UNTESTED]
2. **Remove a generated alias:** `vercel alias rm <ALIAS_HOST> --scope convergepanel-ai`.
   - The deployment's own URL stays, so this is never sufficient alone.
3. **Last resort, destructive and irreversible:** `vercel remove <DPL_ID> --safe --scope convergepanel-ai`.
   - `--safe` skips deployments that still hold an active alias [SOURCE: help]. If it skips, STOP.
   - Never routine and never a first step.
   - Never the dark target or any rollback target in the activation record.
   - The authorization must name the exact deployment ID.

After each action, repeat §6.2 and §6.3 for every affected address. **Containment is effective only when every flag-ON address is CONTAINED or NOT REACHABLE.**

If any address remains otherwise, record **GENERATED_ADDRESS_EXPOSURE: NOT CONTAINED / NOT VERIFIED**, with the address, the UTC time and the probe output, and escalate (§9). Do not report the deactivation as complete.

---

## 7. Verification after any path

Record the UTC time of each check and the deployment ID it applies to.

### 7.1 Configuration, routing and access

| Check | How | Expected |
|---|---|---|
| Domains | §2.3 step 2 | both custom domains → the intended deployment |
| Deployment identity | §2.3 step 3 | `readyState` READY, `target` production, expected commit |
| Flag configuration | `vapi env-absent …` (§2.3 step 4) | `absent: true` |
| Flag effective state | the serving deployment's `createdAt` is after `<REMOVAL_MS>`, **or** it is the activation record's dark deployment | dark by configuration |
| Generated addresses | §6 post-removal phase | every flag-ON address CONTAINED or NOT REACHABLE |
| Signed-out access | `vprobe convergepanel.com` | `class: APP_401` (the application's own `401`) [OBSERVED: Order 6 release verification, HTTP 401] |
| Browser monitoring relay | `curl -sS -o /dev/null --connect-timeout 10 --max-time 20 -w '%{http_code}\n' -X POST https://convergepanel.com/monitoring` | `400` (configured) [OBSERVED: Order 6 release verification; SOURCE: `app/monitoring/route.ts`]. `404` means `NEXT_PUBLIC_SENTRY_DSN` did not resolve in the serving build [SOURCE]. A curl error is INCONCLUSIVE |
| Monitoring configuration | §2.3 step 5 | `all_present_for_production: true` |

### 7.2 Errors and 5xx: deployment-scoped, bounded, completeness-checked

**How `vercel logs` works [SOURCE: CLI 54.4.1 `dist/commands-bulk.js`, modules `src/util/logs-v2.ts` and `src/commands/logs/index.ts`]:**
- **Window:** `--since` and `--until` are sent as `startDate` and `endDate`. A relative value is recomputed from the current time on every page request. Without `--since`, the window starts 24 hours back; without `--until`, it ends now.
- **Deployment:** `--deployment <id>` sends `deploymentId`. When a deployment is given, the CLI skips git-branch auto-detection. `--no-branch` disables that detection in every case.
- **Limit:** `--limit` defaults to `100` and caps the rows **returned**. The CLI requests pages until the limit or the API's last page. It does not print whether rows remained.
- **Missing timestamps:** a row without a timestamp is given the current time.
- **`--level`:** repeatable (`type: [String]`). Repeated values are sent comma-joined in one `level` parameter.
- **`--status-code`:** sent as a `statusCode` parameter.
- **Output:** `--json` prints one row per line. Each row includes `timestamp`, `deploymentId`, `level`, `responseStatusCode` and log **message text**.

What the API's `level` and `statusCode` filters select is [INFERRED]. `vlogs` therefore checks every returned row against the requested filter, and any mismatch makes the result INCOMPLETE [HARNESS].

**What `vlogs` does [HARNESS]:**
- **Rejects** a window or filter that is not:
  - absolute UTC `YYYY-MM-DDTHH:MM:SSZ`;
  - start strictly before end;
  - end at least 60 seconds in the past;
  - an integer limit from 1 to 99999;
  - a status of `5xx` or a three-digit code;
  - levels from `error`, `warning`, `info` and `fatal`.
- **Reports INCOMPLETE** when:
  - any row is malformed;
  - any row belongs to another deployment;
  - any row falls outside the window (this also catches substituted timestamps, because the end is in the past);
  - any row does not match the requested filter;
  - the row count reaches the limit;
  - `vercel` exits nonzero.
- **Prints** one JSON line of counts, and never log contents.

```bash
VLOGS=$(cat <<'PY'
import datetime, json, re, sys, time
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
LEVELS = {"error", "warning", "info", "fatal"}
def emit(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=True, sort_keys=True) + "\n")
def ms(s):
    if not ISO.fullmatch(s):
        return None
    try:
        return int(datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    except ValueError:
        return None
def status_ok(code, want):
    if isinstance(code, bool) or not isinstance(code, int):
        return False
    return 500 <= code <= 599 if want == "5xx" else str(code) == want
mode, a = sys.argv[1], sys.argv[2:]
start, end, limit, status = a[1], a[2], a[3], a[4]
levels = [x for x in a[5].split(",") if x]
lo, hi = ms(start), ms(end)
if mode == "window":
    errors = []
    if lo is None or hi is None:
        errors.append("start and end must be absolute UTC YYYY-MM-DDTHH:MM:SSZ")
    elif lo >= hi:
        errors.append("start must be earlier than end")
    elif hi > time.time() * 1000 - 60000:
        errors.append("end must be at least 60 s in the past")
    if not re.fullmatch(r"[1-9][0-9]{0,4}", limit):
        errors.append("limit must be an integer 1-99999")
    if status and not re.fullmatch(r"5xx|[1-5][0-9]{2}", status):
        errors.append("status must be 5xx or a three-digit code")
    if any(l not in LEVELS for l in levels):
        errors.append("level must be error, warning, info or fatal")
    if errors:
        emit({"result": "INVALID_WINDOW", "errors": errors}); sys.exit(8)
    sys.exit(0)
dpl, limit = a[0], int(limit)
rows = malformed = other = outside = mismatch = 0
for line in sys.stdin:
    s = line.strip()
    if not s:
        continue
    try:
        r = json.loads(s)
    except ValueError:
        malformed += 1; continue
    ts = r.get("timestamp") if isinstance(r, dict) else None
    if not isinstance(r, dict) or isinstance(ts, bool) or not isinstance(ts, (int, float)) or not isinstance(r.get("deploymentId"), str):
        malformed += 1; continue
    rows += 1
    other += r["deploymentId"] != dpl
    outside += not (lo <= ts <= hi)
    if status and not status_ok(r.get("responseStatusCode"), status):
        mismatch += 1
    elif levels and r.get("level") not in levels:
        mismatch += 1
complete = malformed == 0 and other == 0 and outside == 0 and mismatch == 0 and rows < limit
emit({"deployment": dpl, "window": [start, end], "limit": limit, "status_filter": status or None, "level_filter": levels or None,
      "rows": rows, "malformed": malformed, "other_deployment": other, "outside_window": outside, "filter_mismatch": mismatch,
      "result": "COMPLETE" if complete else "INCOMPLETE"})
sys.exit(0 if complete else 5)
PY
)
vlogs() {  # vlogs <DPL_ID> <START> <END> <LIMIT> [--status-code S | --level L [--level L ...]]
  local dpl="$1" start="$2" end="$3" limit="$4"; shift 4
  local status="" levels="" expect="" a res codes vc pc
  for a in "$@"; do
    case "$expect" in
      status) status="$a"; expect=""; continue ;;
      level) levels="$levels,$a"; expect=""; continue ;;
    esac
    case "$a" in
      --status-code) [ -z "$status" ] || { echo '{"status":"STOP","reason":"one --status-code only"}' >&2; return 2; }; expect=status ;;
      --level) expect=level ;;
      *) echo '{"status":"STOP","reason":"only --status-code and --level filters are accepted"}' >&2; return 2 ;;
    esac
  done
  [ -z "$expect" ] || { echo '{"status":"STOP","reason":"filter flag without a value"}' >&2; return 2; }
  [ -n "$status" ] && [ -n "$levels" ] && { echo '{"status":"STOP","reason":"use --status-code or --level, not both"}' >&2; return 2; }
  python3 -I -B -c "$VLOGS" window "$dpl" "$start" "$end" "$limit" "$status" "$levels" || return $?
  res=$(vercel logs --project convergepanel --scope convergepanel-ai --deployment "$dpl" --no-branch \
          --environment production --since "$start" --until "$end" --limit "$limit" --json "$@" \
        | python3 -I -B -c "$VLOGS" count "$dpl" "$start" "$end" "$limit" "$status" "$levels"
        printf '\n#rc %s %s' "${PIPESTATUS[0]}" "${PIPESTATUS[1]}")
  codes=${res##*#rc }; res=${res%$'\n'#rc *}; vc=${codes% *}; pc=${codes#* }
  if [ "$vc" != 0 ]; then
    printf '{"result":"INCOMPLETE","reason":"vercel logs exited %s; output withheld"}\n' "$vc"
    return "$vc"
  fi
  printf '%s\n' "$res"
  return "$pc"
}
```

Run all four, with the **same** window and limit:

```bash
vlogs <DPL_ID> <START> <END> 1000                                  # all requests (proves the query returns data)
vlogs <DPL_ID> <START> <END> 1000 --status-code 5xx                # HTTP 5xx responses
vlogs <DPL_ID> <START> <END> 1000 --level error                    # requests with an error-level log entry
vlogs <DPL_ID> <START> <END> 1000 --level fatal                    # requests with a fatal-level log entry
```

- **Window:** `<START>` is when the custom domains switched to `<DPL_ID>`. `<END>` is at least 15 minutes later and at least 60 seconds in the past.
- **Levels:** a single `--level error --level fatal` query is also accepted, and the CLI sends it comma-joined. Separate queries keep each count attributable.
- **Valid only if every run** prints `"result": "COMPLETE"` and returns 0. Record the four JSON lines and the exact commands.
- **INCOMPLETE** for any reason: split the window into smaller absolute windows and re-run, or record it as INCOMPLETE. **Never claim zero errors from an INCOMPLETE run.**
- **Zero total rows** for a window in which traffic was expected is **INCOMPLETE**, not "no errors".

**Bot checkpoint.** Scripted requests to `convergepanel.com` received a Vercel bot-checkpoint `403` during the Order 6 release verification [OBSERVED]. Keep requests to a handful, pause about two minutes and retry once. Never bypass the checkpoint. A checkpoint `403` is INCONCLUSIVE, not an application result.

**Authenticated dark behaviour is not verifiable by this runbook today.** No Production test identity is authorized. The presence or absence of `dsProvenance` on an authorized response cannot be observed signed-out. Record **PRODUCTION_AUTHENTICATED_DARK_STATE: NOT VERIFIED** unless a separately authorized method exists. Dark state in Production is established by configuration and deployment-creation time, not by observation.

**STOP and escalate (§9)** if any check fails or cannot be established.

---

## 8. Evidence and limitations

### 8.1 Rehearsal

Order 6 rollback rehearsal 2 ran on 2026-10-29 in the disposable Vercel project `o6-rollback-rehearsal-em805q` (team `convergepanel-ai`).
- The project was created and deleted by the script.
- It had **no custom domain**.
- New deployments were created with `vercel deploy --prod`.
- The flag probe requested only `https://<project>.vercel.app/api/flag`.
- The ConvergePanel Production alias was recorded before and after the run and was unchanged.

**Evidence archive:** `ConvergePanel-Controlled-Verification-Evidence/order6-rollback-rehearsal-2/`, outside this repository:
- `README.md`
- `tools/rehearse.py`, `tools/verify.py`
- `verify.json`
- `steps/01–14`
- `MANIFEST.sha256` (sha256 of the manifest file: `73433762…`)

**Verifier:** 12/13 PASS on the scripted record. The one failure was a CLI-table parser defect in the cleanup comparison. Deletion was then verified by a post-hoc API read (`steps/14`).

| Step | Observed | Used in |
|---|---|---|
| A | deploy without the variable → dark | §2.4 |
| B0 | add the variable, no redeploy → still dark | §3 |
| B | deploy → ON | — |
| C | `vercel rollback` to A → project alias back on A, dark immediately; `autoAssignCustomDomains=false` | §4 |
| E | after the rollback, the variable is still present; the old build stays dark | §4 |
| F | `vercel deploy --prod` → READY; project alias **stayed** on A; the new deployment was **assigned** the generated alias `<project>-<team>.vercel.app` (its reachability was not tested) | §4, §6 |
| G | `vercel promote` of F → project alias moved to F; auto-assignment `true`; F served its own environment (ON) | §5 |
| G2 | remove the variable (running build stays ON) → `vercel deploy --prod` → dark, auto-assigned to the project alias | §3, §5 |

### 8.2 Limitations

- The rehearsal's flag probe was an **unauthenticated stand-in function**, not ConvergePanel's authenticated provenance response.
- **Not exercised anywhere:**
  - custom-domain behaviour;
  - Git-integration (merge) deployments after a rollback;
  - `vercel redeploy`;
  - Deployment Protection;
  - dashboard record edits;
  - reachability of generated addresses.

  Statements about these are [INFERRED].
- **Missing project ID:** the rehearsal recorded no Production project ID, and the cause is **unexplained**.
- **CLI version:** the rehearsal archive does not record the local CLI version (its build logs show the build container's CLI 65.4.0). [SOURCE] statements refer to Vercel CLI 54.4.1.
- **No Production change has been performed:** no rollback, promote, redeploy, record change, protection change or containment. All Production steps are [UNTESTED IN PRODUCTION].
- **Authenticated Production dark state is NOT VERIFIED.** Authenticated OFF and ON behaviour was verified in the isolated Firebase project `convergepanel-sa-verify-y0ibg9`, with a local production build: 718/718 browser checks and 447/447 API checks. That is not a Production observation.
- Vercel's API and CLI may change. The helpers fail closed on schema changes they detect. They cannot detect a field that silently changes meaning.

### 8.3 Helper test evidence [HARNESS]

The helpers above were extracted verbatim from this document and run in `bash`, with stand-in `vercel` and `curl` functions and no network. The harness and its results are archived outside the repository, in `order6-rollback-runbook-pr272/r2-correction/`.

| Area | Cases |
|---|---|
| Parsing | missing required fields; unexpected schema variants (string `target`, non-object `pagination`, top-level array); empty stdout; text before or after the JSON; two JSON documents; an `error` object; the hint on **stderr** with valid stdout (accepted); the hint on **stdout** (rejected) |
| CLI exit | nonzero CLI exit with valid JSON (output withheld) |
| Output safety | embedded newlines and control characters (one output line); secret-bearing `value` fields in every mode (never output); refused `value`/`decrypted` paths; JSON booleans |
| Env gate | production-only records with `configurationId: null` (pass); multi-target, string-target, `gitBranch`, `configurationId`, custom-environment, `system`/`secret` type, missing `id`, duplicate and absent records (STOP); paginated listings (INCOMPLETE) |
| Deployment window | coverage and pagination |
| Logs | malformed, reversed, future and naive UTC windows; zero and non-integer limits; invalid filters; truncation at the limit; missing timestamps; other-deployment rows; out-of-window rows; filter mismatches; repeated `--level` flags passed through intact; nonzero CLI exit |
| Probes | curl timeout (INCONCLUSIVE); application JSON 401 (`APP_401`); a Vercel redirect; a non-JSON 401; a bot-checkpoint 403 (INCONCLUSIVE); invalid host |

---

## 9. Recovery and escalation matrix

In every row: **STOP**, record the observed state with UTC times, and take only the action listed, under the named authorization. If that authorization is not already held, escalate to the owner and wait.

| Situation | Likely cause | Action | Authorization |
|---|---|---|---|
| Rollback succeeded but a custom domain is not on `<DARK_DPL_ID>` | rollback still pending, or a domain is assigned separately | `vercel rollback status`; re-read both aliases after the `--timeout` (default 3m) [SOURCE: help]. If still wrong, escalate | none to re-read; AUTH-ROLLBACK or AUTH-PROMOTE for any change |
| Record removed but the custom domains still serve a flag-ON build | no new deployment since the removal (§3, "Why 3.5 is required") | §3.5, or §4 in an emergency | AUTH-DEPLOY or AUTH-ROLLBACK |
| §3.2 gate STOPs | shared, multi-target, branch-scoped, integration-managed, unexpected or incompletely listed record | §3.7. Never `vercel env rm` on it | AUTH-ENV-SHARED, or the integration owner |
| New deployment READY but not serving the custom domains | auto-assignment suspended after a rollback (step F) | Check `autoAssignCustomDomains`. If `false`, confirm `createdAt` is after `<REMOVAL_MS>`, then §5.4. Keep the merge freeze | AUTH-PROMOTE |
| `autoAssignCustomDomains` still `false` after §5.4 | promote not completed | Re-read after a few minutes, then escalate. Keep the merge freeze | — |
| A flag-ON address is EXPOSED, NOT CONTAINED or UNKNOWN (§6) | generated URL or alias not covered by protection | §6.4, least destructive option first; re-check §6.2–§6.3 | AUTH-CONTAIN (one per action) |
| `/monitoring` returns `404`, or `all_present_for_production` is false | `NEXT_PUBLIC_SENTRY_DSN` absent when the serving build was created, or a record removed. Builds before `2b97443` use a different relay configuration, not covered by this check | Record it. Do not re-add values from memory or logs. Escalate | separate owner decision |
| Signed-out probe of a custom domain is not `APP_401`, or any authorization result differs from expectation | unexpected build or regression, unless INCONCLUSIVE | If INCONCLUSIVE, retry once. Otherwise STOP all changes and escalate immediately as a security incident. No code fix under this runbook | owner / incident process |
| §7.2 COMPLETE run shows 5xx, error or fatal rows | regression in the serving build | Record the counts and window, then escalate. If the serving build is flag-ON, §4 may be authorized | AUTH-ROLLBACK |
| Any check is `STOP`, `INCOMPLETE`, `INVALID_WINDOW`, INCONCLUSIVE twice, or an API error | tooling, access or schema change | Record it as **NOT VERIFIED** with the helper output. Do not report success | — |
| A promoted or rolled-back deployment turns out to be flag-ON | wrong target chosen | STOP; select a correct target from the activation record (§2.4); escalate | AUTH-ROLLBACK or AUTH-PROMOTE (new) |

---

## 10. Record template

Copy this into the incident or activation record and fill in every line. Leave nothing implied. Paste helper JSON lines verbatim; they contain no values.

```
Operator:            vercel --version:            Authorizations held (code, who, UTC, exact target):
Activation record:   ACTIVATION_MS ______   DARK_DPL_ID ______ (commit ______, createdAt ______)
Pre-state (UTC):     domains -> ______ / ______   commit ______   autoAssign ______
                     env-gate JSON ______   env-present JSON ______   protection ______
Actions (each: UTC, exact command, exit code):
REMOVAL_MS ______    env-absent JSON ______   New dark deployment ______ createdAt ______
Post-state (UTC):    domains -> ______ / ______   commit ______   autoAssign ______
§6 (phase, window, covers_window): flag-ON deployments ______; per address: vprobe JSON + CONTAINED | NOT REACHABLE | NOT CONTAINED
§7.1: vprobe convergepanel.com ______   /monitoring ______
§7.2 four vlogs JSON lines: ______
Authenticated dark state: NOT VERIFIED (reason) | VERIFIED (separately authorized method + evidence)
Next ordinary merge auto-assigned to both custom domains (date, deployment): ______
```
