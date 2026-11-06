/**
 * SYSTEM_ADMIN claim operator tool: orchestration over injected ports.
 *
 * `scripts/admin/set-system-admin-claim.ts` wires real Firebase Admin objects
 * into these ports; the tests wire call-counting fakes. This module imports no
 * Firebase code and reads no environment, so the write ordering below is
 * pinned by tests rather than asserted in prose.
 *
 * Write ordering on --execute (fail closed):
 *   1. create the `attempt` audit row (create-only). If that call fails the
 *      row's existence is UNKNOWN: no further write is issued and the run is
 *      INCOMPLETE (exit 3, `audit_attempt_failed`), never "nothing written".
 *   2. write the custom claims — skipped on a revoke whose `admin` claim is
 *      already absent (a re-run): claims are never rewritten then.
 *   3. mirror `users/{uid}.role` (display-only field used by the admin UI).
 *      On revoke this write is ALSO the server-time anchor: its Firestore
 *      commit time is a server timestamp taken after the claim write returned
 *      (see observeRevocationCutoff in systemAdminClaimSafety.ts), so it is
 *      written on EVERY revoke, re-runs included.
 *   4. revoke: wait until the operator's clock should have passed the cutoff
 *      (anchor + 1 s + margin), then call revokeRefreshTokens ONCE (EVERY
 *      revoke; owner policy, no opt-out). Attempted even when step 3 failed,
 *      and even when the claim write in step 2 threw (it may have applied
 *      server-side) — such a run is INCOMPLETE (exit 3). The call OVERWRITES
 *      validSince with the operator's clock: it is not monotonic, and from a
 *      slow clock it can LOWER a value an earlier run stored (see (f) in
 *      systemAdminClaimSafety.ts; recorded, not prevented).
 *   5. read back (claims; role; for revoke, compare the server's
 *      tokensValidAfterTime with the server-anchored cutoff — an observation
 *      under REVOCATION_CLOCK_ASSUMPTION, not proof of revocation).
 *   6. create the `outcome` audit row (create-only).
 * A claim-write failure skips step 3 (and, on a grant, step 4 does not apply);
 * read-back and the outcome row still run so the evidence records what
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
  type Refusal,
  type ReadOutcome,
  type RefusalCode,
  type ServerTime,
  type ServiceAccountEvidence,
  type SessionRevocationEvidence,
  type UserRecordLike,
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  REVOCATION_CLOCK_ASSUMPTION,
  REVOCATION_OBSERVED_SUMMARY,
  REVOCATION_SKEW_MARGIN_SECONDS,
  auditDocId,
  validSinceMovedBackward,
  validSinceMovedBackwardDetail,
  buildClaimAuditRecord,
  checkBootstrapFirstAdmin,
  checkConfirmation,
  checkOperatorAuthorization,
  checkPlanInvariants,
  checkRevocationAnchor,
  checkRevokeSafety,
  checkTargetRecord,
  classifyOperatorTokenError,
  countAdminHolders,
  expectedConfirmation,
  formatDiff,
  maskEmail,
  planClaimChange,
  refuse,
  revocationCutoffSeconds,
  serverTimeIso,
  observeRevocationCutoff,
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
  | "claim_already_absent_sessions_revoked"
  | "refused"
  | "incomplete";

export type RunResult = {
  status: RunStatus;
  /**
   * 0 completed: claims read back as planned; on revoke, revocation
   *   acknowledged and cutoff observed (under the clock assumption, not proof);
   *   or a grant already in place (no_change);
   * 2 refused or dry run: NO write call was issued (guaranteed);
   * 3 a write call was issued (possibly only the attempt audit row, outcome
   *   unknown) and the operation is incomplete or unverified (see RERUN_GUIDANCE).
   */
  exitCode: 0 | 2 | 3;
  code: RefusalCode | PostWriteFailure | null;
  outcome: AuditOutcome | null;
  message: string | null;
  requestId: string;
  projectId: string;
  operation: ParsedClaimArgs["operation"];
  targetUid: string;
  /** Masked (the local result file never holds the full target email; the audit row does). */
  targetEmailMasked: string | null;
  /** Every executed revoke REQUESTS refresh-token revocation; grant never does. */
  sessionRevocation: "required" | "not_applicable";
  /**
   * Revoke --execute only: the revocation API acknowledgment, the observed
   * cutoff, the clock assumption it rests on, and the enforcement caveat.
   */
  sessionRevocationEvidence: SessionRevocationEvidence | null;
  claimWrite: ClaimWritePlan | null;
  plan: { before: Claims; after: Claims; diff: string[] } | null;
  /** null whenever the post-write read-back did not succeed (never a fabricated `{}`). */
  readBackClaims: Claims | null;
  /** `after` is null both for "no role" and "could not read": `readBack.usersDocRole` disambiguates. */
  usersDocRole: { before: string | null; after: string | null };
  /** Whether each post-write read actually returned data; "not_attempted" when no write ran. */
  readBack: { customClaims: ReadOutcome | "not_attempted"; usersDocRole: ReadOutcome | "not_attempted" };
  /** Every failure recorded on an incomplete run, in order (the `code` is the first). */
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
    sessionRevocationEvidence: null,
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
  // From here on every exit is 0 (completed: read-back matched; revoke also
  // acknowledged with the cutoff observed) or 3 (a write call was issued and
  // the operation is incomplete). Never 2.
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

  // The FIRST failure is the run's code; EVERY failure is kept as a detail so a
  // later failure (e.g. the read-back) is never hidden behind an earlier one.
  // (`as` keeps TypeScript from narrowing to null: it is assigned in a closure.)
  let failure = null as PostWriteFailure | null;
  const details = result.failureDetails;
  const recordFailure = (code: PostWriteFailure, detail: string): void => {
    if (!failure) failure = code;
    details.push(`${code}: ${detail}`);
  };
  const codeOf = (e: unknown): string => {
    const code = errorCode(e);
    return typeof code === "string" ? code : "unknown error";
  };

  const attemptId = auditDocId(ctx.requestId, "attempt");
  result.writesAttempted.push("audit_attempt_row");
  let attemptCommitTime: unknown = null;
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
    details.push("audit_attempt_failed: attempt audit row creation failed; the row may or may not exist. No claim, session or role write was issued");
    return incomplete(result, "audit_attempt_failed", deps);
  }
  result.auditRowIds.push(attemptId);

  let claimWriteOk = true;
  if (claimWrite === "write") {
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
  if (claimWriteOk) {
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

  let revokeOk = false;
  const cutoff = anchor ? revocationCutoffSeconds(anchor) : null;
  // EVERY revoke calls revokeRefreshTokens exactly once — including one whose
  // claim write threw (the write may have applied server-side). That run stays
  // INCOMPLETE (mint_failed first) because the claim write is unconfirmed and
  // no anchor was taken. The call is not access-reducing by construction: it
  // overwrites validSince, so from a slow clock it can lower an earlier value
  // (recorded below as tokensValidAfterTimeMovedBackward; not prevented).
  if (args.operation === "revoke") {
    if (anchor && cutoff !== null) {
      // revokeRefreshTokens stamps validSince with the LOCAL clock; give an
      // accurate clock time to pass the cutoff. Waiting is not evidence — the
      // read-back below is the observation.
      const anchorMs = anchor.seconds * 1000 + Math.floor(anchor.nanoseconds / 1e6);
      await deps.sleepMs(Math.max(0, cutoff * 1000 - anchorMs + REVOCATION_SLEEP_SLACK_MS));
    }
    result.writesAttempted.push("revoke_refresh_tokens");
    try {
      await deps.auth.revokeRefreshTokens(args.targetUid);
      revokeOk = true;
    } catch (e) {
      recordFailure("sessions_revoke_failed", `refresh-token revocation failed (${codeOf(e)})`);
    }
  }

  // --- read back (always, after any write attempt) ---------------------------
  // A read that throws leaves its field UNKNOWN (null + "failed"); it is never
  // replaced by an empty snapshot, and it is always recorded as a failure
  // detail even when an earlier step already failed.
  let readBack: UserRecordLike | null = null;
  try {
    readBack = await deps.auth.getUser(args.targetUid);
    result.readBackClaims = readBack.customClaims && typeof readBack.customClaims === "object"
      ? { ...(readBack.customClaims as Claims) }
      : {};
    result.readBack.customClaims = "read";
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

  // --- session revocation evidence (revoke) ----------------------------------
  // Success requires: the revocation call returned, a server-time anchor, and a
  // read-back tokensValidAfterTime at or after the server-anchored cutoff
  // (cutoff observed — under REVOCATION_CLOCK_ASSUMPTION, never proof).
  if (args.operation === "revoke") {
    const after = readBack && typeof readBack.tokensValidAfterTime === "string" ? readBack.tokensValidAfterTime : null;
    const evidence: SessionRevocationEvidence = {
      claimWrite: claimWrite === "skip_already_absent" ? "skipped_already_absent" : claimWriteOk ? "confirmed" : "unconfirmed",
      revocationApiAcknowledged: revokeOk,
      anchorSource: "firestore-commit-time:users/{uid}.role",
      anchorServerTime: anchor ? serverTimeIso(anchor) : null,
      marginSeconds: REVOCATION_SKEW_MARGIN_SECONDS,
      cutoff: cutoff !== null ? new Date(cutoff * 1000).toISOString() : null,
      tokensValidAfterTimeBefore: preWriteTokensValidAfterTime,
      tokensValidAfterTimeAfter: after,
      tokensValidAfterTimeMovedBackward: validSinceMovedBackward(preWriteTokensValidAfterTime, after),
      validSinceMinusAnchorSeconds: null,
      cutoffObserved: false,
      clockAlignmentAssumption: REVOCATION_CLOCK_ASSUMPTION,
      currentPrivilegeEnforcement: CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
      detail: null,
    };
    let unverified: string | null = null;
    if (!claimWriteOk) {
      unverified = revokeOk
        ? "the claim write threw and is UNCONFIRMED (it may have applied server-side); revokeRefreshTokens was still called and acknowledged as a privilege-removal measure, but no server-time anchor was taken, so no cutoff was observed"
        : "the claim write threw and is UNCONFIRMED (it may have applied server-side); revokeRefreshTokens was still called and failed";
      if (revokeOk) recordFailure("sessions_revoke_unverified", unverified);
    } else if (!revokeOk) {
      unverified = "the revocation call failed";
    } else if (!anchor || cutoff === null) {
      unverified = `no server-time anchor (${anchorProblem ?? "unknown"}): revokeRefreshTokens was acknowledged with the operator's local clock as validSince, and no cutoff could be observed`;
      recordFailure("sessions_revoke_unverified", unverified);
    } else if (!readBack) {
      unverified = "the Auth record could not be read back";
      recordFailure("sessions_revoke_unverified", "tokensValidAfterTime could not be read back");
    } else {
      const sv = observeRevocationCutoff(after, cutoff);
      if (sv.validSinceSeconds !== null) evidence.validSinceMinusAnchorSeconds = sv.validSinceSeconds - anchor.seconds;
      if (sv.ok) {
        evidence.cutoffObserved = true;
      } else {
        unverified = sv.detail;
        recordFailure("sessions_revoke_unverified", sv.detail);
      }
    }
    // (f) A backward move is never a clean success. On a run that is already
    // incomplete it is added as a failure detail; on a run whose cutoff was
    // observed (possible only when the stored value was AHEAD of this run's
    // cutoff, e.g. after a fast-clock run) it is printed as a WARNING below and
    // recorded in the evidence. Reporting only: nothing here changes a call.
    if (evidence.tokensValidAfterTimeMovedBackward === true) {
      const moved = validSinceMovedBackwardDetail(preWriteTokensValidAfterTime as string, after as string);
      if (failure) recordFailure("sessions_revoke_unverified", moved);
      evidence.detail = unverified ? `${unverified}; ${moved}` : moved;
    } else {
      evidence.detail = unverified;
    }
    result.sessionRevocationEvidence = evidence;
  }

  const outcome: AuditOutcome = failure ?? (sessionsOnly ? "claim_already_absent_sessions_revoked" : "applied");
  const outcomeId = auditDocId(ctx.requestId, "outcome");
  result.writesAttempted.push("audit_outcome_row");
  try {
    await deps.store.createAuditRow(outcomeId, buildClaimAuditRecord({
      ...auditBase,
      phase: "outcome",
      outcome,
      outcomeDetails: [...details],
      sessionRevocationEvidence: result.sessionRevocationEvidence,
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

  if (failure) return incomplete(result, failure, deps);

  result.outcome = outcome;
  result.exitCode = 0;
  result.code = null;
  if (outcome === "claim_already_absent_sessions_revoked") {
    result.status = "claim_already_absent_sessions_revoked";
    result.message = `Completed: the admin claim was already absent, so no claim was written. ${revocationSummary(result.sessionRevocationEvidence)}`;
  } else {
    result.status = "applied";
    result.message = args.operation === "grant"
      ? "Applied: the claims read back as planned. The user must obtain a fresh ID token (sign out and in) before the claim is visible."
      : `Applied: the admin claim was removed (read back as planned). ${revocationSummary(result.sessionRevocationEvidence)}`;
  }
  if (result.sessionRevocationEvidence?.tokensValidAfterTimeMovedBackward === true) {
    result.message += ` WARNING (not a clean success): ${result.sessionRevocationEvidence.detail}. The read-back is still at or after this run's server-anchored cutoff, so that interval starts after the cutoff (under the same clock assumption); if this was not the intended fast-clock recovery, find out what stamped the earlier value.`;
  }
  const ahead = result.sessionRevocationEvidence?.validSinceMinusAnchorSeconds;
  if (typeof ahead === "number" && ahead > FAR_AHEAD_WARNING_SECONDS) {
    result.message += ` Note: tokensValidAfterTime is ${ahead}s after server time (the operator clock is ahead): wherever revocation is checked, any session the target starts before ${result.sessionRevocationEvidence?.tokensValidAfterTimeAfter} is rejected (over-revocation; the target may be unable to stay signed in until then). Recovery: sync this machine's clock (NTP) and re-run the same revoke command (runbook, "Fast operator clock").`;
  }
  deps.log(result.message);
  return result;
}

/**
 * The revoke success text: (a) acknowledgment, (b) observed cutoff, (c) the
 * clock assumption, (d) the enforcement caveat. Never phrased as proof.
 */
export function revocationSummary(ev: SessionRevocationEvidence | null): string {
  const observed = ev ? ` (read-back tokensValidAfterTime ${ev.tokensValidAfterTimeAfter}; server-anchored cutoff ${ev.cutoff})` : "";
  return `Sessions: ${REVOCATION_OBSERVED_SUMMARY}${observed}. ${REVOCATION_CLOCK_ASSUMPTION} ${CURRENT_PRIVILEGE_ENFORCEMENT_NOTE}`;
}

/**
 * Added to the wait before revoking, so an operator clock up to about this far
 * BEHIND server time still stamps validSince at or after the cutoff. It only
 * sets tolerance; it is never evidence (the read-back is).
 */
export const REVOCATION_SLEEP_SLACK_MS = 1500;
/** Above this, an observed cutoff's validSince is reported as far ahead of server time. */
export const FAR_AHEAD_WARNING_SECONDS = 300;

/**
 * Re-run guidance printed on every exit-3 outcome. It does not present a re-run
 * as free of risk: a revoke re-run calls revokeRefreshTokens again, which
 * overwrites validSince and can move the cutoff backward from a slow clock.
 */
export const RERUN_GUIDANCE =
  "Re-running the same command never re-applies a claim already in place and never changes any other claim. A revoke re-run calls revokeRefreshTokens again (with no claim write when the admin claim is already absent), which OVERWRITES validSince with this machine's clock and does not keep the later value: from a clock that is behind, a re-run can move the cutoff BACKWARD and stop the revocation check from rejecting sessions an earlier run had excluded. Sync this machine's clock (NTP) before re-running, and read sessionRevocationEvidence afterwards.";

/** The dry-run / pre-execute sessions line for every revoke: the request and its limits, never an effect. */
export const REVOKE_SESSIONS_PLAN_LINE =
  "Sessions:       revokeRefreshTokens WILL be requested for the target (mandatory on revoke). The request can fail; it overwrites validSince with this machine's clock (sync it first: NTP); it does not end already-issued ID tokens (up to about 1 hour) and is not a sign-out from every device.";

function incomplete<TS>(result: RunResult, code: PostWriteFailure, deps: ExecutionDeps<TS>): RunResult {
  result.status = "incomplete";
  result.exitCode = 3;
  result.code = code;
  result.outcome = code;
  const unknown = result.readBack.customClaims === "failed" || result.readBack.usersDocRole === "failed"
    ? " The post-write read-back FAILED: the resulting state is UNKNOWN, not empty."
    : "";
  const ev = result.sessionRevocationEvidence;
  const backward = ev?.tokensValidAfterTimeMovedBackward === true && ev.detail && !result.failureDetails.some((d) => d.includes("moved BACKWARD"))
    ? ` WARNING: ${ev.detail}.`
    : "";
  result.message = `INCOMPLETE (${code}). Failures: ${result.failureDetails.join("; ") || code}.${unknown}${backward} A write was attempted and the operation is not complete; inspect the read-back before assuming either state. ${RERUN_GUIDANCE}`;
  deps.log(result.message);
  return result;
}
