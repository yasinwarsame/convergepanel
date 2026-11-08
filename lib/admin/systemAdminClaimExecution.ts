/**
 * SYSTEM_ADMIN claim operator tool: orchestration over injected ports.
 *
 * `scripts/admin/set-system-admin-claim.ts` wires real Firebase Admin objects
 * into these ports; the tests wire call-counting fakes. This module imports no
 * Firebase code and reads no environment; the operator clock is read only
 * through the `nowMs` port. The write ordering below is pinned by tests rather
 * than asserted in prose.
 *
 * Write ordering on --execute (fail closed):
 *   1. create the `attempt` audit row (create-only). If that call fails the
 *      row's existence is UNKNOWN: no further write is issued and the run is
 *      INCOMPLETE (exit 3, `audit_attempt_failed`), never "nothing written".
 *   1a. G3 clock gate: the attempt row's Firestore commit time must lie within
 *      [local clock before the create − margin, local clock after it + margin].
 *      Otherwise exit 3 `operator_clock_out_of_tolerance`: NO claim, role or
 *      revocation call; only the outcome row is written.
 *   2. write the custom claims — skipped on a revoke whose `admin` claim is
 *      already absent (a re-run): claims are never rewritten then.
 *   3. mirror `users/{uid}.role` (display-only field used by the admin UI).
 *      On revoke this write is ALSO the server-time anchor: its Firestore
 *      commit time is a server timestamp taken after the claim write returned
 *      (see observeRevocationCutoff in systemAdminClaimSafety.ts), so it is
 *      written on EVERY revoke, re-runs included.
 *   4. revoke: wait until the operator's clock should have passed the cutoff
 *      (anchor + 1 s + margin), then — owner policy, no opt-out — call
 *      revokeRefreshTokens ONCE on every revoke, unless a fresh read
 *      immediately before the call shows the stored tokensValidAfterTime is
 *      later than the value the call would write (G2: V < S, whole seconds;
 *      exit 4 `stored_cutoff_ahead`), or that fresh read fails (exit 3
 *      `pre_call_read_failed`; no fallback to an earlier read). Attempted even
 *      when step 3 failed, and even when the claim write in step 2 threw (it
 *      may have applied server-side) — such a run is INCOMPLETE (exit 3). The
 *      call OVERWRITES validSince with the operator's clock; see (f) in
 *      systemAdminClaimSafety.ts for what G2/G3 narrow and what they leave.
 *   5. read back (claims; role; for revoke, compare the server's
 *      tokensValidAfterTime with the server-anchored cutoff — an observation
 *      under REVOCATION_CLOCK_ASSUMPTION, not proof of revocation — and with
 *      the values read earlier in the run: a lower read-back is exit 4
 *      `revocation_cutoff_lowered`, cause not attributable).
 *   6. create the `outcome` audit row (create-only).
 * Exit precedence: 3 (incomplete) > 4 (review required) > 0 (completed).
 * A claim-write failure skips step 3 (and, on a grant, step 4 does not apply);
 * read-back and the outcome row still run so the observations record what
 * actually happened. Nothing is rolled back automatically; a re-run never
 * re-applies a claim already in place or changes another claim, but a revoke
 * re-run calls revokeRefreshTokens again (RERUN_GUIDANCE).
 *
 * The operator ID token is read through a port, passed to `verifyIdToken`, and
 * dropped. It is never logged, returned, or written to any record.
 */

import {
  type AuditOutcome,
  type AuthorizationMode,
  type ClaimPlan,
  type ClaimWritePlan,
  type Claims,
  type DecodedTokenLike,
  type ParsedClaimArgs,
  type PostWriteFailure,
  type PreCallCheck,
  type Refusal,
  type ReadOutcome,
  type RefusalCode,
  type ReviewRequiredOutcome,
  type ServerTime,
  type ServiceAccountEvidence,
  type SessionRevocationObservations,
  type SessionRevocationState,
  type UserRecordLike,
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  EFFECTIVE_REVOCATION,
  REVOCATION_CLOCK_ASSUMPTION,
  REVOCATION_OBSERVED_SUMMARY,
  REVOCATION_SKEW_MARGIN_SECONDS,
  auditDocId,
  buildClaimAuditRecord,
  checkBootstrapFirstAdmin,
  checkConfirmation,
  checkOperatorAuthorization,
  checkOperatorClock,
  checkPlanInvariants,
  checkPreCallCutoff,
  checkRevocationAnchor,
  checkRevokeSafety,
  checkTargetRecord,
  classifyOperatorTokenError,
  countAdminHolders,
  expectedConfirmation,
  formatDiff,
  maskEmail,
  observeRevocationCutoff,
  planClaimChange,
  refuse,
  revocationCutoffSeconds,
  highestEarlierValue,
  serverTimeIso,
  validSinceLowerThanBefore,
  validSinceLowerThanBeforeDetail,
  verifyReadBack,
} from "./systemAdminClaimSafety";

// ---------------------------------------------------------------------------
// Ports

export interface ClaimAuthPort {
  getUser(uid: string): Promise<UserRecordLike>;
  verifyIdToken(token: string, checkRevoked: true): Promise<DecodedTokenLike>;
  listUsers(maxResults: number, pageToken?: string): Promise<{ users: UserRecordLike[]; pageToken?: string }>;
  /** The one claim-writing call. Implemented by the script with the Admin SDK. */
  writeCustomClaims(uid: string, claims: Claims): Promise<void>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export interface ClaimStorePort {
  readUsersDocRole(uid: string): Promise<string | null>;
  /**
   * Resolves with the write's SERVER commit time (Firestore
   * `WriteResult.writeTime`). The write MUST change the document every time
   * (it sets `updatedAt: serverTimestamp()`), because Firestore reports a
   * no-op write with the document's previous update time.
   */
  writeUsersDocRole(uid: string, role: "admin" | "user"): Promise<ServerTime>;
  /** MUST be create-only (`.doc(id).create()`); an existing id must fail. Resolves with the server commit time. */
  createAuditRow(docId: string, record: Record<string, unknown>): Promise<ServerTime>;
}

export type ExecutionDeps<TS> = {
  auth: ClaimAuthPort;
  store: ClaimStorePort;
  timestampNow: () => TS;
  /**
   * The operator machine's clock (ms since epoch) — the SAME clock
   * revokeRefreshTokens stamps validSince from. Read only by the G3 clock gate
   * (around the attempt row) and the G2 pre-call check (immediately before the
   * call).
   */
  nowMs: () => number;
  /**
   * Waits `ms` milliseconds (a timer, not a clock reading). Used only to let
   * the operator's clock — which revokeRefreshTokens stamps — pass the
   * server-anchored cutoff before the revocation call. Never evidence.
   */
  sleepMs: (ms: number) => Promise<void>;
  /** Resolves the operator token file to a token, or refuses (mode/shape). */
  readOperatorToken: (path: string) => Promise<{ ok: true; token: string } | Refusal>;
  git: { sha: string | null; dirty: boolean | null };
  log: (line: string) => void;
};

export type ExecutionContext = {
  args: ParsedClaimArgs;
  projectId: string;
  requestId: string;
  credential: Pick<ServiceAccountEvidence, "source" | "clientEmailMasked">;
};

export type RunStatus =
  | "dry_run"
  | "no_change"
  | "applied"
  | "claim_already_absent_revocation_cutoff_observed"
  | "review_required"
  | "refused"
  | "incomplete";

export type RunResult = {
  status: RunStatus;
  /**
   * 0 completed: claims read back as planned; on revoke, revocation
   *   requested and acknowledged, cutoff observed (under the clock assumption,
   *   not proof) and the read-back not lower than the values read earlier in
   *   the run — effective revocation is not observable; or a grant already in
   *   place (no_change);
   * 2 refused or dry run: NO write call was issued (guaranteed);
   * 3 a write call was issued (possibly only the attempt audit row, outcome
   *   unknown) and the operation is incomplete or unverified (see RERUN_GUIDANCE);
   * 4 review required, do not re-run blindly: the cutoff was lowered within
   *   the run, or the call was skipped because the stored value is ahead
   *   (REVIEW_GUIDANCE). Precedence 3 > 4 > 0.
   */
  exitCode: 0 | 2 | 3 | 4;
  code: RefusalCode | PostWriteFailure | ReviewRequiredOutcome | null;
  outcome: AuditOutcome | null;
  message: string | null;
  requestId: string;
  projectId: string;
  operation: ParsedClaimArgs["operation"];
  targetUid: string;
  /** Masked (the local result file never holds the full target email; the audit row does). */
  targetEmailMasked: string | null;
  /** Every executed revoke REQUESTS refresh-token revocation (unless G2/G3 stop it); grant never does. */
  sessionRevocation: "required" | "not_applicable";
  /** Executed revoke only (null otherwise). Mirrors sessionRevocationObservations when those exist. */
  sessionRevocationState: SessionRevocationState | null;
  /** Executed revoke only: always "not_observable". */
  effectiveRevocation: typeof EFFECTIVE_REVOCATION | null;
  /**
   * Revoke --execute past the attempt row: the revocation API acknowledgment,
   * the observed cutoff, the clock assumption it rests on, and the
   * enforcement caveat.
   */
  sessionRevocationObservations: SessionRevocationObservations | null;
  claimWrite: ClaimWritePlan | null;
  plan: { before: Claims; after: Claims; diff: string[] } | null;
  /** null whenever the post-write read-back did not succeed (never a fabricated `{}`). */
  readBackClaims: Claims | null;
  /** `after` is null both for "no role" and "could not read": `readBack.usersDocRole` disambiguates. */
  usersDocRole: { before: string | null; after: string | null };
  /** Whether each post-write read actually returned data; "not_attempted" when no write ran. */
  readBack: { customClaims: ReadOutcome | "not_attempted"; usersDocRole: ReadOutcome | "not_attempted" };
  /** Every failure (and review fact) recorded on a non-zero run, in order (the `code` is the first of the winning class). */
  failureDetails: string[];
  authorization: { mode: AuthorizationMode | "not_evaluated"; operatorUid: string | null; operatorEmailMasked: string | null };
  expectedConfirmation: string | null;
  /** Rows created and confirmed. */
  auditRowIds: string[];
  /** Rows whose create call failed: they may or may not exist. */
  auditRowIdsUnconfirmed: string[];
  writesAttempted: string[];
  git: { sha: string | null; dirty: boolean | null };
};

const LIST_PAGE = 1000;

async function listAllUsers(auth: ClaimAuthPort): Promise<UserRecordLike[]> {
  const all: UserRecordLike[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(LIST_PAGE, pageToken);
    all.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return all;
}

function errorCode(e: unknown): unknown {
  return e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
}

export async function runSystemAdminClaim<TS>(ctx: ExecutionContext, deps: ExecutionDeps<TS>): Promise<RunResult> {
  const { args } = ctx;
  const result: RunResult = {
    status: "refused",
    exitCode: 2,
    code: null,
    outcome: null,
    message: null,
    requestId: ctx.requestId,
    projectId: ctx.projectId,
    operation: args.operation,
    targetUid: args.targetUid,
    targetEmailMasked: null,
    sessionRevocation: args.operation === "revoke" ? "required" : "not_applicable",
    sessionRevocationState: null,
    effectiveRevocation: null,
    sessionRevocationObservations: null,
    claimWrite: null,
    plan: null,
    readBackClaims: null,
    usersDocRole: { before: null, after: null },
    readBack: { customClaims: "not_attempted", usersDocRole: "not_attempted" },
    failureDetails: [],
    authorization: { mode: "not_evaluated", operatorUid: null, operatorEmailMasked: null },
    expectedConfirmation: null,
    auditRowIds: [],
    auditRowIdsUnconfirmed: [],
    writesAttempted: [],
    git: deps.git,
  };
  const refused = (r: Refusal): RunResult => {
    result.status = "refused";
    result.exitCode = 2;
    result.code = r.code;
    result.message = r.message;
    return result;
  };

// --- pre-execution: the tool's own source must be committed -------------
  if (args.execute && (deps.git.sha === null || deps.git.dirty !== false)) {
    return refused(refuse(
      "dirty_tree",
      "Refusing --execute: the git commit could not be determined, or scripts/admin or lib/admin has uncommitted changes. Run from a clean, committed checkout.",
    ));
  }

  // --- target ----------------------------------------------------------------
  let target: UserRecordLike;
  try {
    target = await deps.auth.getUser(args.targetUid);
  } catch (e) {
    const code = errorCode(e);
    if (code === "auth/user-not-found") return refused(refuse("target_missing", "Refusing: no Auth user has that UID in this project."));
    return refused(refuse("target_lookup_failed", `Refusing: target lookup failed (${typeof code === "string" ? code : "unknown error"}).`));
  }
  // Grant refuses a disabled target; revoke (privilege removal) allows one. Nothing here ever changes `disabled`.
  const targetRefusal = checkTargetRecord(target, args.targetUid, args.operation);
  if (targetRefusal) return refused(targetRefusal);
  const targetEmail = typeof target.email === "string" ? target.email : null;
  result.targetEmailMasked = targetEmail ? maskEmail(targetEmail) : null;
  const preWriteTokensValidAfterTime = typeof target.tokensValidAfterTime === "string" ? target.tokensValidAfterTime : null;
  // N1: the pre-run value as read (any type). When it is present, an absent
  // fresh pre-call value is not "never set" and the call is refused.
  const preWriteTokensValidAfterTimeRaw: unknown = target.tokensValidAfterTime;
  if (args.operation === "revoke" && target.disabled === true) {
    deps.log("Target state:   DISABLED - the admin claim is still removed and refresh-token revocation is still requested; the account stays disabled.");
  }

  try {
    result.usersDocRole.before = await deps.store.readUsersDocRole(args.targetUid);
  } catch {
    return refused(refuse("users_doc_read_failed", "Refusing: could not read users/{uid}."));
  }

  // --- plan ------------------------------------------------------------------
  const planned = planClaimChange(target.customClaims, args.operation);
  if (!planned.ok) return refused(planned);
  const plan: ClaimPlan = planned.plan;
  result.plan = { before: plan.before, after: plan.after, diff: formatDiff(plan) };
  const invariant = checkPlanInvariants(plan);
  if (invariant) return refused(invariant);
  const intendedRole: "admin" | "user" = args.operation === "grant" ? "admin" : "user";

  deps.log(`Project:        ${ctx.projectId}`);
  deps.log(`Target UID:     ${args.targetUid}`);
  deps.log(`Operation:      ${args.operation}`);
  deps.log(`Current claims: ${JSON.stringify(plan.before)}`);
  deps.log(`Intended:       ${JSON.stringify(plan.after)}`);
  for (const line of result.plan.diff) deps.log(`  ${line}`);
  deps.log(`users/{uid}.role: ${JSON.stringify(result.usersDocRole.before)} -> "${intendedRole}"`);

  // --- authorization ---------------------------------------------------------
  let authorization: AuthorizationMode | null = null;
  let operatorUid: string | null = null;
  let operatorEmail: string | undefined;
  let allUsers: UserRecordLike[] | null = null;
  const enumerate = async (): Promise<UserRecordLike[] | Refusal> => {
    if (allUsers) return allUsers;
    try {
      allUsers = await listAllUsers(deps.auth);
      return allUsers;
    } catch {
      return refuse("admin_enumeration_failed", "Refusing: could not enumerate users to count admin holders.");
    }
  };

  if (args.bootstrapFirstAdmin) {
    const users = await enumerate();
    if (!Array.isArray(users)) return refused(users);
    const b = checkBootstrapFirstAdmin(countAdminHolders(users, { enabledOnly: false }));
    if (b) return refused(b);
    authorization = "first-admin-bootstrap";
  } else if (args.operatorIdTokenFile !== null) {
    const read = await deps.readOperatorToken(args.operatorIdTokenFile);
    if (!read.ok) return refused(read);
    let decoded: DecodedTokenLike;
    try {
      decoded = await deps.auth.verifyIdToken(read.token, true);
    } catch (e) {
      return refused(classifyOperatorTokenError(errorCode(e)));
    }
    let live: UserRecordLike;
    try {
      live = await deps.auth.getUser(decoded.uid);
    } catch {
      return refused(refuse("operator_not_system_admin", "Refusing: the operator's live Auth record could not be read."));
    }
    const a = checkOperatorAuthorization(decoded, live);
    if (a) return refused(a);
    authorization = "operator-id-token";
    operatorUid = decoded.uid;
    operatorEmail = typeof live.email === "string" ? live.email : undefined;
  } else if (args.execute) {
    return refused(refuse(
      "operator_token_missing",
      "Refusing --execute: pass --operator-id-token-file=<file holding a SYSTEM_ADMIN ID token>, or --bootstrap-first-admin when no admin exists.",
    ));
  }
  result.authorization = {
    mode: authorization ?? "not_evaluated",
    operatorUid,
    operatorEmailMasked: operatorEmail ? maskEmail(operatorEmail) : null,
  };
  deps.log(`Authorization:  ${result.authorization.mode}${operatorUid ? ` (operator uid ${operatorUid})` : ""}`);

  if (args.operation === "revoke" && plan.targetIsAdminBefore) {
    const users = await enumerate();
    if (!Array.isArray(users)) return refused(users);
    const r = checkRevokeSafety({
      targetUid: args.targetUid,
      operatorUid,
      targetIsAdminBefore: plan.targetIsAdminBefore,
      enabledAdminHoldersExcludingTarget: countAdminHolders(users, { enabledOnly: true, excludeUid: args.targetUid }),
    });
    if (r) return refused(r);
  }

  // --- no change (grant only) -------------------------------------------------
  // A revoke whose claim is already absent is NOT "no change": the session
  // revocation may be outstanding (e.g. a previous run ended with
  // sessions_revoke_failed), so it continues below as a sessions-only run.
  const sessionsOnly = args.operation === "revoke" && !plan.changed;
  if (!plan.changed && !sessionsOnly) {
    result.status = "no_change";
    result.exitCode = 0;
    result.code = null;
    result.message = "No change: the claims already match the intended state. Nothing was written.";
    if (result.usersDocRole.before !== intendedRole) {
      result.message += ` Note: users/{uid}.role is ${JSON.stringify(result.usersDocRole.before)} (display-only mirror; this tool does not repair it on a no-change run).`;
    }
    deps.log(result.message);
    return result;
  }
  const claimWrite: ClaimWritePlan = sessionsOnly ? "skip_already_absent" : "write";
  result.claimWrite = claimWrite;
  if (sessionsOnly) {
    deps.log("Claim write:    SKIPPED - the admin claim is already absent; claims will NOT be rewritten.");
  }
  if (args.operation === "revoke") {
    deps.log(REVOKE_SESSIONS_PLAN_LINE);
  }

  const expected = expectedConfirmation({ operation: args.operation, projectId: ctx.projectId, targetUid: args.targetUid });

  // --- dry run (default) -----------------------------------------------------
  if (!args.execute) {
    result.status = "dry_run";
    result.exitCode = 2;
    result.expectedConfirmation = expected;
    result.message = "Dry run: nothing was written to Firebase.";
    deps.log(result.message);
    deps.log(`To apply, re-run with --execute --confirm-claim=${expected}${authorization ? "" : " and an authorization flag"}`);
    return result;
  }

  const c = checkConfirmation(args.confirmClaim, expected);
  if (c) return refused(c);
  if (authorization === null) {
    // Unreachable given the branch above; kept so a refactor cannot reach a write unauthorised.
    return refused(refuse("operator_token_missing", "Refusing --execute without an authorization mode."));
  }

  // --- execute ---------------------------------------------------------------
  // From here on every exit is 0 (completed), 3 (a write call was issued and
  // the operation is incomplete) or 4 (review required). Never 2.
  const auditBase = {
    requestId: ctx.requestId,
    projectId: ctx.projectId,
    operation: args.operation,
    authorization,
    adminUid: operatorUid ?? "operator-bootstrap",
    adminEmail: operatorEmail,
    targetUid: args.targetUid,
    targetEmail: targetEmail ?? undefined,
    beforeClaims: plan.before,
    usersDocRoleBefore: result.usersDocRole.before,
    claimWrite,
    credentialSource: ctx.credential.source,
    credentialClientEmailMasked: ctx.credential.clientEmailMasked,
    gitSha: deps.git.sha as string,
    confirmClaim: expected,
  };
  const isRevoke = args.operation === "revoke";
  if (isRevoke) {
    result.sessionRevocationState = "NOT_REQUESTED";
    result.effectiveRevocation = EFFECTIVE_REVOCATION;
  }

  // The FIRST exit-3 failure is the run's code; the first review fact is the
  // exit-4 code when no failure exists (precedence 3 > 4 > 0). EVERY failure
  // and review fact is kept as a detail so a later one is never hidden behind
  // an earlier one. (`as` keeps TypeScript from narrowing to null: they are
  // assigned in closures.)
  let failure = null as PostWriteFailure | null;
  let review = null as ReviewRequiredOutcome | null;
  const details = result.failureDetails;
  const recordFailure = (code: PostWriteFailure, detail: string): void => {
    if (!failure) failure = code;
    details.push(`${code}: ${detail}`);
  };
  const recordReview = (code: ReviewRequiredOutcome, detail: string): void => {
    if (!review) review = code;
    details.push(`${code}: ${detail}`);
  };
  const codeOf = (e: unknown): string => {
    const code = errorCode(e);
    return typeof code === "string" ? code : "unknown error";
  };

  const attemptId = auditDocId(ctx.requestId, "attempt");
  result.writesAttempted.push("audit_attempt_row");
  let attemptCommitTime: unknown = null;
  const localBeforeMs = deps.nowMs();
  try {
    attemptCommitTime = await deps.store.createAuditRow(attemptId, buildClaimAuditRecord({
      ...auditBase,
      phase: "attempt",
      createdAt: deps.timestampNow(),
      afterClaims: plan.after,
      usersDocRoleAfter: intendedRole,
    }));
  } catch {
    // The create call was issued; whether the row exists is unknown. This is
    // an incomplete WRITE outcome (exit 3), not a refusal: nothing guarantees
    // that zero database writes happened.
    result.auditRowIdsUnconfirmed.push(attemptId);
    details.push("audit_attempt_failed: attempt audit row creation failed; the row may or may not exist. No claim, role or revocation call was issued");
    return incomplete(result, "audit_attempt_failed", null, deps);
  }
  const localAfterMs = deps.nowMs();
  result.auditRowIds.push(attemptId);

  // G3: the operator clock must agree with Firestore's commit time (within the
  // margin, widened by the measured latency) BEFORE any claim, role or
  // revocation call. On failure only the outcome row follows.
  const gate = checkOperatorClock({ localBeforeMs, localAfterMs, commit: attemptCommitTime, marginSeconds: REVOCATION_SKEW_MARGIN_SECONDS });
  const clockOk = gate.ok;
  if (!gate.ok) recordFailure("operator_clock_out_of_tolerance", gate.detail);

  let claimWriteOk = true;
  if (clockOk && claimWrite === "write") {
    result.writesAttempted.push("custom_claims");
    try {
      await deps.auth.writeCustomClaims(args.targetUid, plan.after);
    } catch (e) {
      claimWriteOk = false;
      recordFailure("mint_failed", `custom claim write failed (${codeOf(e)})`);
    }
  }

  // Role mirror. On revoke its commit time is the server-time anchor, so it is
  // issued only AFTER the claim write returned.
  let anchor: ServerTime | null = null;
  let anchorProblem: string | null = null;
  if (clockOk && claimWriteOk) {
    result.writesAttempted.push("users_doc_role");
    try {
      const commit = await deps.store.writeUsersDocRole(args.targetUid, intendedRole);
      const a = checkRevocationAnchor(commit, attemptCommitTime);
      if (a.ok) anchor = a.anchor;
      else anchorProblem = a.detail;
    } catch (e) {
      anchorProblem = "the role write (the server-time anchor) failed";
      recordFailure("users_doc_failed", `users/{uid}.role write failed (${codeOf(e)})`);
    }
  }

  let revokeCalled = false;
  let revokeOk = false;
  let notCalledReason: string | null = gate.ok ? null : gate.detail;
  const preCall: PreCallCheck = { read: "not_attempted", tokensValidAfterTime: null, storedSeconds: null, localSeconds: null, decision: "not_reached" };
  const cutoff = anchor ? revocationCutoffSeconds(anchor) : null;
  // Owner policy: every revoke calls revokeRefreshTokens exactly once —
  // including one whose claim write threw (the write may have applied
  // server-side; that run stays INCOMPLETE, mint_failed first) — unless a
  // fresh read immediately before the call shows the stored value is later
  // than the value the call would write (G2), or that fresh read fails. The
  // call overwrites validSince; G2 narrows only this tool's own call.
  if (isRevoke && clockOk) {
    if (anchor && cutoff !== null) {
      // revokeRefreshTokens stamps validSince with the LOCAL clock; give an
      // accurate clock time to pass the cutoff. Waiting is not evidence — the
      // read-back below is the observation.
      const anchorMs = anchor.seconds * 1000 + Math.floor(anchor.nanoseconds / 1e6);
      await deps.sleepMs(Math.max(0, cutoff * 1000 - anchorMs + REVOCATION_SLEEP_SLACK_MS));
    }
    // G2: a FRESH read, immediately before the call. The pre-run read is too
    // early, and nothing is assumed when this read fails: no call then.
    // Whatever a read that did not throw resolved to — including undefined,
    // null or a malformed record — goes through checkPreCallCutoff, which
    // fails closed on anything it cannot compare (m-1: no bypass branch).
    let fresh: UserRecordLike | null | undefined = null;
    let freshResolved = false;
    try {
      fresh = await deps.auth.getUser(args.targetUid);
      freshResolved = true;
      preCall.read = "read";
    } catch (e) {
      preCall.read = "failed";
      preCall.decision = "refuse_read_failed";
      notCalledReason = `the fresh Auth read immediately before revokeRefreshTokens failed (${codeOf(e)}); the call was NOT made (no earlier or assumed value is used)`;
      recordFailure("pre_call_read_failed", notCalledReason);
    }
    if (freshResolved) {
      preCall.tokensValidAfterTime = fresh && typeof fresh === "object" && typeof fresh.tokensValidAfterTime === "string" ? fresh.tokensValidAfterTime : null;
      const pc = checkPreCallCutoff(fresh, args.targetUid, deps.nowMs(), preWriteTokensValidAfterTimeRaw);
      preCall.storedSeconds = pc.storedSeconds;
      preCall.localSeconds = pc.localSeconds;
      preCall.decision = pc.decision;
      if (pc.decision === "call") {
        result.writesAttempted.push("revoke_refresh_tokens");
        revokeCalled = true;
        try {
          await deps.auth.revokeRefreshTokens(args.targetUid);
          revokeOk = true;
        } catch (e) {
          recordFailure("sessions_revoke_failed", `refresh-token revocation failed (${codeOf(e)}); the effect is UNKNOWN (it may have applied)`);
        }
      } else if (pc.decision === "skip_stored_ahead") {
        notCalledReason = pc.detail;
        recordReview("stored_cutoff_ahead", pc.detail);
      } else {
        notCalledReason = `${pc.detail}; the call was NOT made`;
        recordFailure("pre_call_read_failed", notCalledReason);
      }
    }
  }

  // --- read back (always, after any write attempt) ---------------------------
  // A read that throws leaves its field UNKNOWN (null + "failed"); it is never
  // replaced by an empty snapshot, and it is always recorded as a failure
  // detail even when an earlier step already failed.
  // N2: a read-back is evidence only when it is the TARGET's record (string
  // uid === targetUid). Anything else is UNKNOWN (readBack = null), recorded
  // as verification_failed: never an observation, never "applied".
  let readBack: UserRecordLike | null = null;
  try {
    const rb: unknown = await deps.auth.getUser(args.targetUid);
    const rbUid: unknown = rb && typeof rb === "object" ? (rb as { uid?: unknown }).uid : undefined;
    if (typeof rbUid === "string" && rbUid === args.targetUid) {
      readBack = rb as UserRecordLike;
      result.readBackClaims = readBack.customClaims && typeof readBack.customClaims === "object"
        ? { ...(readBack.customClaims as Claims) }
        : {};
      result.readBack.customClaims = "read";
    } else {
      readBack = null;
      result.readBackClaims = null;
      result.readBack.customClaims = "failed";
      recordFailure("verification_failed", typeof rbUid === "string"
        ? "read-back returned a different account (its uid is not the target's); claims and tokensValidAfterTime after this run are UNKNOWN"
        : "read-back identity unknown (no record, or a record without a string uid); claims and tokensValidAfterTime after this run are UNKNOWN");
    }
  } catch (e) {
    readBack = null;
    result.readBackClaims = null;
    result.readBack.customClaims = "failed";
    recordFailure("verification_failed", `read-back failed: target Auth record could not be read (${codeOf(e)}); claims after this run are UNKNOWN`);
  }
  try {
    result.usersDocRole.after = await deps.store.readUsersDocRole(args.targetUid);
    result.readBack.usersDocRole = "read";
  } catch (e) {
    result.usersDocRole.after = null;
    result.readBack.usersDocRole = "failed";
    recordFailure("verification_failed", `read-back failed: users/{uid}.role could not be read (${codeOf(e)}); role after this run is UNKNOWN`);
  }
  if (!failure && readBack) {
    const v = verifyReadBack(plan, readBack.customClaims);
    if (!v.ok) {
      recordFailure("verification_failed", v.detail);
    } else if (result.usersDocRole.after !== intendedRole) {
      recordFailure("verification_failed", "users/{uid}.role read-back mismatch");
    }
  }

  // --- session revocation observations (revoke) ------------------------------
  // Exit 0 requires: the revocation call returned, a server-time anchor, a
  // read-back tokensValidAfterTime at or after the server-anchored cutoff
  // (cutoff observed — under REVOCATION_CLOCK_ASSUMPTION, never proof), and a
  // read-back not lower than any value read earlier in the run.
  if (isRevoke) {
    const after = readBack && typeof readBack.tokensValidAfterTime === "string" ? readBack.tokensValidAfterTime : null;
    // Values known earlier in the run: the pre-run read, the fresh pre-call
    // read and, after an acknowledged call, the V it was cleared to write.
    const earlierValues: unknown[] = [preWriteTokensValidAfterTime, preCall.tokensValidAfterTime];
    if (revokeOk && preCall.localSeconds !== null) earlierValues.push(preCall.localSeconds);
    const obs: SessionRevocationObservations = {
      sessionRevocationState: "NOT_REQUESTED",
      effectiveRevocation: EFFECTIVE_REVOCATION,
      claimWrite: !clockOk ? "not_attempted" : claimWrite === "skip_already_absent" ? "skipped_already_absent" : claimWriteOk ? "confirmed" : "unconfirmed",
      revocationRequested: revokeCalled,
      revocationApiAcknowledged: revokeOk,
      anchorSource: "firestore-commit-time:users/{uid}.role",
      anchorServerTime: anchor ? serverTimeIso(anchor) : null,
      marginSeconds: REVOCATION_SKEW_MARGIN_SECONDS,
      cutoff: cutoff !== null ? new Date(cutoff * 1000).toISOString() : null,
      tokensValidAfterTimeBefore: preWriteTokensValidAfterTime,
      preCallCheck: preCall,
      tokensValidAfterTimeAfter: after,
      tokensValidAfterTimeLowerThanBefore: validSinceLowerThanBefore(earlierValues, after),
      validSinceMinusAnchorSeconds: null,
      cutoffObserved: false,
      clockAlignmentAssumption: REVOCATION_CLOCK_ASSUMPTION,
      currentPrivilegeEnforcement: CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
      detail: null,
    };
    let state: SessionRevocationState;
    let unverified: string | null = null;
    if (!revokeCalled) {
      state = "NOT_REQUESTED";
    } else if (!revokeOk) {
      state = "REQUESTED_UNACKNOWLEDGED";
      unverified = claimWriteOk
        ? "the revocation call failed or threw; its effect is UNKNOWN"
        : "the claim write threw and is UNCONFIRMED (it may have applied server-side); revokeRefreshTokens was still called and failed or threw (effect UNKNOWN)";
    } else if (!claimWriteOk) {
      state = "ACKNOWLEDGED_UNOBSERVED";
      unverified = "the claim write threw and is UNCONFIRMED (it may have applied server-side); revokeRefreshTokens was still called and acknowledged as a privilege-removal measure, but no server-time anchor was taken, so no cutoff was observed";
      recordFailure("sessions_revoke_unverified", unverified);
    } else if (!anchor || cutoff === null) {
      state = "ACKNOWLEDGED_UNOBSERVED";
      unverified = `no server-time anchor (${anchorProblem ?? "unknown"}): revokeRefreshTokens was acknowledged with the operator's local clock as validSince, and no cutoff could be observed`;
      recordFailure("sessions_revoke_unverified", unverified);
    } else if (!readBack) {
      state = "ACKNOWLEDGED_UNOBSERVED";
      unverified = "the Auth record could not be read back";
      recordFailure("sessions_revoke_unverified", "tokensValidAfterTime could not be read back");
    } else {
      const sv = observeRevocationCutoff(after, cutoff);
      if (sv.validSinceSeconds !== null) obs.validSinceMinusAnchorSeconds = sv.validSinceSeconds - anchor.seconds;
      if (sv.ok) {
        obs.cutoffObserved = true;
        const ahead = obs.validSinceMinusAnchorSeconds;
        if (typeof ahead === "number" && ahead > FAR_AHEAD_ANOMALY_SECONDS) {
          state = "CUTOFF_ANOMALY";
          unverified = `the read-back tokensValidAfterTime ${after} is ${ahead}s after the server-time anchor (more than ${FAR_AHEAD_ANOMALY_SECONDS}s), although this run's clock passed the ${REVOCATION_SKEW_MARGIN_SECONDS} s gate: another writer, or a clock step on this machine, is the likely source. Wherever revocation is checked, sessions the target starts before that time are rejected (over-revocation)`;
          recordFailure("sessions_revoke_unverified", unverified);
        } else {
          state = "CUTOFF_OBSERVED";
        }
      } else {
        state = sv.validSinceSeconds === null ? "CUTOFF_ANOMALY" : "CUTOFF_NOT_REACHED";
        unverified = sv.detail;
        recordFailure("sessions_revoke_unverified", sv.detail);
      }
    }
    let lowered: string | null = null;
    if (obs.tokensValidAfterTimeLowerThanBefore === true) {
      // Any observed lowering is review-required (exit 4) — or exit 3 when the
      // run is already incomplete; both facts are recorded.
      lowered = validSinceLowerThanBeforeDetail(highestEarlierValue(earlierValues) as string, after as string);
      if (revokeCalled) state = "CUTOFF_LOWERED";
      recordReview("revocation_cutoff_lowered", lowered);
    }
    obs.sessionRevocationState = state;
    const parts = [notCalledReason, unverified, lowered].filter((p): p is string => p !== null);
    obs.detail = parts.length > 0 ? parts.join("; ") : null;
    result.sessionRevocationObservations = obs;
    result.sessionRevocationState = state;
  }

  // Executor backstop (mirrors the audit-row builder's): a revoke that would
  // otherwise exit 0 must show a revokeRefreshTokens call that was made and
  // returned, and state CUTOFF_OBSERVED. Anything else is exit 3, recorded
  // BEFORE the outcome row so the exit code, message and row agree.
  if (isRevoke && !failure && !review) {
    const blocker = revokeExitZeroBlocker({ revokeCalled, revokeOk, observations: result.sessionRevocationObservations });
    if (blocker !== null) recordFailure("sessions_revoke_unverified", blocker);
  }

  const outcome: AuditOutcome = failure ?? review ?? (sessionsOnly ? "claim_already_absent_revocation_cutoff_observed" : "applied");
  const outcomeId = auditDocId(ctx.requestId, "outcome");
  result.writesAttempted.push("audit_outcome_row");
  try {
    await deps.store.createAuditRow(outcomeId, buildClaimAuditRecord({
      ...auditBase,
      phase: "outcome",
      outcome,
      outcomeDetails: [...details],
      sessionRevocationObservations: result.sessionRevocationObservations,
      createdAt: deps.timestampNow(),
      afterClaims: result.readBack.customClaims === "read" ? result.readBackClaims : null,
      usersDocRoleAfter: result.usersDocRole.after,
      readBack: {
        customClaims: result.readBack.customClaims === "read" ? "read" : "failed",
        usersDocRole: result.readBack.usersDocRole === "read" ? "read" : "failed",
      },
    }));
    result.auditRowIds.push(outcomeId);
  } catch {
    result.auditRowIdsUnconfirmed.push(outcomeId);
    recordFailure("audit_outcome_missing", "outcome audit row creation failed; the row may or may not exist");
    deps.log(`AUDIT OUTCOME MISSING for ${ctx.requestId}: reconcile from the local result file and the attempt row.`);
  }

  // Precedence 3 > 4 > 0: an exit-4 fact never hides an incomplete run, and
  // never becomes exit 0.
  if (failure) return incomplete(result, failure, review, deps);
  if (review) return reviewRequired(result, review, deps);

  result.outcome = outcome;
  result.exitCode = 0;
  result.code = null;
  if (outcome === "claim_already_absent_revocation_cutoff_observed") {
    result.status = "claim_already_absent_revocation_cutoff_observed";
    result.message = `Completed: the admin claim was already absent, so no claim was written. ${revocationSummary(result.sessionRevocationObservations)}`;
  } else {
    result.status = "applied";
    result.message = args.operation === "grant"
      ? "Applied: the claims read back as planned. The user must obtain a fresh ID token (sign out and in) before the claim is visible."
      : `Applied: the admin claim was removed (read back as planned). ${revocationSummary(result.sessionRevocationObservations)}`;
  }
  deps.log(result.message);
  return result;
}

/**
 * The executor's exit-0 invariant for a revoke. Returns why the run may NOT
 * exit 0, or null when it may: revokeRefreshTokens was called, the call
 * returned, the observations record both, and the state is CUTOFF_OBSERVED
 * with the cutoff observed. Never consulted for a grant.
 */
export function revokeExitZeroBlocker(input: {
  revokeCalled: boolean;
  revokeOk: boolean;
  observations: SessionRevocationObservations | null;
}): string | null {
  const obs = input.observations;
  const facts = `call made: ${input.revokeCalled}; call returned: ${input.revokeOk}; state: ${obs ? obs.sessionRevocationState : "none recorded"}`;
  const ok = input.revokeCalled === true
    && input.revokeOk === true
    && obs !== null
    && obs.revocationRequested === true
    && obs.revocationApiAcknowledged === true
    && obs.cutoffObserved === true
    && obs.sessionRevocationState === "CUTOFF_OBSERVED";
  return ok
    ? null
    : `a revoke completes only when revokeRefreshTokens was called and returned and the cutoff was observed (state CUTOFF_OBSERVED); this run does not show that (${facts}), so it is NOT complete`;
}

/**
 * The exit-0 revoke text: (a) request and acknowledgment, (b) observed cutoff,
 * (c) the clock assumption, effective revocation not observable, (d) the
 * enforcement caveat. Never phrased as proof or as an effect.
 */
export function revocationSummary(ev: SessionRevocationObservations | null): string {
  const observed = ev ? ` (read-back tokensValidAfterTime ${ev.tokensValidAfterTimeAfter}; server-anchored cutoff ${ev.cutoff})` : "";
  return `Sessions: ${REVOCATION_OBSERVED_SUMMARY}${observed}. ${REVOCATION_CLOCK_ASSUMPTION} ${CURRENT_PRIVILEGE_ENFORCEMENT_NOTE}`;
}

/**
 * Added to the wait before revoking, so an operator clock up to about this far
 * BEHIND server time still stamps validSince at or after the cutoff. It only
 * sets tolerance; it is never evidence (the read-back is).
 */
export const REVOCATION_SLEEP_SLACK_MS = 1500;
/**
 * A read-back more than this far after the anchor is CUTOFF_ANOMALY (exit 3):
 * a clock that passed the G3 gate cannot stamp it, so another writer or a
 * clock step is the likely source.
 */
export const FAR_AHEAD_ANOMALY_SECONDS = 300;

/**
 * Re-run guidance printed on every exit-3 outcome. It does not present a re-run
 * as free of risk: a revoke re-run calls revokeRefreshTokens again, which
 * overwrites validSince.
 */
export const RERUN_GUIDANCE =
  "Re-running the same command never re-applies a claim already in place and never changes any other claim. A revoke re-run calls revokeRefreshTokens again (with no claim write when the admin claim is already absent) unless a fresh read immediately before the call shows a stored value later than this machine's clock (then exit 4 and no call) or that fresh read is unusable, for example when it fails, returns no record or another account's record, has a value that is not a date, or has no value although the earlier read in the run had one (then no call, and exit 3: pre_call_read_failed, or an earlier exit-3 code such as mint_failed when one already occurred). The call OVERWRITES validSince with this machine's clock and does not keep the later value: this tool refuses to write a value lower than the one it reads immediately before the call, but another writer between that read and the call, or after the run, can still lower it. Sync this machine's clock (NTP) before re-running, and read sessionRevocationObservations afterwards.";

/** Guidance printed on every exit-4 outcome: review, never a blind re-run. */
export const REVIEW_GUIDANCE =
  "Exit 4 means review required: do not re-run this command blindly, and do not treat it as done. Compare tokensValidAfterTimeBefore, preCallCheck and tokensValidAfterTimeAfter in sessionRevocationObservations, find out what wrote the stored value (another operator, the Firebase console, another Admin SDK caller, or a fast clock), and decide with the owner. A re-run from a synced clock does not restore a higher value that was lost, and this tool has no mode that writes a lower cutoff.";

/** The dry-run / pre-execute sessions line for every revoke: the request and its limits, never an effect. */
export const REVOKE_SESSIONS_PLAN_LINE =
  `Sessions:       revokeRefreshTokens WILL be requested for the target (mandatory on revoke) unless a fresh read just before the call shows a stored cutoff later than this machine's clock (exit 4, no call) or is unusable, including no value although the earlier read in the run had one (exit 3, no call). The request can fail; it overwrites validSince with this machine's clock (sync it first: NTP; the run stops before any claim write if this clock is more than about ${REVOCATION_SKEW_MARGIN_SECONDS} s (plus the measured request latency) off Firestore server time); it does not end already-issued ID tokens (up to about 1 hour) and is not a sign-out from every device.`;

function incomplete<TS>(result: RunResult, code: PostWriteFailure, review: ReviewRequiredOutcome | null, deps: ExecutionDeps<TS>): RunResult {
  result.status = "incomplete";
  result.exitCode = 3;
  result.code = code;
  result.outcome = code;
  const unknown = result.readBack.customClaims === "failed" || result.readBack.usersDocRole === "failed"
    ? " The post-write read-back FAILED: the resulting state is UNKNOWN, not empty."
    : "";
  const alsoReview = review
    ? ` A review fact was ALSO recorded (${review}): read it before re-running. ${REVIEW_GUIDANCE}`
    : "";
  result.message = `INCOMPLETE (${code}). Failures: ${result.failureDetails.join("; ") || code}.${unknown}${alsoReview} A write was attempted and the operation is not complete; inspect the read-back before assuming either state. ${RERUN_GUIDANCE}`;
  deps.log(result.message);
  return result;
}

function reviewRequired<TS>(result: RunResult, code: ReviewRequiredOutcome, deps: ExecutionDeps<TS>): RunResult {
  result.status = "review_required";
  result.exitCode = 4;
  result.code = code;
  result.outcome = code;
  result.message = `REVIEW REQUIRED (${code}). ${result.failureDetails.join("; ")}. ${REVIEW_GUIDANCE}`;
  deps.log(result.message);
  return result;
}
