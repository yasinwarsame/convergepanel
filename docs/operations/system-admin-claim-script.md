# SYSTEM_ADMIN claim operator tool

`scripts/admin/set-system-admin-claim.ts` is the only supported out-of-band way
to grant or revoke the Firebase `admin` custom claim (SYSTEM_ADMIN, see
`docs/operations/admin-authority-tiers.md`). It replaces four retired scripts
(`scripts/setAdmin.ts`, `scripts/set-admin-claim.js`,
`scripts/set-admin-simple.js`, `scripts/set-admin-by-uid.js`), which had no
project confirmation, no dry run, no audit record, hard-coded targets, and two
claim defects (see "Defects fixed" below).

Logic lives in `lib/admin/systemAdminClaimSafety.ts` (pure guards) and
`lib/admin/systemAdminClaimExecution.ts` (write ordering over injected ports).
Both are unit-tested with fakes; the tests never touch a real project.

## What the checks are, and what they are not

**Custody of the service-account key is the real boundary.** Anyone holding a
key for the project can call the Admin SDK from a script of their own and
bypass every check in this tool. The checks below are procedural and
attribution controls: they stop honest mistakes (wrong project, wrong user,
disabled user, claim wipe, accidental write) and make every honest write
attributable. They do not stop a key-holder who chooses not to use this tool.
Control the key: who in IAM can create or download service-account keys, where
the key file is stored, and when it is deleted.

## CLI

```
npm run admin:set-system-admin-claim -- \
  --confirm-project=<projectId> \
  --credentials=<service-account key file, mode 0600> \
  --target-uid=<uid> \
  --operation=grant|revoke \
  [--revoke-sessions=yes|no]          # REQUIRED with revoke; refused with grant
  [--allow-claim-reduction]           # REQUIRED with revoke; refused with grant
  [--operator-id-token-file=<file>]   # mode 0600; required for --execute (unless bootstrap)
  [--bootstrap-first-admin]           # grant only; only while zero accounts hold admin === true
  [--execute --confirm-claim=<exact string printed by the dry run>]
  [--result-file=<absolute *.json path outside the repo>]
```

- **No defaults.** No default project, no default user, no default operation.
- **Credentials:** only the `--credentials` key file. The tool never loads
  `.env.local` and never reads credential environment variables. The file must
  not be a symbolic link (`credentials_file_symlink`), and it is opened once
  (`O_NOFOLLOW`) and checked with `fstat` on that same descriptor, so the file
  checked is the file read. It must be a regular file with mode 0600, `type` must be `service_account`,
  `client_email` and `private_key` must be present, and `project_id` must equal
  `--confirm-project`. The tool initialises its own named Firebase app from it
  and checks that app's project id again.
- **Runtime:** refuses when `VERCEL`, `VERCEL_ENV` or `NEXT_RUNTIME` is set, when
  `NODE_ENV=production`, or when an Auth/Firestore emulator host variable is set.
- **Strict argv:** unknown flags, repeated flags, positional arguments, empty
  values and values on boolean flags are refused.
- **Dry run by default.** Without `--execute` the tool resolves the target,
  prints the current claims, the intended claims, the per-key diff and the exact
  confirmation string, and writes nothing to Firebase.
- **Typed confirmation** binds operation, project and UID (and, for revoke, the
  session decision):
  - grant: `grant:admin:true:<project>:<uid>`
  - revoke: `revoke:admin:removed:sessions-<yes|no>:<project>:<uid>`
- **Target:** UID only (`[A-Za-z0-9_-]{1,128}`). Refused if missing, if the
  returned record has a different UID, or if `disabled !== false`.
- **Claims:** grant writes `{ ...existing, admin: true }` with `admin` last;
  revoke removes only the `admin` key. Every other claim must be byte-equal
  (canonical JSON) before and after, the payload must be at most 1000 bytes,
  and reserved claim names are refused. Claims carrying an own `__proto__` key
  are refused (`claims_prototype_key`), because copying would drop it. If nothing would change, the tool exits
  0 and writes nothing, even with `--execute`.
- **Commit state:** `--execute` refuses when `scripts/admin` or `lib/admin` has
  uncommitted changes, or the commit cannot be determined. The commit SHA is
  recorded in the audit rows.

## Operator authorization

- `--operator-id-token-file`: a file (mode 0600) holding a Firebase ID token
  from the operator's own signed-in session in the same project. The tool calls
  `verifyIdToken(token, true)` (revocation checked), then requires the token
  AND the operator's live Auth record to carry `admin === true`, and the live
  record to have `disabled === false`. `ADMIN_EMAILS` membership does not
  qualify. The token is never printed or stored; the audit row stores the
  operator UID and email (as the existing admin audit rows do), and the local
  result file stores only a masked email.
- `--bootstrap-first-admin`: for a project with no SYSTEM_ADMIN. Refused unless
  zero accounts (enabled or disabled) hold `admin === true`. Authenticates no
  human; the audit row records `adminUid: "operator-bootstrap"`.
- Revoke also refuses self-revoke (operator UID equals target) and a revoke that
  would leave zero enabled admin holders.

What cannot be verified: that the person at the keyboard owns the token (a
copied token works until it expires, about an hour), or that the tool's source
was not edited (the clean-tree check and the recorded commit SHA make an edit
visible, not impossible).

## Evidence

**Local result file.** Written for every run that gets past argument parsing:
created exclusively (`O_CREAT|O_EXCL`, mode 0600) before any Firebase call, then
filled through the SAME file descriptor (never reopened by path, so a later
path swap cannot redirect it). Default directory:
`<os.tmpdir()>/convergepanel-operator/`; it must be a real directory (not a
symlink), owned by the current user, mode exactly 0700, or the run is refused
(`result_dir_unsafe`) — on a shared host another account could otherwise
pre-create it. A `--result-file` inside the git worktree is refused. It contains
UIDs, claims, the masked credential email and the request id, never key
material or tokens. Do not commit it.

**Audit rows** (`--execute` only), in `admin_audit_logs`, using the existing
admin/billing schema (`adminUid, adminEmail?, targetUid, targetEmail?,
actionType, before, after, createdAt: Timestamp, requestId, metadata`). They
appear on the admin user-details page (query `targetUid` + `createdAt desc`) and
carry no `action` or `at` field, so the governance audit reader ignores them.
Both are created with `.doc(id).create()` (create-only):

1. `system-admin-claim:<requestId>:attempt` — written BEFORE the claim. If it
   cannot be created, the tool refuses (`audit_unavailable`) and writes nothing.
2. Claim write, then (revoke with `--revoke-sessions=yes`) `revokeRefreshTokens`,
   then the `users/{uid}.role` mirror (`admin` / `user`; display only).
3. Read-back of the Auth record and `users/{uid}.role`.
4. `system-admin-claim:<requestId>:outcome` with the read-back state and
   `metadata.outcome` (`applied`, `mint_failed`, `sessions_revoke_failed`,
   `users_doc_failed`, `verification_failed`).

Firestore rules deny all client access to this collection, but the Admin SDK
bypasses rules: "immutable" here means create-only by convention plus key
custody, not something the rules enforce.

Exit codes: `0` dry run, no change, or applied and verified; `2` refused, or an
unexpected error before any Firebase write was issued (the result file records
`writeAttempted: false`); `3` a write was attempted and not fully verified, or
an unexpected error after a write was attempted (inspect the read-back; do not
assume either state); `1` the result file could not be written after a clean
run.

## Revocation and sessions: OPEN OWNER DECISION

`--operation=revoke` requires `--revoke-sessions=yes|no` with no default,
because the session policy has not been decided. What each choice does in this
codebase today:

| | `--revoke-sessions=no` | `--revoke-sessions=yes` |
|---|---|---|
| SYSTEM_ADMIN routes (bearer ID token, `verifyIdToken` WITHOUT `checkRevoked`) | Already-issued ID tokens keep `admin: true` until they expire (up to about 1 hour). The next token refresh drops the claim. | Same up-to-1-hour window for already-issued ID tokens (no revocation check on this path). Refresh then fails, so the user is signed out. |
| ADMIN_PORTAL routes that accept the `__session` cookie (`verifySessionCookie(cookie, true)`) | A session cookie minted while the user was admin carries `admin: true` for its whole life (5 days, `app/api/auth/session/route.ts`) and keeps ADMIN_PORTAL access. | Cookies issued before the revocation fail the revocation check immediately. |
| Side effects | None beyond the claim. | Signs the user out on every device, including ordinary (non-admin) use. |

So `no` leaves up to 5 days of ADMIN_PORTAL access on an existing cookie, and
`yes` closes that but forces a full sign-out. Neither choice shortens the
up-to-1-hour SYSTEM_ADMIN bearer window; only adding `checkRevoked` to the
SYSTEM_ADMIN verification path would (see admin-authority-tiers.md, "What this
procedure does NOT give you"). With `yes`, the tool verifies that the Auth
record's `tokensValidAfterTime` read back after the write is strictly later than
the value read from the same record before the write. Only server timestamps
are compared; the operator's local clock is never used. (One-second
resolution: a second revocation within the same second fails closed as
`verification_failed`.)

## Defects fixed (from the retired scripts)

- **Merge order:** `{ admin: true, ...existingClaims }` let an existing
  `admin: false` win, and the script still printed success. Now the intended
  key is applied last and the result is read back.
- **Claim wipe:** `setCustomUserClaims(uid, { admin: true })` replaced every
  other claim. Now other claims are preserved and checked byte-equal.
- Hard-coded email and UID targets, a `convergepanel` default project,
  `.env.local` credentials, no disabled check, no audit. The retired
  `role: "admin"` custom claim and `users/{uid}.isAdmin` field (read by nothing)
  are not carried forward.
- `scripts/check-admin-claims.js` and `scripts/verify-admin-claims.js` are still
  read-only but now require `--confirm-project`, `--credentials` and `--uid`
  (no hard-coded UID, no `.env.local`). They use the same single-open,
  no-symlink key-file read, and an unexpected failure prints a generic line
  (no message or stack) and exits 1.

## Later: adopting the PR #294 operator grant

`loadOperatorCredential` in the script is the single place that turns operator
input into a credential, and the evidence type carries a `source`
discriminant (`explicit-key-file` today). When the operator production grant
merges, that function is replaced by the grant (imported first, as the other
operator scripts do), the script is added to the grant's reviewed-operation
list and its spec, and the rest — argv, plan, confirmation, write ordering and
audit schema — stays as is.

## Rehearsal

Never rehearse against Production and never write test rows into Production
`admin_audit_logs`. Rehearse only against an isolated non-Production project
with its own key. The first Production use is the real, authorized change, and
its two audit rows plus the local result file are the evidence.
