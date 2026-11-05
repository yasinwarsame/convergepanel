/**
 * SYSTEM_ADMIN claim operator tool: orchestration over injected ports.
 *
 * `scripts/admin/set-system-admin-claim.ts` wires real Firebase Admin objects
 * into these ports; the tests wire call-counting fakes. This module imports no
 * Firebase code and reads no environment, so the write ordering below is
 * proven by tests rather than asserted in prose.
 *
 * Write ordering on --execute (fail closed):
 *   1. create the `attempt` audit row (create-only). If that call fails the
 *      row's existence is UNKNOWN: no further write is issued and the run is
 *      INCOMPLETE (exit 3, `audit_attempt_failed`), never "nothing written".
 *   2. write the custom claims — skipped on a revoke whose `admin` claim is
 *      already absent (a re-run): claims are never rewritten then.
 *   3. revoke refresh tokens (EVERY revoke; owner policy, no opt-out).
 *   4. mirror `users/{uid}.role` (display-only field used by the admin UI);
 *      on a sessions-only re-run only if it is still outstanding.
 *   5. read back and verify (claims; for revoke, tokensValidAfterTime advanced).
 *   6. create the `outcome` audit row (create-only).
 * After any failure in 2–4 the remaining mutations are skipped, but read-back
 * and the outcome row still run so the evidence records what actually happened.
 * Nothing is rolled back automatically; re-running the same command is safe.
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
  type RefusalCode,
  type ServiceAccountEvidence,
  type UserRecordLike,
  auditDocId,
  buildClaimAuditRecord,
  checkBootstrapFirstAdmin,
  checkConfirmation,
  checkOperatorAuthorization,
  checkPlanInvariants,
  checkRevokeSafety,
  checkTargetRecord,
  classifyOperatorTokenError,
  countAdminHolders,
  expectedConfirmation,
  formatDiff,
  maskEmail,
  planClaimChange,
  refuse,
  verifyReadBack,
  verifySessionsRevoked,
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
  writeUsersDocRole(uid: string, role: "admin" | "user"): Promise<void>;
  /** MUST be create-only (`.doc(id).create()`); an existing id must fail. */
  createAuditRow(docId: string, record: Record<string, unknown>): Promise<void>;
}

export type ExecutionDeps<TS> = {
  auth: ClaimAuthPort;
  store: ClaimStorePort;
  timestampNow: () => TS;
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
   * 0 completed and verified (or grant already in place: no_change);
   * 2 refused or dry run: NO write call was issued (guaranteed);
   * 3 a write call was issued (possibly only the attempt audit row, outcome
   *   unknown) and the operation is incomplete or unverified. Re-run is safe.
   */
  exitCode: 0 | 2 | 3;
  code: RefusalCode | PostWriteFailure | null;
  outcome: AuditOutcome | null;
  message: string | null;
  requestId: string;
  projectId: string;
  operation: ParsedClaimArgs["operation"];
  targetUid: string;
  targetEmail: string | null;
  /** Revoke always revokes refresh tokens; grant never does. */
  sessionRevocation: "required" | "not_applicable";
  claimWrite: ClaimWritePlan | null;
  plan: { before: Claims; after: Claims; diff: string[] } | null;
  readBackClaims: Claims | null;
  usersDocRole: { before: string | null; after: string | null };
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
    targetEmail: null,
    sessionRevocation: args.operation === "revoke" ? "required" : "not_applicable",
    claimWrite: null,
    plan: null,
    readBackClaims: null,
    usersDocRole: { before: null, after: null },
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
  const targetRefusal = checkTargetRecord(target, args.targetUid);
  if (targetRefusal) return refused(targetRefusal);
  result.targetEmail = typeof target.email === "string" ? target.email : null;
  // Server-side revocation baseline, captured before any write (see verifySessionsRevoked).
  const preWriteTokensValidAfterTime = typeof target.tokensValidAfterTime === "string" ? target.tokensValidAfterTime : undefined;

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
  // On a sessions-only re-run the role mirror is written only if it is still outstanding.
  const writeRole = !sessionsOnly || result.usersDocRole.before !== intendedRole;
  result.claimWrite = claimWrite;
  if (sessionsOnly) {
    deps.log("Claim write:    SKIPPED - the admin claim is already absent; claims will NOT be rewritten.");
  }
  if (args.operation === "revoke") {
    deps.log("Sessions:       the target's refresh tokens WILL be revoked (mandatory on revoke; signs the user out everywhere).");
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
  // From here on every exit is 0 (completed and verified) or 3 (a write call
  // was issued and the operation is not verified complete). Never 2.
  const auditBase = {
    requestId: ctx.requestId,
    projectId: ctx.projectId,
    operation: args.operation,
    authorization,
    adminUid: operatorUid ?? "operator-bootstrap",
    adminEmail: operatorEmail,
    targetUid: args.targetUid,
    targetEmail: result.targetEmail ?? undefined,
    beforeClaims: plan.before,
    usersDocRoleBefore: result.usersDocRole.before,
    claimWrite,
    credentialSource: ctx.credential.source,
    credentialClientEmailMasked: ctx.credential.clientEmailMasked,
    gitSha: deps.git.sha as string,
    confirmClaim: expected,
  };

  let failure: PostWriteFailure | null = null;
  let failureDetail: string | undefined;

  const attemptId = auditDocId(ctx.requestId, "attempt");
  result.writesAttempted.push("audit_attempt_row");
  try {
    await deps.store.createAuditRow(attemptId, buildClaimAuditRecord({
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
    return incomplete(
      result,
      "audit_attempt_failed",
      "attempt audit row creation failed; the row may or may not exist. No claim, session or role write was issued",
      deps,
    );
  }
  result.auditRowIds.push(attemptId);

  if (claimWrite === "write") {
    result.writesAttempted.push("custom_claims");
    try {
      await deps.auth.writeCustomClaims(args.targetUid, plan.after);
    } catch (e) {
      failure = "mint_failed";
      const code = errorCode(e);
      failureDetail = typeof code === "string" ? code : "unknown error";
    }
  }

  if (!failure && args.operation === "revoke") {
    result.writesAttempted.push("revoke_refresh_tokens");
    try {
      await deps.auth.revokeRefreshTokens(args.targetUid);
    } catch {
      failure = "sessions_revoke_failed";
    }
  }

  if (!failure && writeRole) {
    result.writesAttempted.push("users_doc_role");
    try {
      await deps.store.writeUsersDocRole(args.targetUid, intendedRole);
    } catch {
      failure = "users_doc_failed";
    }
  }

  // --- read back (always, after any write attempt) ---------------------------
  let readBack: UserRecordLike | null = null;
  try {
    readBack = await deps.auth.getUser(args.targetUid);
    result.readBackClaims = readBack.customClaims && typeof readBack.customClaims === "object"
      ? { ...(readBack.customClaims as Claims) }
      : {};
  } catch {
    if (!failure) {
      failure = "verification_failed";
      failureDetail = "read-back lookup failed";
    }
  }
  try {
    result.usersDocRole.after = await deps.store.readUsersDocRole(args.targetUid);
  } catch {
    result.usersDocRole.after = null;
  }
  if (!failure && readBack) {
    const v = verifyReadBack(plan, readBack.customClaims);
    if (!v.ok) {
      failure = "verification_failed";
      failureDetail = v.detail;
    } else if (args.operation === "revoke" && !verifySessionsRevoked(readBack.tokensValidAfterTime, preWriteTokensValidAfterTime)) {
      failure = "verification_failed";
      failureDetail = "tokensValidAfterTime did not advance";
    } else if (result.usersDocRole.after !== intendedRole) {
      failure = "verification_failed";
      failureDetail = "users/{uid}.role read-back mismatch";
    }
  }

  const outcome: AuditOutcome = failure ?? (sessionsOnly ? "claim_already_absent_sessions_revoked" : "applied");
  const outcomeId = auditDocId(ctx.requestId, "outcome");
  result.writesAttempted.push("audit_outcome_row");
  try {
    await deps.store.createAuditRow(outcomeId, buildClaimAuditRecord({
      ...auditBase,
      phase: "outcome",
      outcome,
      outcomeDetail: failureDetail,
      createdAt: deps.timestampNow(),
      afterClaims: result.readBackClaims ?? {},
      usersDocRoleAfter: result.usersDocRole.after,
    }));
    result.auditRowIds.push(outcomeId);
  } catch {
    result.auditRowIdsUnconfirmed.push(outcomeId);
    if (!failure) failure = "audit_outcome_missing";
    deps.log(`AUDIT OUTCOME MISSING for ${ctx.requestId}: reconcile from the local result file and the attempt row.`);
  }

  if (failure) return incomplete(result, failure, failureDetail, deps);

  result.outcome = outcome;
  result.exitCode = 0;
  result.code = null;
  if (outcome === "claim_already_absent_sessions_revoked") {
    result.status = "claim_already_absent_sessions_revoked";
    result.message = "Completed: the admin claim was already absent, so no claim was written. The outstanding session revocation was performed and verified (refresh tokens revoked; tokensValidAfterTime advanced). Already-issued ID tokens stay valid until they expire (up to 1 hour).";
  } else {
    result.status = "applied";
    result.message = args.operation === "grant"
      ? "Applied and verified. The user must obtain a fresh ID token (sign out and in) before the claim is visible."
      : "Applied and verified: admin removed and refresh tokens revoked (tokensValidAfterTime advanced). Already-issued ID tokens stay valid until they expire (up to 1 hour).";
  }
  deps.log(result.message);
  return result;
}

/** Re-run guidance printed on every exit-3 outcome. */
export const RERUN_IS_SAFE =
  "Re-running the same command is safe: it never re-applies a claim already in place, never changes any other claim, and a revoke re-run whose claim is already absent only completes the outstanding session revocation (no claim write).";

function incomplete<TS>(result: RunResult, code: PostWriteFailure, detail: string | undefined, deps: ExecutionDeps<TS>): RunResult {
  result.status = "incomplete";
  result.exitCode = 3;
  result.code = code;
  result.outcome = code;
  result.message = `INCOMPLETE (${code}${detail ? `: ${detail}` : ""}). A write was attempted and the operation is not verified complete; inspect the read-back before assuming either state. ${RERUN_IS_SAFE}`;
  deps.log(result.message);
  return result;
}
