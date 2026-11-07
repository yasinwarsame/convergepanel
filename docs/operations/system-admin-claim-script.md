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
- **Every revoke requests session revocation (owner policy, amended).** An
  executed revoke that gets past the attempt audit row and the operator clock
  check calls `revokeRefreshTokens` for the target, with no opt-out, **unless
  a fresh read immediately before the call shows the stored
  `tokensValidAfterTime` is later than the value the call would write** (see
  "Lowered cutoffs"). That call is a REQUEST: it can fail or throw
  (`sessions_revoke_failed`, exit 3; a thrown call is an unknown outcome, not
  a confirmed no-op), and even an acknowledged call has the limited effect
  described under "Revocation and sessions". The call OVERWRITES the stored
  `validSince` with the operator's clock (overwrite-only; no compare-and-set
  exists): see "Lowered cutoffs". There is no flag that overrides the
  fresh-read check. The former `--revoke-sessions=yes|no` flag was removed and
  is refused (`unknown_flag`) with a message saying that every executed revoke
  requests revocation.
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
  an effect: `revokeRefreshTokens` will be requested (unless the fresh
  pre-call read shows a stored cutoff later than this machine's clock), the
  request can fail, it overwrites `validSince` with this machine's clock (sync
  it first; the run stops before any claim write if this clock is more than
  2 s off Firestore server time), and it does not end already-issued ID tokens
  and is not a sign-out from every device.
- **Typed confirmation** binds operation, project and UID (and, for revoke, the
  mandatory revocation request):
  - grant: `grant:admin:true:<project>:<uid>`
  - revoke: `revoke:admin:removed:revocation-requested:<project>:<uid>`
  The `revocation-requested` part names the mandatory request; it asserts no
  effect on sessions. The revoke string is the same for a re-run whose claim
  is already absent (see "Retry"), so re-running the exact same command is
  always accepted. The retired forms `revoke:admin:removed:sessions-revoked:…`,
  `…:sessions-yes:…` and `…:sessions-no:…` are refused
  (`confirmation_mismatch`, with a note that the form is retired).
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
the session-revocation observations and the request id, never key material or
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
   **Operator clock check (G3).** The tool reads this machine's clock just
   before the create call and just after it returns. The attempt row's
   Firestore commit time must satisfy
   `local before − 2 s ≤ commit ≤ local after + 2 s` (request latency widens
   the window; it is measured, not assumed). Otherwise — or when the commit
   time is unusable, or the clock stepped backward across the call — the run
   stops with exit 3 `operator_clock_out_of_tolerance`: NO claim, role or
   revocation call is made, only the outcome row is written, and the claim is
   untouched. Sync the clock (NTP) and re-run. This compares the operator
   clock with Firestore's, so it rests on the same cross-service assumption as
   (c) below; it never measures Firebase Auth's clock. It applies to grant and
   revoke alike.
2. Claim write (skipped on a revoke whose claim is already absent), then the
   `users/{uid}.role` mirror (`admin` / `user`; display only). On revoke the
   role write is ALSO the server-time anchor (see "What a revoke reports"),
   so it is written on every revoke, re-runs included. Then — on EVERY
   revoke — a short wait (only when an anchor was taken; about 3.5–4.5 s),
   a FRESH read of the target's Auth record (G2, immediately before the
   call), and the `revokeRefreshTokens` request unless that read shows a
   stored `tokensValidAfterTime` later than the value the call would write
   (exit 4 `stored_cutoff_ahead`, no call) or the read fails (exit 3
   `pre_call_read_failed`, no call — never a fallback to the earlier read or
   an assumed value). The claim and role writes already made are kept and
   reported: they reduce privilege.
   A failed claim write skips the role write. On a GRANT it also means no
   revocation (a grant never revokes). On a REVOKE the revocation is STILL
   requested (after the fresh pre-call read), without the wait:
   `setCustomUserClaims` may have applied server-side before it threw. That
   request is not guaranteed to narrow access: without the wait it stamps
   `validSince` from the operator's clock immediately; the fresh read refuses
   a value lower than the stored one, but another writer inside the run
   window can still lower it (see "Lowered cutoffs"). The run
   stays INCOMPLETE (`mint_failed`, exit 3) because the claim write is
   unconfirmed and no anchor was taken; the result and the outcome row record
   `sessionRevocationObservations.claimWrite: "unconfirmed"` and whether the
   revocation call was acknowledged, plus a `sessions_revoke_unverified`
   detail when it was acknowledged or a `sessions_revoke_failed` detail when
   it failed. A failed role write does NOT skip the revocation either, and that
   run is INCOMPLETE too.
3. Read-back of the Auth record and `users/{uid}.role`; for revoke, the
   server's `tokensValidAfterTime` is compared with the server-anchored
   cutoff (an observation under a clock assumption, not proof — see below)
   and with every value known earlier in the run (a lower read-back is
   `revocation_cutoff_lowered`).
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
| outcome `applied` (revoke) | `REVOKE_SYSTEM_ADMIN_CLAIM` | `true` | read-back. The name covers the claim removal read back as planned; for the session side read `metadata.sessionRevocationState` (exit 0 requires `CUTOFF_OBSERVED`) |
| outcome `claim_already_absent_revocation_cutoff_observed` | `SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED` | `true` | read-back (no claim was written by this run) |
| outcome `mint_failed`, `sessions_revoke_failed`, `sessions_revoke_unverified`, `users_doc_failed`, `verification_failed`, `operator_clock_out_of_tolerance`, `pre_call_read_failed`, `audit_outcome_missing` (exit 3) | `SYSTEM_ADMIN_CLAIM_INCOMPLETE` | `false` | read-back (`afterSemantics: "read-back"`) — or, when a read-back failed, `null` for the unread field with `afterSemantics: "unknown"`: the state is UNKNOWN, not empty |
| outcome `revocation_cutoff_lowered`, `stored_cutoff_ahead` (exit 4, review required) | `SYSTEM_ADMIN_CLAIM_INCOMPLETE` | `false` | read-back; the claim removal may be complete — read `metadata.outcome` and the observations |

The admin user-details page shows each of these action types with a readable
label (the raw name is kept as the hover title). On a completed run,
`claim_already_absent_revocation_cutoff_observed` and
`SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED` mean (a) and (b) below: the
revocation request was acknowledged and the cutoff was observed. They do not
mean that any session of the target is invalid; effective revocation is not
observable (`effectiveRevocation: "not_observable"` on every revoke row).

A completed outcome is only ever written with a full read-back; the record
builder downgrades a "completed" outcome without one to `verification_failed`
(also an exit-4 outcome without one), a "completed" REVOKE outcome whose
revocation call was not acknowledged or whose cutoff was not observed to
`sessions_revoke_unverified`, then one whose read-back is lower than an
earlier value to `revocation_cutoff_lowered`, and finally any "completed"
REVOKE outcome whose state is not `CUTOFF_OBSERVED` to
`sessions_revoke_unverified` (precedence 3 > 4 > 0). Every revoke outcome row
carries `metadata.sessionRevocationObservations`,
`metadata.sessionRevocationState` and `metadata.effectiveRevocation`; every
revoke attempt row carries `metadata.effectiveRevocation`. The result file
carries the same as `run.sessionRevocationObservations`,
`run.sessionRevocationState` and `run.effectiveRevocation`. The fields keep
these things apart:

| Field | Meaning |
|---|---|
| `sessionRevocationState` | One of `NOT_REQUESTED` (no call: clock check, attempt-row failure, pre-call read failure, stored value ahead), `REQUESTED_UNACKNOWLEDGED` (the call threw; effect UNKNOWN), `ACKNOWLEDGED_UNOBSERVED` (acknowledged; no anchor, no read-back, or an unconfirmed claim write), `CUTOFF_NOT_REACHED` (read-back earlier than the cutoff), `CUTOFF_ANOMALY` (read-back absent or unparseable, or more than 300 s after the anchor), `CUTOFF_LOWERED` (read-back earlier than a value known earlier in the run; cause not attributable), `CUTOFF_OBSERVED`. None of them means a session was rejected. |
| `effectiveRevocation` | Always `"not_observable"`. |
| `claimWrite` | `confirmed`, `unconfirmed` (the claim write threw; it may have applied), `skipped_already_absent`, or `not_attempted` (stopped by the clock check) |
| `revocationRequested` | Whether `revokeRefreshTokens` was called in this run. |
| `revocationApiAcknowledged` | (a) `revokeRefreshTokens` returned without error. An acknowledgment from the API, nothing more. |
| `anchorServerTime`, `marginSeconds`, `cutoff`, `tokensValidAfterTimeBefore` / `After`, `validSinceMinusAnchorSeconds`, `cutoffObserved` | (b) the observed cutoff: whether the read-back `tokensValidAfterTime` is at or after the server-anchored cutoff, after an acknowledged call |
| `preCallCheck` | G2: `read` (`read` / `failed` / `not_attempted`), the fresh `tokensValidAfterTime`, `storedSeconds` (S), `localSeconds` (V), and `decision` (`call`, `skip_stored_ahead`, `refuse_unusable`, `refuse_read_failed`, `not_reached`) |
| `tokensValidAfterTimeLowerThanBefore` | (f) `true` when the read-back value is earlier (whole seconds) than a value known earlier in this run — the pre-run read, the fresh pre-call read, or (after an acknowledged call) the V the call was cleared to write. The cause is not attributable: this run's call, a clock step, or another writer inside the run window. `false` when not; `null` when the read-back or every earlier value was missing or unparseable (direction UNKNOWN, never assumed forward). See "Lowered cutoffs". |
| `clockAlignmentAssumption` | (c) the cross-service clock ASSUMPTION the comparison rests on (fixed text) |
| `currentPrivilegeEnforcement` | (d) what the revocation does NOT do for current admin privileges until S2 (fixed text) |
| `detail` | (e) every reason the run is not a clean exit 0, joined: why no call was made, why the cutoff was not observed, and any lowering text. `null` only on a clean `CUTOFF_OBSERVED`. A `CUTOFF_LOWERED` run whose cutoff WAS observed still carries the lowering text here. |

(Before this change these fields were named `sessionRevocationEvidence`,
`tokensValidAfterTimeMovedBackward`, and the completed outcomes
`claim_already_absent_…`/`REVOKE_SYSTEM_ADMIN_…` used names that read as an
effect on sessions. They were renamed before merge; nothing on `main` read
the old names.)

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
| `0` | Completed: `applied`, `claim_already_absent_revocation_cutoff_observed`, or a grant already in place (`no_change`). Every observable step succeeded: the claims read back as planned; on revoke, revocation was requested and acknowledged, there is a server-time anchor, the read-back `tokensValidAfterTime` is at or after the server-anchored cutoff, and it is not lower than any value read earlier in the run (`CUTOFF_OBSERVED`). The message reads "revocation requested and acknowledged; cutoff observed … under the Firestore≈Auth clock assumption …; effective revocation not observable" — not proof of revocation, and (until S2) without cutting off already-issued ID tokens. | As required by the operation (none for `no_change`). |
| `2` | Refused, or dry run (the default). Also an unexpected error raised before any write call. | **None.** Guaranteed: exit 2 is only returned before the first write call (the attempt audit row included) is issued; the result file records `writeAttempted: false`. |
| `3` | A write call was issued and the operation is INCOMPLETE: `audit_attempt_failed` (attempt row outcome unknown), `operator_clock_out_of_tolerance` (no claim, role or revocation call), `mint_failed`, `pre_call_read_failed` (no revocation call), `sessions_revoke_failed`, `sessions_revoke_unverified`, `users_doc_failed`, `verification_failed`, `audit_outcome_missing`, or an unexpected error after a write call. | Unknown / partial. Inspect the read-back in the result file. On a revoke, a failed or thrown revocation call is an UNKNOWN outcome, not a confirmed no-op. Re-running the same command is how an incomplete run is finished; it never re-applies a claim or changes another claim, but a revoke re-run calls `revokeRefreshTokens` again (unless the fresh pre-call read shows a stored value ahead) — sync the clock first (see "Retry" and "Lowered cutoffs"). |
| `4` | REVIEW REQUIRED — do not re-run blindly, do not treat as done: `revocation_cutoff_lowered` (the read-back is lower than a value known earlier in the run, any cause) or `stored_cutoff_ahead` (the fresh pre-call read showed a stored value later than the value the call would write, so the call was NOT made). The row records `completed: false`; the message carries the review guidance, not the re-run guidance. | The claim and role writes of the run were made and read back (claim removal may be complete). On `stored_cutoff_ahead` no revocation call was made. |
| `1` | The result file could not be written after an otherwise exit-0 run. | As for exit 0. |

**Precedence 3 > 4 > 0.** A run that is incomplete for an exit-3 reason stays
exit 3 even when it also observed a lowering or a stored value ahead; the
review fact is still recorded (failure details, `sessionRevocationState:
"CUTOFF_LOWERED"`, and the message names it). Exit 4 is never mapped to 0 or
3, and a result-file failure turns only exit 0 into 1 (exit 4 stays 4).

A dry run exits 2, not 0: it completed nothing. The one exit-0 run without
`--execute` is a GRANT whose claim is already in place (`no_change`): there
is nothing to do, so it reports done with or without `--execute` and writes
nothing. Scripts that wrap the tool must treat only `0` as "done", and must
never retry automatically on `4`.

### Retry

Re-running the exact same command (same flags, same `--confirm-claim`) after
any exit 3 is how an incomplete run is finished. After exit 4, do NOT re-run
first: review (see "Lowered cutoffs"). What a re-run does and does not do:

- It never re-applies a claim already in place and never changes any other
  claim (grant re-run => `no_change`; a grant whose `users/{uid}.role` mirror
  failed is reported in the `no_change` message and is not repaired).
- A revoke whose `admin` claim is already absent — e.g. the previous run ended
  `sessions_revoke_failed` — does NOT report "no change". Under the same typed
  confirmation it writes the attempt row, does NOT call the claim write,
  writes the `users/{uid}.role` mirror (the server-time anchor; the same value
  `user` again), takes a fresh read, calls `revokeRefreshTokens` again unless
  that read shows a stored value later than this machine's clock (exit 4
  `stored_cutoff_ahead`) — the call OVERWRITES `validSince` with the
  operator's clock (see "Lowered cutoffs"; sync the clock before every
  re-run) — compares `tokensValidAfterTime` with a fresh server-anchored
  cutoff, and — only when the call was acknowledged, the cutoff observed and
  nothing lower than an earlier value was read back — writes an outcome row
  `claim_already_absent_revocation_cutoff_observed`
  (`SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED`), exit 0. If the revocation call
  fails or throws again it is `sessions_revoke_failed`, exit 3 (outcome
  unknown), and the instruction is the same: re-run.
- `operator_clock_out_of_tolerance` means this machine's clock is more than
  2 s (plus the measured request latency) off Firestore server time. Nothing
  but the attempt and outcome rows was written. Sync the clock (NTP), then
  re-run; with the same clock the re-run is refused the same way.
- `sessions_revoke_unverified` with "earlier than the server-anchored cutoff"
  means the operator's clock is behind server time by more than the wait
  slack (about 1.5 s) while still inside the 2 s clock check. Sync the clock
  (NTP) first, then re-run.
- `pre_call_read_failed`: the fresh read immediately before
  `revokeRefreshTokens` failed (or returned an unusable record), so the call
  was NOT made; the claim and role writes of the run stand. Re-run the same
  command; it reads again.
- `revocation_cutoff_lowered` or `stored_cutoff_ahead` (exit 4, or a review
  fact inside an exit 3): see "Lowered cutoffs" for what it means and what to
  do. Do not re-run blindly.
- `mint_failed` on a revoke: the claim write threw, so whether `admin` was
  removed is unknown. The tool still ATTEMPTED `revokeRefreshTokens`; that
  call can itself fail. Read `sessionRevocationObservations`:
  `revocationApiAcknowledged: true` means only that Firebase acknowledged the
  call; `false` means it failed too (also recorded as a
  `sessions_revoke_failed` detail). In both cases no server-time anchor was
  taken, so no cutoff was observed (`cutoffObserved: false`), and the run is
  INCOMPLETE (exit 3) — an acknowledgment is not evidence that any earlier
  session is invalid. Re-run the same command: if the removal had
  landed, the re-run is a sessions-only run (no claim write); if not, it
  writes the claim again.
- A fast operator clock — refused by the clock check before any claim write;
  for a stored value left ahead by an earlier fast clock, see "Fast operator
  clock: recovery" below.
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

Every executed revoke that gets past the attempt audit row and the operator
clock check calls `revokeRefreshTokens(targetUid)` — unless a fresh read
immediately before the call shows the stored `tokensValidAfterTime` is later
than the value the call would write — so revocation is REQUESTED. The call can
fail or throw (`sessions_revoke_failed`, exit 3); a thrown call is an UNKNOWN
outcome — Firebase may or may not have updated `validSince` — not a confirmed
no-op. API acknowledgment, the observed cutoff and effective authorization are
separate things; only the first two are observable. What the tool can say
afterwards is limited, and it says it in separate parts — in the exit-0
message, the result file and the outcome audit row:

- **(a) API acknowledgment.** `revokeRefreshTokens` returned without error.
  That is all it means.
- **(b) Observed cutoff.** The read-back `tokensValidAfterTime` is at or after
  a cutoff anchored on a Firestore server commit time taken after the claim
  write returned, and is not lower than any value known earlier in the run.
  Below the cutoff, or no anchor, or no read-back: INCOMPLETE
  (`sessions_revoke_unverified`, exit 3) — never success. Lower than an
  earlier value: `revocation_cutoff_lowered`, exit 4 — never success.
- **(c) Clock-alignment ASSUMPTION.** The anchor is Firestore's clock;
  `tokensValidAfterTime` is judged by Firebase Auth. Google publishes no bound
  on the skew between those services. The 2 s margin is an assumption, not a
  measured or documented bound, and the skew is unbounded as far as this tool
  can know. So (b) is an observation under an assumption. **It is not proof
  that sessions were revoked**, and the tool never reports it as such:
  effective revocation is not observable (`effectiveRevocation:
  "not_observable"` on every revoke row). The exit-0 message reads:
  "revocation requested and acknowledged; cutoff observed at or after the
  server-anchored cutoff under the Firestore≈Auth clock assumption (skew < 2 s
  assumed, unbounded); effective revocation not observable".
- **(d) Enforcement of current admin privileges: not provided (until S2).**
  Today the SYSTEM_ADMIN bearer guards call `verifyIdToken` WITHOUT `checkRevoked`
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
  reason in `sessionRevocationObservations.detail` and `failureDetails`. Re-run
  the same command (see "Retry"). An observed lowering or a stored value ahead
  is exit 4 (review required; see "Lowered cutoffs").

### What a revoke reports (and why not "the value advanced")

**The SDK stamps revocation with the operator's local clock.**
firebase-admin 12.7.0 `revokeRefreshTokens` sends
`validSince: Math.floor(new Date().getTime() / 1000)`
(`node_modules/firebase-admin/lib/auth/auth-api-request.js:1253-1263`) to
`accounts:update`, which has no precondition and no compare-and-set; Auth
stores it and the SDK reports it as `tokensValidAfterTime`, a UTC string with
whole-second resolution (`lib/auth/user-record.js:35-46`, `:366-371`). The Admin SDK rejects a
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
| Setting `validSince` explicitly | Not used. `auth.updateUser(uid, { validSince })` reaches the same `accounts:update` RPC (`validSince` is whitelisted at `auth-api-request.js:314`) but is NOT part of the typed public `UpdateRequest`, and a future SDK could drop the key silently (`validateCreateEditRequest` deletes unknown keys). It could also LOWER an existing value — as `revokeRefreshTokens` itself can (see "Lowered cutoffs"). The public, documented `revokeRefreshTokens` is used and its result is read back instead. |

**The check.**
`cutoff = anchor whole seconds + 1 + 2` (Unix seconds). The `+1` covers the
second that contains the anchor (`auth_time` is truncated and the comparison
is strict); the `+2` is an ASSUMED margin for clock skew between the
Firestore and Firebase Auth servers (assumption (c): no published bound).
Before calling `revokeRefreshTokens` the tool waits
until an accurate operator clock would be about 1.5 s past the cutoff (a
timer, not a clock reading: it only sets how far behind an operator clock may
be and still pass; it is never evidence). It then takes the fresh pre-call
read (G2), calls, reads the Auth record back and reports the cutoff observed
only when `tokensValidAfterTime >= cutoff`. The local clock IS compared with
Firestore's in two places, both under assumption (c): the clock check around
the attempt row (G3), and V in the pre-call check (G2). It is never compared
with Firebase Auth's own clock, which is not observable.

- **Operator clock more than 2 s off** (plus the measured request latency),
  either direction: refused by the clock check before any claim write
  (`operator_clock_out_of_tolerance`, exit 3; no claim, role or revocation
  call). Sync the clock (NTP) and re-run.
- **Slow operator clock inside the check** (about 1.5–2 s behind):
  `validSince` can land below the cutoff, the run is
  `sessions_revoke_unverified` (exit 3) with a message naming the likely
  cause. Sync the clock and re-run.
- **Fast operator clock inside the check** (up to about 2 s ahead):
  `validSince` lands up to about 2 s in the future relative to the server;
  the cutoff is observed. A read-back more than 300 s after the anchor cannot
  come from a clock that passed the check: it is `CUTOFF_ANOMALY`,
  `sessions_revoke_unverified`, exit 3 (another writer or a clock step is the
  likely source).
- **No anchor** (role write failed, returned no time, or a time not later
  than the attempt row's): the revocation is still attempted, then reported
  `sessions_revoke_unverified` — validSince came from the local clock and no
  cutoff could be observed.
- **Claim write threw (revoke):** the revocation is still attempted (no
  anchor, no wait), the run is `mint_failed`, exit 3, with
  `claimWrite: "unconfirmed"`.
- **Read-back missing or failed:** `sessions_revoke_unverified` (plus
  `verification_failed` when the Auth read itself failed).

**Fast operator clock: recovery.** The clock check now refuses a fast
operator clock before any claim write, so this tool no longer stamps a far
future `validSince`. A stored value that is already far ahead (stamped by an
earlier version of this tool, by another writer, or by a clock step) locks
the target out wherever revocation is checked until that time passes. A
re-run of the same revoke from a synced clock does NOT lower it: the fresh
pre-call read shows the stored value later than the value the call would
write, so `revokeRefreshTokens` is NOT called and the run ends exit 4
`stored_cutoff_ahead` (the claim and role writes of the run stand). Lowering
a stored cutoff on purpose is not something this tool does: there is no mode
or flag for it. It needs an owner-approved recovery policy with its own
authorization record and audit design (deferred). Until then, treat the
lock-out as lasting until the stored time passes, and escalate to the owner.
(`lib/admin/__tests__/systemAdminClaimExecution.spec.ts`, "G2: fresh pre-call
read", pins that a stored value ahead is never overwritten by this tool.)

### Lowered cutoffs (unresolved risk; narrowed for this tool only)

**The fact.** `revokeRefreshTokens` sends `validSince` = the caller's local
clock (`auth-api-request.js:1253-1263`) and Auth stores it. It OVERWRITES the
stored value; it does not keep the later of the two. The Auth API is
overwrite-only (`accounts:update`, no precondition, no compare-and-set), so
no caller's write is conditioned on the stored value. A later call from a
slower clock LOWERS `tokensValidAfterTime`, and wherever revocation is checked
(session cookies; the refresh-token exchange, assumed) the check stops
rejecting any session whose `auth_time` lies between the new and the old value
— including sessions an earlier revoke had excluded. A session cookie minted
while the target still held `admin: true` carries that claim; if its
`auth_time` falls in that interval it passes `verifySessionCookie(cookie,
true)` again.

**Owner policy (amended, D-2a).** "Every revoke calls `revokeRefreshTokens`"
now reads: every revoke calls `revokeRefreshTokens` unless a fresh read
immediately before the call shows the stored `tokensValidAfterTime` is later
than the value the call would write. In whole seconds: `S` = the stored value
floored to seconds, `V = floor(Date.now() / 1000)` read just before the call;
if `V < S` the call is **not made** (exit 4 `stored_cutoff_ahead`). `V == S`
calls (it rewrites the same value). There is no override flag. A skipped call
loses no coverage — every session with `auth_time < S` is already rejected
wherever revocation is checked, a superset of `< V` — but a stored value ahead
of a clock-checked local time is an anomaly someone must review, hence exit 4.
If the fresh read fails, the call is not made either (exit 3
`pre_call_read_failed`; never a fallback to the earlier read or an assumed
value).

**What this tool does.** This tool refuses to write a value lower than the
one it reads immediately before the call, and reports any lowering it
observes within its own run. Nothing more is claimed: the cutoff stays
overwrite-only for every other caller.

**What the tool reports** (`sessionRevocationObservations` in the result file
and the outcome row; tests in
`lib/admin/__tests__/systemAdminClaimExecution.spec.ts`, "G1 grid", "G2",
"G3", "concurrency"):

- `tokensValidAfterTimeLowerThanBefore` compares the read-back value with every
  value known earlier in the run: `tokensValidAfterTimeBefore` (pre-run),
  `preCallCheck.tokensValidAfterTime` (fresh pre-call read) and, after an
  acknowledged call, `preCallCheck.localSeconds` (V; the SDK stamps V or later
  on a clock that does not step backward).
- Lower read-back on an otherwise complete run: exit 4
  `revocation_cutoff_lowered`, `sessionRevocationState: "CUTOFF_LOWERED"`,
  `completed: false`. Cause not attributable (this run's call, a clock step,
  or another writer inside the run window).
- Lower read-back on a run that is already incomplete (below the cutoff, no
  anchor, claim write threw, outcome row missing): exit 3 with the exit-3
  code; the `revocation_cutoff_lowered` detail and the `CUTOFF_LOWERED` state
  are recorded as well.
- A run whose read-back failed, or with no usable earlier value, records
  `null`: the direction is UNKNOWN.

**Concurrency, other callers and residuals** (no global property is claimed;
each mechanism narrows only this tool's own contribution):

| Writer / interleaving | Effect | Residual (documented, not closed) |
|---|---|---|
| This tool, slow operator clock | The clock check stops the run before the claim write when the attempt row's commit time is outside `[local before − 2 s, local after + 2 s]`; the pre-call check refuses `V < S`. | The Firestore≈Auth clock assumption (no documented bound). |
| This tool, fast operator clock | The clock check stops the run before the claim write. | Same assumption. |
| Two operators of this tool on the same target, interleaved | Each run's fresh read sees the other's committed stamp, so a lower stamp is refused. Between one run's fresh read and its call the other run may write (a window of milliseconds); a run whose read-back comes after the other's lower write reports `CUTOFF_LOWERED`, exit 4. The run whose own call did the overwriting cannot see it. | Detection only for the overlap. Rule: one operator at a time per target (no lock exists). |
| Firebase console, another Admin SDK caller, a future server-side revoke, a password change (Firebase documents that these revoke refresh tokens; whether that rewrites `validSince`, and from which clock, is UNKNOWN) | Inside the run window: detected by the read-back as `CUTOFF_LOWERED` (cause not attributable). Outside the window: invisible to the tool. | A later lowering by anyone is not detected; no monitor exists. |
| SDK clock read after V | The SDK reads the clock milliseconds after V, so it writes V or V+1 on a clock that does not step. | A backward clock step between the check and the call is caught by the read-back (`CUTOFF_LOWERED`). |
| Thrown `revokeRefreshTokens` (it may have applied) | `REQUESTED_UNACKNOWLEDGED`, exit 3. A re-run's fresh read compares against whatever is stored. | Unchanged. |

**Which tool paths call `revokeRefreshTokens` more than once for a target.**
Within one run: none — every revoke that reaches the call calls it exactly
once (pinned: "EXACTLY once per run"). Across runs, every run is a new call
that overwrites (unless the fresh read refuses it): a normal revoke; a
sessions-only re-run (claim already absent) after `sessions_revoke_failed`,
`sessions_revoke_unverified`, `pre_call_read_failed`, `mint_failed` or
`users_doc_failed`; a second operator running the same revoke; and any other
Admin SDK caller (another script, the console) outside this tool.

**What is NOT covered.** (1) The tool sees only its own run window. A later
call — another operator, any Admin SDK caller, the console — can lower the
value after a run reported exit 0; that earlier exit 0 then describes a state
that no longer holds, and nothing in the tool detects it. (2) A writer between
this run's fresh read and its call is overwritten by this run's call and is
not visible to this run. (3) A thrown `revokeRefreshTokens` call may have
overwritten the value anyway (unknown outcome). (4) Every comparison with the
Firestore-anchored cutoff rests on the clock assumption above.

**What to do.** Sync the operator clock (NTP) before every revoke and every
re-run. On exit 4 (or an exit 3 carrying a `revocation_cutoff_lowered` /
`stored_cutoff_ahead` detail): do not re-run blindly. Compare
`tokensValidAfterTimeBefore`, `preCallCheck` and `tokensValidAfterTimeAfter`,
find out what wrote the stored value (another operator, the console, another
Admin SDK caller, a fast clock), and decide with the owner. A re-run from a
synced clock does not restore a higher value that was lost. One operator at a
time per target.

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
in (1). (3) A stored value ahead (an earlier fast clock or another writer)
over-revokes until it passes; this tool does not lower it. (4) The
already-issued-ID-token window below is unchanged by any of this until S2
(fact (d) above). (5) Lowered cutoffs: any later `revokeRefreshTokens` call from a slower
clock, by any caller, lowers the stored value ("Lowered cutoffs"); this tool
refuses to write a value lower than the one it reads immediately before the
call and reports a lowering it observes within its own run, nothing more.

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
still valid; compare `sessionRevocationObservations.tokensValidAfterTimeBefore`
with `tokensValidAfterTimeAfter` in the result file (a read-back taken after
the call) to see whether the stored value moved; and re-run the same
command.

| Credential | Checked by | Effect of the revoke |
|---|---|---|
| Firebase refresh tokens | Firebase Auth (on the token exchange, in Google's backend) | Only if Firebase applied the request (an acknowledged call; a thrown call's effect is unknown). ASSUMED, not observable from the Admin SDK or this tool: Firebase then refuses to mint new ID tokens from a refresh token whose session `auth_time` is earlier than the stored `validSince`, so the client loses that session on its next refresh. A session whose `auth_time` is at or after `validSince` (operator clock behind, or cross-service skew) keeps refreshing. The tool does not observe which sessions are affected. |
| `__session` cookie (5-day Firebase session cookie, `app/api/auth/session/route.ts:37`, `:76`) | `verifySessionCookie(cookie, true)` — revocation CHECKED — at `lib/firebase/auth-helpers.ts:127` (`verifySessionCookieValue`, used by `resolveRequestIdentity` / `resolveServerComponentIdentity` / `/api/auth/session`), `lib/firebase/auth-helpers.ts:277` (`requireAdminPortalAccess` cookie fallback) and `app/api/admin/access/route.ts:41` | Only if Firebase applied the request (an acknowledged call; a thrown call's effect is unknown): on its next request, a cookie whose session `auth_time` is earlier than the stored `validSince` fails the revocation check and is rejected. This is judged on `auth_time`, not on when the cookie was minted, so a cookie for a session whose `auth_time` is at or after `validSince` still passes; whether every pre-removal cookie is covered is NOT established by the tool. There is no `verifySessionCookie(..., false)` call in `lib/` or `app/`. |
| App-side session store | — | None exists: no `sessions` / `admin_sessions` collection grants access (searched `lib/`, `app/`, `middleware.ts`). `middleware.ts:26` only checks that a `__session` cookie is present for `/admin/*` routing; it grants no API access. Nothing else to invalidate. |
| Already-issued ID tokens (bearer, up to about 1 hour) | `verifyIdToken(token)` WITHOUT `checkRevoked` at `lib/firebase/auth-helpers.ts:56` (`verifyAdminToken` -> `requireSystemAdminAccess`), `lib/firebase/auth-helpers.ts:273` (`requireAdminPortalAccess`), `lib/firebase/adminAuth.ts:43` (`getRequestUser` -> `requireSystemAdminBearer`), `app/api/admin/access/route.ts:37`, `lib/firebase/auth.ts:30` (`checkRevoked: false`) | **NOT invalidated (until S2).** An ID token minted while the user held `admin: true` keeps `admin: true` until it expires, and these paths do not check revocation. |

**The remaining risk (until S2) is already-issued ID tokens.** A refresh-token revocation
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
