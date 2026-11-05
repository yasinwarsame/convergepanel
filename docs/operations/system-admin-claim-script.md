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
  [--allow-claim-reduction]           # REQUIRED with revoke; refused with grant
  [--operator-id-token-file=<file>]   # mode 0600; required for --execute (unless bootstrap)
  [--bootstrap-first-admin]           # grant only; only while zero accounts hold admin === true
  [--execute --confirm-claim=<exact string printed by the dry run>]
  [--result-file=<NEW *.json path outside every git checkout>]
```

- **No defaults.** No default project, no default user, no default operation.
- **Revoke always revokes sessions.** Owner policy: removing `admin` ALWAYS
  calls `revokeRefreshTokens` for the target, with no opt-out. The former
  `--revoke-sessions=yes|no` flag was removed and is refused (`unknown_flag`)
  with a message saying so.
- **Credentials:** only the `--credentials` key file. The tool never loads
  `.env.local` and never reads credential environment variables. The file must
  not be a symbolic link (`credentials_file_symlink`), and it is opened once
  (`O_NOFOLLOW`) and checked with `fstat` on that same descriptor, so the file
  checked is the file read. A FIFO, socket or device path is refused from the
  `lstat` WITHOUT being opened (opening a FIFO blocks), and the single open also
  carries `O_NONBLOCK` so a FIFO swapped in after the `lstat` cannot block
  either; the `fstat` then refuses it. It must be a regular file with mode 0600, `type` must be `service_account`,
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
  mandatory session revocation):
  - grant: `grant:admin:true:<project>:<uid>`
  - revoke: `revoke:admin:removed:sessions-revoked:<project>:<uid>`
  The revoke string is the same for a re-run whose claim is already absent
  (see "Retry"), so re-running the exact same command is always accepted. The
  retired `sessions-yes` / `sessions-no` strings are refused
  (`confirmation_mismatch`).
- **Target:** UID only (`[A-Za-z0-9_-]{1,128}`). Refused if missing, if the
  returned record has a different UID, or if `disabled !== false`.
- **Claims:** grant writes `{ ...existing, admin: true }` with `admin` last;
  revoke removes only the `admin` key. Every other claim must be byte-equal
  (canonical JSON) before and after, the payload must be at most 1000 bytes,
  and reserved claim names are refused. Claims carrying an own `__proto__` key
  are refused (`claims_prototype_key`), because copying would drop it. A
  GRANT that would change nothing exits 0 (`no_change`) and writes nothing,
  even with `--execute`. A REVOKE whose claim is already absent is NOT "no
  change": see "Retry".
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
  **Single run, single operator.** The zero-holder count and the claim write
  are separate calls with no lock between them (check-then-act, TOCTOU). Two
  bootstrap runs started at the same time — two operators, or two terminals —
  can both see zero holders and both grant. Exactly one person runs bootstrap,
  once, and confirms the result (the outcome row, then a dry run that shows
  `admin: true`) before anyone runs it again. If two first admins were created,
  revoke the unintended one with the normal operator-token path.
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
pre-create it. A `--result-file` is checked against the filesystem, never
lexically: its parent directory and the repository root are canonicalised with
`realpath.native` (symlinks resolved, on-disk case restored), and the file is
refused (`result_path_inside_repo`) if it lies inside the current worktree or
ANY git worktree of this repository (`git worktree list --porcelain -z`) —
compared case-folded on macOS/Windows and on any volume detected as
case-insensitive, so `/users/.../convergepanel/out.json` cannot slip past. A
second, independent layer compares filesystem identity: the parent directory
and EVERY ancestor up to `/` are `stat`ed and refused
(`result_path_inside_repo`) if any has the `dev:ino` of the repository root or
of any worktree root — so an alternate spelling of a ROOT (or of a path through
a root) that the canonicaliser leaves alone, such as the macOS firmlink
`/System/Volumes/Data/Users/...`, is still recognised as inside. A third layer
needs no enumeration: the parent directory and every ancestor are refused
(`result_path_inside_repo`) if they contain a `.git` entry of any kind
(directory, gitfile, symlink) — this covers a linked worktree moved with `mv`
(git still lists it at its old path), a separate clone, and any other checkout.
A `.git` entry that cannot be inspected is refused (`result_path_invalid`).

Every git command the tool runs (`worktree list`, `rev-parse`, `status`) runs
with ALL inherited `GIT_*` variables removed (so `GIT_DIR`, `GIT_COMMON_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CEILING_DIRECTORIES`,
`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_CONFIG_PARAMETERS` cannot point it at
another repository or index), with system and global git config disabled
(`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<null device>`) and
`GIT_OPTIONAL_LOCKS=0`. The worktree list is parsed strictly from the
NUL-delimited format, so a worktree path containing a newline is read exactly.

**Ambiguous repository state is a refusal** (`result_path_invalid`, exit 2,
nothing written anywhere): `git worktree list` failing, output not in exactly
the documented record format (unknown or repeated attribute, a record not
starting with one absolute `worktree` path, missing terminators), an empty
list, ANY worktree reported `prunable`, a listed worktree whose directory does
not exist or cannot be identified, or a list that does not contain the
repository root itself (git described some other repository). The message
tells the operator to run `git worktree list` and fix the state with
`git worktree repair <new path>` (moved) or `git worktree prune` (deleted). A
locked worktree on unmounted storage is also refused until it is reachable or
removed. A parent directory or repository root that cannot be canonicalised, an
ancestor or protected root whose identity cannot be established, or ANY
existing entry at the target path (file, directory or symlink, live or
dangling), is refused (`result_path_invalid`) as well.

The file is then created with `O_CREAT|O_EXCL|O_NOFOLLOW` and re-verified AFTER
the create: the entry at the path must be the inode the descriptor created, the
parent directory must still have the checked `dev:ino` and canonical path, and
no ancestor of it may now be a protected root or contain a `.git` entry — so a
symlink or directory swap after the check is refused too. On that refusal the
tool unlinks the file only if the entry at the path is, at that moment, its own
inode. The SAME checks run again immediately before the report is written
through the kept descriptor: if the directory was moved in the meantime (for
example into a checkout), nothing is written (`RESULT FILE NOT WRITTEN`, the
run's own exit code is kept; 0 becomes 1) and the empty 0600 file is left
where it now is. The file contains UIDs, claims, the masked credential email
and the request id, never key material or tokens. Do not commit it.

**Audit rows** (`--execute` only), in `admin_audit_logs`, using the existing
admin/billing schema (`adminUid, adminEmail?, targetUid, targetEmail?,
actionType, before, after, createdAt: Timestamp, requestId, metadata`). They
appear on the admin user-details page (query `targetUid` + `createdAt desc`) and
carry no `action` or `at` field, so the governance audit reader ignores them.
Both are created with `.doc(id).create()` (create-only):

1. `system-admin-claim:<requestId>:attempt` — written BEFORE any change. If the
   create call fails, nothing further is issued and the run is INCOMPLETE
   (`audit_attempt_failed`, exit 3): the create may have landed before the
   error, so the row may or may not exist. It is never reported as "nothing
   written".
2. Claim write (skipped on a revoke whose claim is already absent), then — on
   EVERY revoke — `revokeRefreshTokens`, then the `users/{uid}.role` mirror
   (`admin` / `user`; display only; on a sessions-only re-run only if it is
   still outstanding).
3. Read-back of the Auth record and `users/{uid}.role`; for revoke, the
   server's `tokensValidAfterTime` must have advanced.
4. `system-admin-claim:<requestId>:outcome` with the read-back state and
   `metadata.outcome`. A read that fails is never replaced by a snapshot: the
   unread field is `null` (`after.customClaims: null` / `after.usersDocRole:
   null`), `metadata.afterSemantics` is `"unknown"`, `metadata.readBack` says
   which read failed, and the run is INCOMPLETE (exit 3). EVERY failure is
   kept, in order, in `metadata.outcomeDetails` (joined in `outcomeDetail`);
   `metadata.outcome` is the first. The result file carries the same
   (`run.readBack`, `run.failureDetails`, `run.readBackClaims: null`).

**Attempted vs completed.** An attempt row is never a completed privilege
change, and the row type says so, so a row seen on its own (the admin
user-details page lists `actionType`) cannot be misread:

| Row | `actionType` | `metadata.completed` | `after` means |
|---|---|---|---|
| attempt (every run) | `SYSTEM_ADMIN_CLAIM_ATTEMPT` | `false` | the INTENDED state (`afterSemantics: "intended-not-applied"`) |
| outcome `applied` (grant) | `GRANT_SYSTEM_ADMIN_CLAIM` | `true` | read-back |
| outcome `applied` (revoke) | `REVOKE_SYSTEM_ADMIN_CLAIM` | `true` | read-back |
| outcome `claim_already_absent_sessions_revoked` | `REVOKE_SYSTEM_ADMIN_SESSIONS` | `true` | read-back (no claim was written by this run) |
| outcome `mint_failed`, `sessions_revoke_failed`, `users_doc_failed`, `verification_failed` | `SYSTEM_ADMIN_CLAIM_INCOMPLETE` | `false` | read-back (`afterSemantics: "read-back"`) — or, when a read-back failed, `null` for the unread field with `afterSemantics: "unknown"`: the state is UNKNOWN, not empty |

A completed outcome is only ever written with a full read-back; the record
builder downgrades a "completed" outcome without one to `verification_failed`.

Every row also carries `metadata.requestedOperation` (`grant`/`revoke`),
`metadata.claimWrite` (`write` / `skip_already_absent`) and
`metadata.sessionRevocation` (`required` on revoke, `not_applicable` on grant).
An attempt row with no outcome row for the same `requestId` means the run
ended incomplete (or the outcome row itself failed: `audit_outcome_missing`,
which the local result file records); reconcile from the result file.

Firestore rules deny all client access to this collection, but the Admin SDK
bypasses rules: "immutable" here means create-only by convention plus key
custody, not something the rules enforce.

### Exit codes

| Exit | Meaning | Database writes |
|---|---|---|
| `0` | Completed and verified: `applied`, `claim_already_absent_sessions_revoked`, or a grant already in place (`no_change`). | As required by the operation (none for `no_change`). |
| `2` | Refused, or dry run (the default). Also an unexpected error raised before any write call. | **None.** Guaranteed: exit 2 is only returned before the first write call (the attempt audit row included) is issued; the result file records `writeAttempted: false`. |
| `3` | A write call was issued and the operation is INCOMPLETE or unverified: `audit_attempt_failed` (attempt row outcome unknown), `mint_failed`, `sessions_revoke_failed`, `users_doc_failed`, `verification_failed`, `audit_outcome_missing`, or an unexpected error after a write call. | Unknown / partial. Inspect the read-back in the result file. **Re-running the same command is safe.** |
| `1` | The result file could not be written after an otherwise exit-0 run. | As for exit 0. |

A dry run exits 2, not 0: it completed nothing. Scripts that wrap the tool
must treat only `0` as "done".

### Retry

Re-running the exact same command (same flags, same `--confirm-claim`) after
any exit 3 is safe:

- It never re-applies a claim already in place and never changes any other
  claim (grant re-run => `no_change`; a grant whose `users/{uid}.role` mirror
  failed is reported in the `no_change` message and is not repaired).
- A revoke whose `admin` claim is already absent — e.g. the previous run ended
  `sessions_revoke_failed` — does NOT report "no change". Under the same typed
  confirmation it writes the attempt row, does NOT call the claim write,
  performs the outstanding (idempotent) `revokeRefreshTokens`, writes the
  `users/{uid}.role` mirror only if it is still not `user`, verifies that
  `tokensValidAfterTime` advanced, and writes an outcome row
  `claim_already_absent_sessions_revoked` (`REVOKE_SYSTEM_ADMIN_SESSIONS`),
  exit 0. If the revocation fails again it is `sessions_revoke_failed`, exit 3,
  and the instruction is the same: re-run.
- An exit 3 whose read-back failed (`afterSemantics: "unknown"`) says nothing
  about the target's claims: read them (`scripts/check-admin-claims.js`) or
  re-run, never assume they were wiped or kept.
- Note: this also means a revoke aimed at a user who never had `admin` signs
  that user out everywhere. The dry run prints `Claim write: SKIPPED` and the
  sessions line, so read it before executing.

## Revocation and sessions (owner policy: always revoke)

Every revoke calls `revokeRefreshTokens(targetUid)` and verifies, from server
timestamps only, that the Auth record's `tokensValidAfterTime` read back after
the write is strictly later than the value read before it (the operator's
local clock is never used; one-second resolution, so a second revocation
within the same second fails closed as `verification_failed`).

What that does and does not invalidate in this codebase (code at the time of
writing; this tool does not change any route):

| Credential | Verified by | Effect of the revoke |
|---|---|---|
| Firebase refresh tokens | Firebase Auth | Revoked. The client cannot mint new ID tokens; it is signed out on its next refresh. |
| `__session` cookie (5-day Firebase session cookie, `app/api/auth/session/route.ts:37`, `:76`) | `verifySessionCookie(cookie, true)` — revocation CHECKED — at `lib/firebase/auth-helpers.ts:127` (`verifySessionCookieValue`, used by `resolveRequestIdentity` / `resolveServerComponentIdentity` / `/api/auth/session`), `lib/firebase/auth-helpers.ts:277` (`requireAdminPortalAccess` cookie fallback) and `app/api/admin/access/route.ts:41` | Rejected immediately: a cookie minted before the revocation fails the revocation check. There is no `verifySessionCookie(..., false)` call in `lib/` or `app/`. |
| App-side session store | — | None exists: no `sessions` / `admin_sessions` collection grants access (searched `lib/`, `app/`, `middleware.ts`). `middleware.ts:26` only checks that a `__session` cookie is present for `/admin/*` routing; it grants no API access. Nothing else to invalidate. |
| Already-issued ID tokens (bearer, up to about 1 hour) | `verifyIdToken(token)` WITHOUT `checkRevoked` at `lib/firebase/auth-helpers.ts:56` (`verifyAdminToken` -> `requireSystemAdminAccess`), `lib/firebase/auth-helpers.ts:273` (`requireAdminPortalAccess`), `lib/firebase/adminAuth.ts:43` (`getRequestUser` -> `requireSystemAdminBearer`), `app/api/admin/access/route.ts:37`, `lib/firebase/auth.ts:30` (`checkRevoked: false`) | **NOT invalidated.** An ID token minted while the user held `admin: true` keeps `admin: true` until it expires, and these paths do not check revocation. |

**The remaining risk is already-issued ID tokens.** Global sign-out
(`revokeRefreshTokens`) alone is NOT sufficient to cut SYSTEM_ADMIN access off
immediately. Until it expires (up to about an hour), a revoked admin's
existing ID token still passes every bearer path listed above. Closing that
window is a route change, outside this tool: privileged endpoints must enforce
current state on each request — `verifyIdToken(token, true)` (revocation
checked) and/or a live `getUser(uid)` read of `customClaims.admin` — rather
than trusting the claim inside a token. (These route gaps are tracked
separately; see admin-authority-tiers.md, "What this procedure does NOT give
you".) If immediate cut-off matters, FIRST finish the revoke with this tool (exit 0 —
it refuses a target whose `disabled !== false`, so disabling first would block
the revoke and leave the claim in place), THEN disable the account
(`disabled: true`) out of band: Firebase rejects ID tokens of a disabled user
only when revocation is checked, so even that does not close the
no-`checkRevoked` paths — treat the up-to-1-hour window as real.

Side effect of the policy: the target is signed out everywhere, including
ordinary (non-admin) use.

## Known limits (not compare-and-set)

- **No compare-and-set on claims.** Firebase Auth has no conditional
  `setCustomUserClaims`. The tool reads the claims, computes the new object
  (only `admin` changes) and writes the whole object; a concurrent writer of
  ANOTHER claim between that read and the write is overwritten. The read-back
  detects a difference from the planned state (`verification_failed`, exit 3)
  but cannot prevent it. Do not run this tool while anything else (Stripe
  webhooks writing `plan`, another operator) may be writing the same user's
  claims.
- **Last-admin check is check-then-act.** The "would leave zero enabled
  admins" and bootstrap "zero admins exist" checks enumerate users and then
  write; two operators revoking two different admins at the same moment could
  each see the other as the remaining admin. One operator at a time; confirm
  the remaining admins afterwards with the read-only check script.

- **Result-file location residuals.** (a) A checkout with NO `.git` entry
  anywhere above it (a work tree driven by an external `GIT_DIR` /
  `core.worktree`) and not listed by `git worktree list` is not recognised.
  (b) Identity comparison protects the worktree ROOTS: an alias of a
  SUBDIRECTORY of a worktree (a Linux bind mount or macOS nullfs mount of
  `<repo>/scripts` placed elsewhere, or a hard-linked directory on HFS+) walks
  up through the alias's own parents, never meets a root or a `.git`, and is
  accepted. (c) Node has no `openat`/`unlinkat`/`F_GETPATH`, so every re-check
  runs by path: an adversary with write access to the result directory's
  ancestors who moves the directory after the create can leave an empty 0600
  file behind in the moved directory; and a move landing in the window between
  the pre-write re-check and the `write` call itself puts the report there. (d)
  A `.git` entry in an unrelated ancestor (e.g. a dotfiles repository at
  `$HOME/.git`) makes every path under it refused — use a directory outside it.
  Do not point `--result-file` into any checkout; use the default result
  directory (owned by you, mode 0700, under the OS temp directory) to avoid all
  of these.

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
