/**
 * SYSTEM_ADMIN claim operator tool: orchestration over injected ports.
 *
 * `scripts/admin/set-system-admin-claim.ts` wires real Firebase Admin objects
 * into these ports; the tests wire call-counting fakes. This module imports no
 * Firebase code and reads no environment, so the write ordering below is
 * proven by tests rather than asserted in prose.
 *
 * Write ordering on --execute (fail closed):
 *   1. create the `attempt` audit row (create-only). Failure => refuse, NO write.
 *   2. write the custom claims.
 *   3. revoke refresh tokens (revoke with --revoke-sessions=yes only).
 *   4. mirror `users/{uid}.role` (display-only field used by the admin UI).
 *   5. read back and verify.
 *   6. create the `outcome` audit row (create-only).
 * After any failure in 2–4 the remaining mutations are skipped, but read-back
 * and the outcome row still run so the evidence records what actually happened.
 * Nothing is rolled back automatically.
 *
 * The operator ID token is read through a port, passed to `verifyIdToken`, and
 * dropped. It is never logged, returned, or written to any record.
 */

import {
  type AuditOutcome,
  type AuthorizationMode,
  type ClaimPlan,
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
  nowMs: () => number;
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

export type RunStatus = "dry_run" | "no_change" | "applied" | "refused" | "failed_after_write";

export type RunResult = {
  status: RunStatus;
  exitCode: 0 | 2 | 3;
  code: RefusalCode | PostWriteFailure | null;
  message: string | null;
  requestId: string;
  projectId: string;
  operation: ParsedClaimArgs["operation"];
  targetUid: string;
  targetEmail: string | null;
  revokeSessions: ParsedClaimArgs["revokeSessions"];
  plan: { before: Claims; after: Claims; diff: string[] } | null;
  readBackClaims: Claims | null;
  usersDocRole: { before: string | null; after: string | null };
  authorization: { mode: AuthorizationMode | "not_evaluated"; operatorUid: string | null; operatorEmailMasked: string | null };
  expectedConfirmation: string | null;
  auditRowIds: string[];
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
    message: null,
    requestId: ctx.requestId,
    projectId: ctx.projectId,
    operation: args.operation,
    targetUid: args.targetUid,
    targetEmail: null,
    revokeSessions: args.revokeSessions,
    plan: null,
    readBackClaims: null,
    usersDocRole: { before: null, after: null },
    authorization: { mode: "not_evaluated", operatorUid: null, operatorEmailMasked: null },
    expectedConfirmation: null,
    auditRowIds: [],
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

  // --- no change -------------------------------------------------------------
  if (!plan.changed) {
    result.status = "no_change";
    result.exitCode = 0;
    result.code = null;
    result.message = "No change: the claims already match the intended state. Nothing was written.";
    deps.log(result.message);
    return result;
  }

  const expected = expectedConfirmation({
    operation: args.operation,
    projectId: ctx.projectId,
    targetUid: args.targetUid,
    revokeSessions: args.revokeSessions,
  });

  // --- dry run (default) -----------------------------------------------------
  if (!args.execute) {
    result.status = "dry_run";
    result.exitCode = 0;
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
    revokeSessions: args.revokeSessions,
    credentialSource: ctx.credential.source,
    credentialClientEmailMasked: ctx.credential.clientEmailMasked,
    gitSha: deps.git.sha as string,
    confirmClaim: expected,
  };

  const attemptId = auditDocId(ctx.requestId, "attempt");
  try {
    await deps.store.createAuditRow(attemptId, buildClaimAuditRecord({
      ...auditBase,
      phase: "attempt",
      createdAt: deps.timestampNow(),
      afterClaims: plan.after,
      usersDocRoleAfter: intendedRole,
    }));
  } catch {
    return refused(refuse("audit_unavailable", "Refusing: the attempt audit row could not be created. No claim was written."));
  }
  result.auditRowIds.push(attemptId);

  const startedAtMs = deps.nowMs();
  let failure: PostWriteFailure | null = null;
  let failureDetail: string | undefined;

  result.writesAttempted.push("custom_claims");
  try {
    await deps.auth.writeCustomClaims(args.targetUid, plan.after);
  } catch (e) {
    failure = "mint_failed";
    const code = errorCode(e);
    failureDetail = typeof code === "string" ? code : "unknown error";
  }

  if (!failure && args.operation === "revoke" && args.revokeSessions === "yes") {
    result.writesAttempted.push("revoke_refresh_tokens");
    try {
      await deps.auth.revokeRefreshTokens(args.targetUid);
    } catch {
      failure = "sessions_revoke_failed";
    }
  }

  if (!failure) {
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
    } else if (args.operation === "revoke" && args.revokeSessions === "yes" && !verifySessionsRevoked(readBack.tokensValidAfterTime, startedAtMs)) {
      failure = "verification_failed";
      failureDetail = "tokensValidAfterTime did not advance";
    } else if (result.usersDocRole.after !== intendedRole) {
      failure = "verification_failed";
      failureDetail = "users/{uid}.role read-back mismatch";
    }
  }

  const outcome: AuditOutcome = failure ?? "applied";
  const outcomeId = auditDocId(ctx.requestId, "outcome");
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
    if (!failure) failure = "audit_outcome_missing";
    deps.log(`AUDIT OUTCOME MISSING for ${ctx.requestId}: reconcile from the local result file and the attempt row.`);
  }

  if (failure) {
    result.status = "failed_after_write";
    result.exitCode = 3;
    result.code = failure;
    result.message = `Write attempted but not verified (${failure}${failureDetail ? `: ${failureDetail}` : ""}). Do not assume either state; inspect the read-back.`;
  } else {
    result.status = "applied";
    result.exitCode = 0;
    result.code = null;
    result.message = args.operation === "grant"
      ? "Applied and verified. The user must obtain a fresh ID token (sign out and in) before the claim is visible."
      : `Applied and verified. Sessions revoked: ${args.revokeSessions}.`;
  }
  deps.log(result.message);
  return result;
}
