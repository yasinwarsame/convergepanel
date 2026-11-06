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
granting to a disabled user, claim wipe, accidental write) and make every honest write
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
- **Every revoke requests session revocation.** Owner policy: an executed
  revoke that gets past the attempt audit row calls `revokeRefreshTokens` for
  the target, with no opt-out. That call is a REQUEST: it can fail or throw
  (`sessions_revoke_failed`, exit 3; a thrown call is an unknown outcome, not
  a confirmed no-op), and even an acknowledged call has the limited effect
  described under "Revocation and sessions". The call OVERWRITES the stored
  `validSince` with the operator's clock, so it is not monotonic: see
  "Backward cutoff moves". The former
  `--revoke-sessions=yes|no` flag was removed and is refused (`unknown_flag`)
  with a message saying that every executed revoke requests revocation.
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
  with that explicit `projectId` (no ambient project discovery). **The project
  binding is by construction, not by a network check:** the tool makes no call
  to Google that confirms which project the key reaches. (The script also
  compares the initialised app's `projectId` with `--confirm-project`; with the
  real factory that is a local consistency assertion that cannot fail on its
  own — the key's `project_id` already determined both values.)
- **Runtime:** refuses when `VERCEL`, `VERCEL_ENV` or `NEXT_RUNTIME` is set, when
  `NODE_ENV=production`, or when an Auth/Firestore emulator host variable is set.
- **Strict argv:** unknown flags, repeated flags, positional arguments, empty
  values and values on boolean flags are refused.
- **Dry run by default.** Without `--execute` the tool resolves the target,
  prints the current claims, the intended claims, the per-key diff and the exact
  confirmation string, and writes nothing to Firebase. On a revoke it also
  prints the `Sessions:` line, which describes the REQUEST and its limits, not
  an effect: `revokeRefreshTokens` will be requested, the request can fail, it
  overwrites `validSince` with this machine's clock (sync it first), and it
  does not end already-issued ID tokens and is not a sign-out from every
  device.
- **Typed confirmation** binds operation, project and UID (and, for revoke, the
  mandatory session-revocation request):
  - grant: `grant:admin:true:<project>:<uid>`
  - revoke: `revoke:admin:removed:sessions-revoked:<project>:<uid>`
  The `sessions-revoked` part names the mandatory request; it does not assert
  any effect on sessions. The revoke string is the same for a re-run whose
  claim is already absent (see "Retry"), so re-running the exact same command
  is always accepted. The retired `sessions-yes` / `sessions-no` strings are
  refused (`confirmation_mismatch`).
- **Target:** UID only (`[A-Za-z0-9_-]{1,128}`). Refused if missing or if the
  returned record has a different UID. **Grant** is refused when
  `disabled !== false` (a disabled account is never granted admin). **Revoke**
  is privilege removal and is ALLOWED on a disabled account (owner decision
  2026-11-06): the tool removes the claim and calls `revokeRefreshTokens`
  (with the outcomes and limits described under "Revocation and sessions"),
  and the account stays disabled — the tool has no call that can change
  `disabled` in either direction. A revoke still refuses a record whose
  `disabled` is not a boolean
  (malformed; `target_disabled`).
- **Claims:** grant writes `{ ...existing, admin: true }` with `admin` last;
  revoke removes only the `admin` key. Every other claim must be byte-equal
  (canonical JSON) before and after, the payload must be at most 1000 bytes,
  and reserved claim names are refused. Claims carrying an own `__proto__` key
  are refused (`claims_prototype_key`), because copying would drop it. A
  GRANT that would change nothing exits 0 (`no_change`) and writes nothing,
  with or without `--execute`. A REVOKE whose claim is already absent is NOT "no
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

**Local result file.** Written for every run whose result-file location passes
the checks below (a refusal before that point — runtime, argv, result
directory/location, or the exclusive create itself — is printed to stderr
only, exit 2, with nothing written anywhere). It is
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
where it now is. The file contains UIDs, claims, the MASKED target, operator
and credential emails (`run.targetEmailMasked`, never the full target email),
the session-revocation evidence and the request id, never key material or
tokens. Do not commit it. (The audit rows in Firestore carry the full operator
and target emails, as the existing admin audit rows do.)

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
2. Claim write (skipped on a revoke whose claim is already absent), then the
   `users/{uid}.role` mirror (`admin` / `user`; display only). On revoke the
   role write is ALSO the server-time anchor (see "What a revoke reports"),
   so it is written on every revoke, re-runs included. Then — on EVERY
   revoke — a short wait (only when an anchor was taken; about 3.5–4.5 s)
   and the `revokeRefreshTokens` request.
   A failed claim write skips the role write. On a GRANT it also means no
   revocation (a grant never revokes). On a REVOKE the revocation is STILL
   requested, without the wait: `setCustomUserClaims` may have applied
   server-side before it threw. That request is not guaranteed to narrow
   access: without the wait it stamps `validSince` from the operator's
   clock immediately, and from a slow clock it can LOWER a value an earlier
   revoke stored, so that the revocation check stops rejecting sessions the
   earlier revoke had excluded (see "Backward cutoff moves"; recorded, not
   prevented). The run
   stays INCOMPLETE (`mint_failed`, exit 3) because the claim write is
   unconfirmed and no anchor was taken; the result and the outcome row record
   `sessionRevocationEvidence.claimWrite: "unconfirmed"` and whether the
   revocation call was acknowledged, plus a `sessions_revoke_unverified`
   detail when it was acknowledged or a `sessions_revoke_failed` detail when
   it failed. A failed role write does NOT skip the revocation either, and that
   run is INCOMPLETE too.
3. Read-back of the Auth record and `users/{uid}.role`; for revoke, the
   server's `tokensValidAfterTime` is compared with the server-anchored
   cutoff (an observation under a clock assumption, not proof — see below).
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
| outcome `mint_failed`, `sessions_revoke_failed`, `sessions_revoke_unverified`, `users_doc_failed`, `verification_failed` | `SYSTEM_ADMIN_CLAIM_INCOMPLETE` | `false` | read-back (`afterSemantics: "read-back"`) — or, when a read-back failed, `null` for the unread field with `afterSemantics: "unknown"`: the state is UNKNOWN, not empty |

The names `claim_already_absent_sessions_revoked` and
`REVOKE_SYSTEM_ADMIN_SESSIONS` are fixed identifiers. On a completed run they
mean (a) and (b) below: the revocation request was acknowledged and the cutoff
was observed. They do not mean that every session of the target is invalid.

A completed outcome is only ever written with a full read-back; the record
builder downgrades a "completed" outcome without one to `verification_failed`,
and a "completed" REVOKE outcome whose revocation call was not acknowledged or
whose cutoff was not observed to `sessions_revoke_unverified`. Every revoke
outcome row carries `metadata.sessionRevocationEvidence`; the result file
carries the same as `run.sessionRevocationEvidence`. Its fields keep five
things apart:

| Field | Meaning |
|---|---|
| `claimWrite` | `confirmed`, `unconfirmed` (the claim write threw; it may have applied), or `skipped_already_absent` |
| `revocationApiAcknowledged` | (a) `revokeRefreshTokens` returned without error. An acknowledgment from the API, nothing more. |
| `anchorServerTime`, `marginSeconds`, `cutoff`, `tokensValidAfterTimeBefore` / `After`, `validSinceMinusAnchorSeconds`, `cutoffObserved` | (b) the observed cutoff: whether the read-back `tokensValidAfterTime` is at or after the server-anchored cutoff |
| `tokensValidAfterTimeMovedBackward` | (f) `true` when the read-back value is earlier (whole seconds) than the value read before the run — this run's call LOWERED the stored `validSince`; `false` when it did not; `null` when either value was missing or unparseable (direction UNKNOWN, never assumed forward). See "Backward cutoff moves". |
| `clockAlignmentAssumption` | (c) the cross-service clock ASSUMPTION the comparison rests on (fixed text) |
| `currentPrivilegeEnforcement` | (d) what the revocation does NOT do for current admin privileges (fixed text) |
| `detail` | (e) why the cutoff was not observed / the run is incomplete; `null` when observed |

(This field was named `verified` before this change; it was renamed
`cutoffObserved` because it records an observation, not a verification of
revocation. No outcome code or exit code changed. `tokensValidAfterTimeMovedBackward`
was added later; it is reporting only and changes no call the tool makes.)

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
| `0` | Completed: `applied`, `claim_already_absent_sessions_revoked`, or a grant already in place (`no_change`). The claims read back as planned; on revoke, the revocation call was acknowledged and the cutoff was observed — under the clock assumption below, not proof of revocation, and without cutting off already-issued ID tokens. | As required by the operation (none for `no_change`). |
| `2` | Refused, or dry run (the default). Also an unexpected error raised before any write call. | **None.** Guaranteed: exit 2 is only returned before the first write call (the attempt audit row included) is issued; the result file records `writeAttempted: false`. |
| `3` | A write call was issued and the operation is INCOMPLETE: `audit_attempt_failed` (attempt row outcome unknown), `mint_failed`, `sessions_revoke_failed`, `sessions_revoke_unverified`, `users_doc_failed`, `verification_failed`, `audit_outcome_missing`, or an unexpected error after a write call. | Unknown / partial. Inspect the read-back in the result file. On a revoke, a failed or thrown revocation call is an UNKNOWN outcome, not a confirmed no-op. Re-running the same command is how an incomplete run is finished; it never re-applies a claim or changes another claim, but a revoke re-run calls `revokeRefreshTokens` again — sync the clock first (see "Retry" and "Backward cutoff moves"). |
| `1` | The result file could not be written after an otherwise exit-0 run. | As for exit 0. |

A dry run exits 2, not 0: it completed nothing. The one exit-0 run without
`--execute` is a GRANT whose claim is already in place (`no_change`): there
is nothing to do, so it reports done with or without `--execute` and writes
nothing. Scripts that wrap the tool must treat only `0` as "done".

### Retry

Re-running the exact same command (same flags, same `--confirm-claim`) after
any exit 3 is how an incomplete run is finished. What a re-run does and does
not do:

- It never re-applies a claim already in place and never changes any other
  claim (grant re-run => `no_change`; a grant whose `users/{uid}.role` mirror
  failed is reported in the `no_change` message and is not repaired).
- A revoke whose `admin` claim is already absent — e.g. the previous run ended
  `sessions_revoke_failed` — does NOT report "no change". Under the same typed
  confirmation it writes the attempt row, does NOT call the claim write,
  writes the `users/{uid}.role` mirror (the server-time anchor; the same value
  `user` again), calls `revokeRefreshTokens` again — which OVERWRITES
  `validSince` with the operator's clock, so from a slow clock it can move the
  cutoff BACKWARD (see "Backward cutoff moves"; sync the clock before every
  re-run) — compares
  `tokensValidAfterTime` with a fresh server-anchored cutoff, and — only when
  the call was acknowledged and the cutoff observed — writes an outcome row
  `claim_already_absent_sessions_revoked` (`REVOKE_SYSTEM_ADMIN_SESSIONS`),
  exit 0. If the revocation call fails or throws again it is
  `sessions_revoke_failed`, exit 3 (outcome unknown), and the instruction is
  the same: re-run.
- `sessions_revoke_unverified` with "earlier than the server-anchored cutoff"
  means the operator's clock is behind server time. Re-running with the same
  clock fails the same way (it never reports success) — and each such re-run
  re-stamps `validSince` from that slow clock, which can LOWER the value an
  earlier run stored. Sync the clock (NTP) first, then re-run.
- A failure detail or WARNING "tokensValidAfterTime moved BACKWARD during this
  run" means this run's call lowered the stored value: see "Backward cutoff
  moves" for what that re-admits and what to do.
- `mint_failed` on a revoke: the claim write threw, so whether `admin` was
  removed is unknown. The tool still ATTEMPTED `revokeRefreshTokens`; that
  call can itself fail. Read `sessionRevocationEvidence`:
  `revocationApiAcknowledged: true` means only that Firebase acknowledged the
  call; `false` means it failed too (also recorded as a
  `sessions_revoke_failed` detail). In both cases no server-time anchor was
  taken, so no cutoff was observed (`cutoffObserved: false`), and the run is
  INCOMPLETE (exit 3) — an acknowledgment is not evidence that any earlier
  session is invalid. Re-run the same command: if the removal had
  landed, the re-run is a sessions-only run (no claim write); if not, it
  writes the claim again.
- A fast operator clock — see "Fast operator clock: recovery" below.
- An exit 3 whose read-back failed (`afterSemantics: "unknown"`) says nothing
  about the target's claims: read them (`scripts/check-admin-claims.js`) or
  re-run, never assume they were wiped or kept.
- Note: this also means a revoke aimed at a user who never had `admin` still
  requests revocation of that user's refresh tokens. Where Firebase applies it
  (see "Revocation and sessions"), it ends ordinary (non-admin) sessions too,
  within the same limits as any revoke. The dry run prints
  `Claim write: SKIPPED` and the sessions line, so read it before executing.
  The sessions line states the request and its limits, not an observed
  effect (see "Dry run by default" above).

## Revocation and sessions (owner policy: every revoke requests revocation)

Every executed revoke that gets past the attempt audit row calls
`revokeRefreshTokens(targetUid)`: revocation is REQUESTED. The call can fail
or throw (`sessions_revoke_failed`, exit 3); a thrown call is an UNKNOWN
outcome — Firebase may or may not have updated `validSince` — not a confirmed
no-op. What the tool can say afterwards is limited, and it says it in five
separate parts — in the success message, the result file and the outcome
audit row:

- **(a) API acknowledgment.** `revokeRefreshTokens` returned without error.
  That is all it means.
- **(b) Observed cutoff.** The read-back `tokensValidAfterTime` is at or after
  a cutoff anchored on a Firestore server commit time taken after the claim
  write returned. Below the cutoff, or no anchor, or no read-back: INCOMPLETE
  (`sessions_revoke_unverified`, exit 3) — never success.
- **(c) Clock-alignment ASSUMPTION.** The anchor is Firestore's clock;
  `tokensValidAfterTime` is judged by Firebase Auth. Google publishes no bound
  on the skew between those services. The 2 s margin is an assumption, not a
  measured or documented bound, and the skew is unbounded as far as this tool
  can know. So (b) is an observation under an assumption. **It is not proof
  that sessions were revoked**, and the tool never reports it as such. The
  success message reads: "revocation acknowledged; cutoff observed at/after
  server-anchored cutoff (assumes Firestore/Auth clock skew < 2 s, unbounded)".
- **(d) Enforcement of current admin privileges: not provided.** Today the
  SYSTEM_ADMIN bearer guards call `verifyIdToken` WITHOUT `checkRevoked`
  (`lib/firebase/auth-helpers.ts:56` `verifyAdminToken`, `:321`
  `checkIsAdminFromToken`, `lib/firebase/adminAuth.ts:43` `getRequestUser`,
  `app/api/admin/access/route.ts:37`). An already-issued ID token therefore
  keeps `admin: true` for up to about an hour regardless of any revocation.
  Session-cookie paths DO check revocation
  (`verifySessionCookie(raw, true)` at `lib/firebase/auth-helpers.ts:127`,
  `:277`, and `app/api/admin/access/route.ts:41`). Enforcing current
  privileges on each request is S2 (live admin authorization in route
  guards), a separate future change; this tool does not do it.
- **(e) Incomplete outcomes.** Anything short of (a)+(b) is exit 3 with the
  reason in `sessionRevocationEvidence.detail` and `failureDetails`. Re-run
  the same command (see "Retry").

### What a revoke reports (and why not "the value advanced")

**The SDK stamps revocation with the operator's local clock.**
firebase-admin 12.7.0 `revokeRefreshTokens` sends
`validSince: Math.floor(new Date().getTime() / 1000)`
(`node_modules/firebase-admin/lib/auth/auth-api-request.js:1253-1263`) to
`accounts:update`; Auth stores it as `tokensValidAfterTime`
(`lib/auth/user-record.js:367-371`, whole seconds). The Admin SDK rejects a
session cookie, or an ID token checked with `checkRevoked`, when its
`auth_time` (whole seconds) is strictly earlier than that value
(`lib/auth/base-auth.js:966-972`); the refresh-token exchange runs in Google's
backend and is ASSUMED to apply the same rule. An operator clock 10 s slow
therefore leaves every session that started in those 10 s valid — including
sessions that started while the claim was still present — and "the value is
later than before" is still true. The previous version of this tool checked
exactly that and would have reported success; it is replaced.

**What the comparison is aimed at.** Every session that could have seen
`admin: true` started before the claim removal took effect on the server, so
the stored `tokensValidAfterTime` should be later than the server time at
which the claim write took effect. The tool cannot read that Auth-side time;
it observes a Firestore-side proxy for it, hence assumption (c).

**The server-time anchor.** The tool needs a server timestamp taken after the
claim write returned. Sources considered:

| Source | Verdict |
|---|---|
| Firestore commit time (`WriteResult.writeTime`) of a write issued after the claim write returned | **Used.** Server-assigned commit timestamp, nanosecond resolution, exposed by the public SDK (`@google-cloud/firestore/build/src/write-batch.js:62`, built at `:443` from `writeResult.updateTime \|\| response.commitTime`). Pitfall: for a write that does not change the document Firestore reports the document's PREVIOUS update time. The anchor write is the `users/{uid}.role` mirror, which always sets `updatedAt: serverTimestamp()`, so it always changes the document and its `writeTime` is its own commit time — that is the real protection against a stale anchor (pinned by `setSystemAdminClaimCli.spec.ts` and exercised through the real port in `setSystemAdminClaimRealPorts.spec.ts`). Backstop, with a narrower property: the anchor is rejected if it is not strictly later than the attempt row's commit time (same Firestore clock, written before the claim write). That catches a returned time at or before the attempt row; it does NOT catch a stale time later than that (e.g. the previous update time left by someone else's `users/{uid}` write landing after the attempt row). |
| HTTP `Date` header of the Identity Toolkit response | Rejected. Whole seconds only, and the SDK's public API does not expose response headers (`invokeRequestHandler` returns the body); reading it needs internal APIs. |
| Auth `metadata.lastRefreshTime` / `lastSignInTime` | Rejected. They describe the user's own activity, not "now"; they need not move during the run. |
| `DocumentSnapshot.readTime` of a read | Not used. Server-assigned, but its relation to request arrival is less clearly specified than a commit timestamp. |
| Setting `validSince` explicitly | Not used. `auth.updateUser(uid, { validSince })` reaches the same `accounts:update` RPC (`validSince` is whitelisted at `auth-api-request.js:314`) but is NOT part of the typed public `UpdateRequest`, and a future SDK could drop the key silently (`validateCreateEditRequest` deletes unknown keys). It could also LOWER an existing value — as `revokeRefreshTokens` itself can (see "Backward cutoff moves"). The public, documented `revokeRefreshTokens` is used and its result is read back instead. |

**The check.**
`cutoff = anchor whole seconds + 1 + 2` (Unix seconds). The `+1` covers the
second that contains the anchor (`auth_time` is truncated and the comparison
is strict); the `+2` is an ASSUMED margin for clock skew between the
Firestore and Firebase Auth servers (assumption (c): no published bound).
Before calling `revokeRefreshTokens` the tool waits
until an accurate operator clock would be about 1.5 s past the cutoff (a
timer, not a clock reading: it only sets how far behind an operator clock may
be and still pass; it is never evidence). It then reads the Auth record back
and reports the cutoff observed only when `tokensValidAfterTime >= cutoff`.
The local clock is never compared with anything.

- **Slow operator clock** (more than about 1.5 s behind): `validSince` lands
  below the cutoff, the run is `sessions_revoke_unverified` (exit 3) with a
  message naming the likely cause. Sync the clock and re-run; a re-run with
  the same clock fails the same way.
- **Fast operator clock:** `validSince` lands in the future relative to the
  server. It is still at or after the cutoff, so the cutoff is observed and
  the run completes. Assumed (not documented by Google, not verifiable
  offline) that Auth stores the value as sent; the effect is
  over-revocation: wherever revocation is checked, any session the target
  starts before that instant is rejected too (for the refresh-token exchange,
  under the assumed same rule), so the target may have to sign
  in again repeatedly, or be unable to stay signed in, until then. When it is
  more than 300 s ahead the success message says so and points at the
  recovery below.
- **No anchor** (role write failed, returned no time, or a time not later
  than the attempt row's): the revocation is still attempted, then reported
  `sessions_revoke_unverified` — validSince came from the local clock and no
  cutoff could be observed.
- **Claim write threw (revoke):** the revocation is still attempted (no
  anchor, no wait), the run is `mint_failed`, exit 3, with
  `claimWrite: "unconfirmed"`.
- **Read-back missing or failed:** `sessions_revoke_unverified` (plus
  `verification_failed` when the Auth read itself failed).

**Fast operator clock: recovery.** Sync this machine's clock (NTP) and re-run
the SAME revoke command. Checked against the code: because the `admin` claim
is already absent, the re-run is a sessions-only run — it writes a new attempt
row, does NOT write claims, writes the `users/{uid}.role` mirror (a fresh
anchor), waits, calls `revokeRefreshTokens` (which stamps `validSince` from the
now-synced clock) and reads back. If Auth stores the value as sent — the same
assumption as above; `accounts:update` accepts a lower `validSince`, see the
`updateUser` row in the table above — `tokensValidAfterTime` moves back to
about the current time, ending the lock-out, and the run completes as
`claim_already_absent_sessions_revoked` without the "operator clock is ahead"
note. If the note is still printed, Auth did not lower the value: the
lock-out lasts until that time passes. The re-run also requests revocation
again, as every revoke does: if the call is acknowledged, a session the target
did manage to start is rejected wherever revocation is checked only when its
`auth_time` is earlier than the new `validSince`. Because the recovery LOWERS
the stored value, it is a backward cutoff move: the run still completes
(exit 0, cutoff observed) but records
`tokensValidAfterTimeMovedBackward: true` and prints
"WARNING (not a clean success): tokensValidAfterTime moved BACKWARD during
this run ..." — expected for this recovery, and the reason the next section
exists.
(`lib/admin/__tests__/systemAdminClaimExecution.spec.ts`, "FAST-clock lock-out
recovery", models this under the stored-as-sent assumption.)

### Backward cutoff moves (unresolved risk, recorded, not prevented)

**The fact.** `revokeRefreshTokens` sends `validSince` = the caller's local
clock (`auth-api-request.js:1253-1263`) and Auth stores it. It OVERWRITES the
stored value; it does not keep the later of the two. A revocation request is
therefore not monotonic: a later call from a slower clock LOWERS
`tokensValidAfterTime`, and wherever revocation is checked (session cookies;
the refresh-token exchange, assumed) the check stops rejecting any session
whose `auth_time` lies between the new and the old value — including sessions
an earlier revoke had excluded. A session cookie minted while the target still
held `admin: true` carries that claim; if its `auth_time` falls in that
interval it passes `verifySessionCookie(cookie, true)` again. This tool does
not prevent this, and no algorithm change was made to prevent it (there is no
"never lower" guard).

**Which tool paths call `revokeRefreshTokens` more than once for a target.**
Within one run: none — every executed revoke calls it exactly once (pinned:
"every executed revoke calls revokeRefreshTokens EXACTLY once per run"). Across
runs, every run is a new call that overwrites: a normal revoke; a sessions-only
re-run (claim already absent) after `sessions_revoke_failed`,
`sessions_revoke_unverified`, `mint_failed` or `users_doc_failed`; the
fast-clock recovery; a second operator running the same revoke; and any other
Admin SDK caller (another script, the console) outside this tool.

**What the tool reports today** (`sessionRevocationEvidence` in the result
file and the outcome row; tests in
`lib/admin/__tests__/systemAdminClaimExecution.spec.ts`, "backward cutoff
move"):

- `tokensValidAfterTimeMovedBackward` compares the read-back value with the
  value read before the run (`tokensValidAfterTimeBefore`).
- If the stored value was NOT ahead of this run's server-anchored cutoff (the
  normal case: it was stamped by an earlier run or by Firebase in the past),
  any backward move puts the new value below that cutoff, so the run is
  ALREADY `sessions_revoke_unverified`, exit 3; the tool adds a failure detail
  "tokensValidAfterTime moved BACKWARD during this run, from X to Y". Pinned by
  an exhaustive grid of prior values and operator-clock offsets.
- Runs with no anchor (role write failed, claim write threw) are exit 3
  anyway; the backward detail is appended when the move is observed.
- A run whose read-back failed, or whose prior value was missing, records
  `null`: the direction is UNKNOWN.
- The only exit-0 backward move is from a stored value AHEAD of this run's
  cutoff (a fast-clock stamp; typically the fast-clock recovery). The new
  value is still at or after this run's cutoff, so the interval it re-admits
  starts after that cutoff (under the clock assumption). The run completes but
  prints "WARNING (not a clean success)" and records the flag.

**What is NOT covered.** (1) The tool sees only its own before/after pair. A
later call — another operator, a re-run from a slow clock, any Admin SDK
caller — can lower the value after a run reported success; that earlier
success then describes a state that no longer holds, and nothing in the tool
detects it. (2) A thrown `revokeRefreshTokens` call may have overwritten the
value anyway (unknown outcome). (3) The move is judged against the
Firestore-anchored cutoff, so the clock assumption below applies.

**What to do.** Sync the operator clock (NTP) before every revoke and every
re-run. After any run reporting a backward move outside the intended
fast-clock recovery, re-run the same command from a synced clock (with an accurate
clock its new `validSince` lands a few seconds after its own, later, server
anchor, so later than any value an accurate earlier run stored) and confirm `tokensValidAfterTimeMovedBackward:
false` and exit 0. One operator at a time per target.

**Residual risk (stated, not solved).** (1) The anchor and `validSince` come
from two different Google services. Google publishes no cross-service clock
bound; the 2 s margin ASSUMES their skew is below 2 s. That is an assumption,
not a contract and not a measured bound, so a completed revoke is never
evidence that revocation covered the claim removal. (2) It is assumed that
once `setCustomUserClaims` has returned, the claim removal is in effect for
token minting. A NEW sign-in that starts after the cutoff while a stale
replica still served `admin: true` is not covered by any revocation. Whether a
session that started BEFORE the removal is rejected is also not established by
the tool: Firebase rejects it only where revocation is checked (session
cookies, and — assumed, not observable from the Admin SDK — the refresh-token
exchange; not the bearer ID-token paths in the table below) and only if its
`auth_time` is earlier than the stored `validSince`, which the revoke call
stamps from the operator's local clock. The tool compares `validSince` with a
Firestore-anchored cutoff, never with Firebase Auth's own `auth_time` clock,
so this coverage holds only under the unproven cross-service clock assumption
in (1). (3) A fast operator clock over-revokes as described. (4) The
already-issued-ID-token window below is unchanged by any of this (fact (d)
above; S2). (5) Backward cutoff moves: any later `revokeRefreshTokens` call
from a slower clock lowers the stored value (section above); recorded per run,
not prevented.

What that does and does not invalidate in this codebase (code at the time of
writing; this tool does not change any route):

Read every row below as conditional. A revoke run moves through separate
states, and only the first three are things the tool records:
(1) revocation ATTEMPTED — `revokeRefreshTokens` was called;
(2) Firebase ACKNOWLEDGED the call — `revocationApiAcknowledged: true`;
(3) cutoff OBSERVED — `cutoffObserved: true`, i.e. the read-back
`tokensValidAfterTime` is at or after the Firestore-anchored cutoff;
(4) access EFFECTIVELY revoked for a given session — never observed by the
tool. (4) additionally needs that session's `auth_time` to be earlier than
the stored `validSince` (stamped from the operator's local clock), which for
sessions that started before the claim removal rests on the unproven
cross-service clock assumption in "Residual risk" above. If the revoke call
failed or threw (`sessions_revoke_failed`, `revocationApiAcknowledged:
false`), the outcome is UNKNOWN, not a confirmed no-op: whether Firebase
updated `validSince` is not known. Treat every credential in this table as
still valid; compare `sessionRevocationEvidence.tokensValidAfterTimeBefore`
with `tokensValidAfterTimeAfter` in the result file (a read-back taken after
the call) to see whether the stored value moved; and re-run the same
command.

| Credential | Checked by | Effect of the revoke |
|---|---|---|
| Firebase refresh tokens | Firebase Auth (on the token exchange, in Google's backend) | Only if Firebase applied the request (an acknowledged call; a thrown call's effect is unknown). ASSUMED, not observable from the Admin SDK or this tool: Firebase then refuses to mint new ID tokens from a refresh token whose session `auth_time` is earlier than the stored `validSince`, so the client loses that session on its next refresh. A session whose `auth_time` is at or after `validSince` (operator clock behind, or cross-service skew) keeps refreshing. The tool does not observe which sessions are affected. |
| `__session` cookie (5-day Firebase session cookie, `app/api/auth/session/route.ts:37`, `:76`) | `verifySessionCookie(cookie, true)` — revocation CHECKED — at `lib/firebase/auth-helpers.ts:127` (`verifySessionCookieValue`, used by `resolveRequestIdentity` / `resolveServerComponentIdentity` / `/api/auth/session`), `lib/firebase/auth-helpers.ts:277` (`requireAdminPortalAccess` cookie fallback) and `app/api/admin/access/route.ts:41` | Only if Firebase applied the request (an acknowledged call; a thrown call's effect is unknown): on its next request, a cookie whose session `auth_time` is earlier than the stored `validSince` fails the revocation check and is rejected. This is judged on `auth_time`, not on when the cookie was minted, so a cookie for a session whose `auth_time` is at or after `validSince` still passes; whether every pre-removal cookie is covered is NOT established by the tool. There is no `verifySessionCookie(..., false)` call in `lib/` or `app/`. |
| App-side session store | — | None exists: no `sessions` / `admin_sessions` collection grants access (searched `lib/`, `app/`, `middleware.ts`). `middleware.ts:26` only checks that a `__session` cookie is present for `/admin/*` routing; it grants no API access. Nothing else to invalidate. |
| Already-issued ID tokens (bearer, up to about 1 hour) | `verifyIdToken(token)` WITHOUT `checkRevoked` at `lib/firebase/auth-helpers.ts:56` (`verifyAdminToken` -> `requireSystemAdminAccess`), `lib/firebase/auth-helpers.ts:273` (`requireAdminPortalAccess`), `lib/firebase/adminAuth.ts:43` (`getRequestUser` -> `requireSystemAdminBearer`), `app/api/admin/access/route.ts:37`, `lib/firebase/auth.ts:30` (`checkRevoked: false`) | **NOT invalidated.** An ID token minted while the user held `admin: true` keeps `admin: true` until it expires, and these paths do not check revocation. |

**The remaining risk is already-issued ID tokens.** A refresh-token revocation
request (`revokeRefreshTokens`), even an acknowledged one, is NOT sufficient
to cut SYSTEM_ADMIN access off immediately. Until it expires (up to about an
hour), a revoked admin's existing ID token still passes every bearer path
listed above. Closing that window is a route change, outside this tool:
privileged endpoints must enforce current state on each request —
`verifyIdToken(token, true)` (revocation checked) and/or a live `getUser(uid)`
read of `customClaims.admin` — rather than trusting the claim inside a token.
(These route gaps are tracked separately; see admin-authority-tiers.md, "What
this procedure does NOT give you".) If immediate cut-off matters, disable the
account (`disabled: true`) out of band — before or after the revoke; on a
disabled account the tool still removes the claim and calls
`revokeRefreshTokens`, and never re-enables it. Firebase rejects ID tokens of
a disabled user only when revocation is checked, so even that does not close
the no-`checkRevoked` paths — treat the up-to-1-hour window as real.

Side effect of the policy: the revocation request is not limited to admin
use. Where Firebase applies it (the conditions in the table above), it ends
the target's ordinary (non-admin) sessions too, and the target may have to
sign in again. It is not a sign-out from every device: already-issued ID
tokens keep working until they expire, and a session whose `auth_time` is at
or after the stored `validSince` is unaffected.

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

## Pending follow-up: adopting the PR #294 operator grant

PR #294 (Firebase environment isolation) is merged and released (8a6ea65,
2026-11-06); it added the operator production grant
(`scripts/lib/operatorProductionAccess.ts`). This tool has NOT adopted it yet
and still reads only the explicit `--credentials` key file. Adopting it is a
pending follow-up: `loadOperatorCredential` in the script is the single place
that turns operator input into a credential, and the evidence type carries a
`source` discriminant (`explicit-key-file` today). Adoption replaces that
function with the grant (imported first, as the other operator scripts do),
adds the script to the grant's reviewed-operation list and its spec, and
leaves argv, plan, confirmation, write ordering and audit schema as they are.

## Rehearsal

Never rehearse against Production and never write test rows into Production
`admin_audit_logs`. Rehearse only against an isolated non-Production project
with its own key. The first Production use is the real, authorized change, and
its two audit rows plus the local result file are the evidence.
