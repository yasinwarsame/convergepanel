/**
 * Orchestration tests over call-counting fakes. No Firebase, no network.
 * Proves: dry run performs zero writes (exit 2); the attempt audit row
 * precedes the claim write and its failure prevents the write but is exit 3
 * (outcome unknown), never 2; read-back and the outcome row follow; refusals
 * happen before any write; every revoke calls revokeRefreshTokens exactly once;
 * a revoke re-run whose claim is already absent requests revocation again
 * without rewriting claims; the G3 clock gate stops a run before any claim,
 * role or revocation call; the G2 fresh pre-call read refuses a call that
 * would lower the stored value (and a failed fresh read refuses the call);
 * a lowered cutoff is never exit 0 (exit 4, or 3 when already incomplete).
 *
 * CLOCK MODEL (faithful to firebase-admin 12.7.0): the fake keeps a SERVER
 * clock (`w.serverMs`, advanced by every RPC's latency and by sleepMs) and an
 * OPERATOR clock (`w.serverMs + w.skewMs`). revokeRefreshTokens stamps
 * validSince from the OPERATOR clock, exactly as
 * auth-api-request.js:1261 does (`Math.floor(new Date().getTime() / 1000)`);
 * Firestore writes return SERVER commit times.
 */
import {
  RERUN_GUIDANCE,
  REVIEW_GUIDANCE,
  REVOKE_SESSIONS_PLAN_LINE,
  runSystemAdminClaim,
  type ClaimAuthPort,
  type ClaimStorePort,
  type ExecutionDeps,
} from "../systemAdminClaimExecution";
import { expectedConfirmation, parseSetSystemAdminClaimArgs, type ParsedClaimArgs, type UserRecordLike } from "../systemAdminClaimSafety";

const PROJECT = "cp-rehearsal-1";
const TARGET = "TargetUid0000000000000000001";
const OPERATOR = "OperatorUid00000000000000001";
const OTHER_ADMIN = "OtherAdmin000000000000000001";
const TOKEN = "header.payload.signature-SECRET-TOKEN-VALUE";

type World = {
  users: Map<string, UserRecordLike>;
  roles: Map<string, string | null>;
  audit: Map<string, Record<string, unknown>>;
  calls: string[];
  writes: number;
  /**
   * getUserAfterWrite: EVERY getUser after the first write fails (on a revoke that
   * includes the G2 fresh read before the call). getUserAfterRevoke: only getUser
   * calls after revokeRefreshTokens was called (the read-back).
   */
  fail: Partial<Record<"attempt" | "outcome" | "claims" | "revoke" | "role" | "getUserAfterWrite" | "getUserAfterRevoke" | "readRoleAfterWrite" | "list", boolean>>;
  tokenDecoded: { uid: string; admin?: unknown } | { error: string };
  /** A broken backend that silently ignores the claim write. */
  dropClaimWrite?: boolean;
  /** Server clock (ms since epoch). */
  serverMs: number;
  /** Operator clock minus server clock (ms). Positive = operator clock ahead. */
  skewMs: number;
  /** Every validSince the fake Auth backend received (seconds). */
  validSinceSent: number[];
  /** Total time slept by the tool (ms). */
  sleptMs: number;
  /** Every `disabled` value any write tried to set (must stay empty: no port can). */
  disabledWrites: unknown[];
  /** Test scratch: the role write's commit time. */
  roleCommitIso?: string;
};

const SERVER_START_MS = Date.parse("2026-11-05T10:00:00.400Z");
const RPC_LATENCY_MS = 40;
const toServerTime = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });

function world(): World {
  return {
    users: new Map<string, UserRecordLike>([
      [TARGET, { uid: TARGET, email: "target@example.com", disabled: false, customClaims: { admin: false, plan: "pro" } }],
      [OPERATOR, { uid: OPERATOR, email: "operator@example.com", disabled: false, customClaims: { admin: true } }],
    ]),
    roles: new Map([[TARGET, "user"]]),
    audit: new Map(),
    calls: [],
    writes: 0,
    fail: {},
    tokenDecoded: { uid: OPERATOR, admin: true },
    serverMs: SERVER_START_MS,
    skewMs: 0,
    validSinceSent: [],
    sleptMs: 0,
    disabledWrites: [],
  };
}

/** The real SDK's revokeRefreshTokens: validSince = floor(LOCAL now / 1000), stored as sent. */
function sdkRevoke(w: World, uid: string): void {
  const validSince = Math.floor((w.serverMs + w.skewMs) / 1000);
  w.validSinceSent.push(validSince);
  w.users.get(uid)!.tokensValidAfterTime = new Date(validSince * 1000).toUTCString();
}

function deps(w: World, overrides: Partial<ExecutionDeps<string>> = {}): ExecutionDeps<string> {
  let wroteClaims = false;
  let revoked = false;
  const tick = () => { w.serverMs += RPC_LATENCY_MS; };
  const auth: ClaimAuthPort = {
    getUser: async (uid) => {
      tick();
      w.calls.push(`getUser:${uid}`);
      if ((wroteClaims || w.writes > 0) && w.fail.getUserAfterWrite) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
      if (revoked && w.fail.getUserAfterRevoke) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
      const u = w.users.get(uid);
      if (!u) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
      return JSON.parse(JSON.stringify(u));
    },
    verifyIdToken: async (token, checkRevoked) => {
      w.calls.push(`verifyIdToken:checkRevoked=${checkRevoked}`);
      expect(token).toBe(TOKEN);
      if ("error" in w.tokenDecoded) throw Object.assign(new Error("bad"), { code: w.tokenDecoded.error });
      return w.tokenDecoded;
    },
    listUsers: async (_max, pageToken) => {
      w.calls.push(`listUsers:${pageToken ?? ""}`);
      if (w.fail.list) throw new Error("list");
      const all = [...w.users.values()];
      // two pages, to prove pagination is followed
      return pageToken ? { users: all.slice(1) } : { users: all.slice(0, 1), pageToken: "p2" };
    },
    writeCustomClaims: async (uid, claims) => {
      tick();
      w.calls.push(`writeCustomClaims:${uid}`);
      w.writes++;
      wroteClaims = true;
      if (claims && typeof claims === "object" && "disabled" in claims) w.disabledWrites.push((claims as Record<string, unknown>).disabled);
      if (w.fail.claims) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
      if (w.dropClaimWrite) return;
      const u = w.users.get(uid)!;
      u.customClaims = JSON.parse(JSON.stringify(claims));
    },
    revokeRefreshTokens: async (uid) => {
      tick();
      w.calls.push(`revokeRefreshTokens:${uid}`);
      w.writes++;
      revoked = true;
      if (w.fail.revoke) throw new Error("x");
      sdkRevoke(w, uid);
    },
  };
  const store: ClaimStorePort = {
    readUsersDocRole: async (uid) => {
      w.calls.push(`readRole:${uid}`);
      if (w.fail.readRoleAfterWrite && w.writes > 0) throw Object.assign(new Error("x"), { code: "unavailable" });
      return w.roles.get(uid) ?? null;
    },
    writeUsersDocRole: async (uid, role) => {
      tick();
      w.calls.push(`writeRole:${uid}:${role}`);
      w.writes++;
      if (w.fail.role) throw new Error("x");
      w.roles.set(uid, role);
      return toServerTime(w.serverMs);
    },
    createAuditRow: async (id, record) => {
      tick();
      const phase = id.endsWith(":attempt") ? "attempt" : "outcome";
      w.calls.push(`createAuditRow:${phase}`);
      w.writes++;
      if (w.fail[phase]) throw new Error("audit down");
      if (w.audit.has(id)) throw new Error("ALREADY_EXISTS");
      w.audit.set(id, JSON.parse(JSON.stringify(record)));
      return toServerTime(w.serverMs);
    },
  };
  return {
    auth,
    store,
    timestampNow: () => "TS",
    // The OPERATOR clock: the same clock sdkRevoke stamps from.
    nowMs: () => w.serverMs + w.skewMs,
    sleepMs: async (ms) => {
      w.calls.push(`sleep:${ms}`);
      w.sleptMs += ms;
      w.serverMs += ms;
    },
    readOperatorToken: async () => ({ ok: true, token: TOKEN }),
    git: { sha: "abc123", dirty: false },
    log: (line) => w.calls.push(`log:${line}`),
    ...overrides,
  };
}

function args(extra: string[], op: "grant" | "revoke" = "grant"): ParsedClaimArgs {
  const base = [`--confirm-project=${PROJECT}`, "--credentials=/k.json", `--target-uid=${TARGET}`, `--operation=${op}`];
  if (op === "revoke") base.push("--allow-claim-reduction");
  const r = parseSetSystemAdminClaimArgs([...base, ...extra]);
  if (!r.ok) throw new Error(`fixture argv refused: ${r.code}`);
  return r.args;
}
const ctx = (a: ParsedClaimArgs, requestId = "req_1_abc") => ({
  args: a,
  projectId: PROJECT,
  requestId,
  credential: { source: "explicit-key-file" as const, clientEmailMasked: "fire…@…" },
});
const GRANT_CONFIRM = expectedConfirmation({ operation: "grant", projectId: PROJECT, targetUid: TARGET });
const REVOKE_CONFIRM = expectedConfirmation({ operation: "revoke", projectId: PROJECT, targetUid: TARGET });
const REVOKE_EXEC = ["--operator-id-token-file=/t", "--execute", `--confirm-claim=${REVOKE_CONFIRM}`];
const writeCalls = (w: World) => w.calls.filter((c) => /^(writeCustomClaims|revokeRefreshTokens|writeRole|createAuditRow)/.test(c));

describe("dry run (default)", () => {
  it("performs ZERO writes, exits 2 (not completed), and prints the exact confirmation", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t"])), deps(w));
    expect(r.status).toBe("dry_run");
    expect(r.exitCode).toBe(2);
    expect(r.writesAttempted).toEqual([]);
    expect(w.writes).toBe(0);
    expect(writeCalls(w)).toEqual([]);
    expect(r.expectedConfirmation).toBe(GRANT_CONFIRM);
    expect(r.plan?.after).toEqual({ admin: true, plan: "pro" });
    expect(r.plan?.diff).toEqual(["~ admin: false -> true"]);
    expect(w.calls).toContain(`log:To apply, re-run with --execute --confirm-claim=${GRANT_CONFIRM}`);
  });
  it("performs ZERO writes even without an authorization flag", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args([])), deps(w));
    expect(r.status).toBe("dry_run");
    expect(r.authorization.mode).toBe("not_evaluated");
    expect(w.writes).toBe(0);
  });
  it("a revoke dry run performs ZERO writes", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true, plan: "pro" };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args([], "revoke")), deps(w));
    expect(r.status).toBe("dry_run");
    expect(r.exitCode).toBe(2);
    expect(r.expectedConfirmation).toBe(`revoke:admin:removed:revocation-requested:${PROJECT}:${TARGET}`);
    const PLAN_LINE = "Sessions:       revokeRefreshTokens WILL be requested for the target (mandatory on revoke) unless a fresh read just before the call shows a stored cutoff later than this machine's clock. The request can fail; it overwrites validSince with this machine's clock (sync it first: NTP; the run stops before any claim write if this clock is more than 2 s off Firestore server time); it does not end already-issued ID tokens (up to about 1 hour) and is not a sign-out from every device.";
    expect(REVOKE_SESSIONS_PLAN_LINE).toBe(PLAN_LINE);
    expect(w.calls).toContain(`log:${PLAN_LINE}`);
    expect(w.calls.filter((c) => c.startsWith("log:Sessions:"))).toEqual([`log:${PLAN_LINE}`]);
    expect(w.calls.join("\n")).not.toMatch(/signs the user out everywhere|refresh tokens WILL be revoked/);
    expect(w.writes).toBe(0);
  });
});

describe("execute — happy paths", () => {
  it("grant: attempt row, claims, role, read-back, outcome row — in that order", async () => {
    const w = world();
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    expect(r.status).toBe("applied");
    expect(r.exitCode).toBe(0);
    expect(writeCalls(w)).toEqual([
      "createAuditRow:attempt",
      `writeCustomClaims:${TARGET}`,
      `writeRole:${TARGET}:admin`,
      "createAuditRow:outcome",
    ]);
    // read-back happens between the last mutation and the outcome row
    const i = w.calls.lastIndexOf(`getUser:${TARGET}`);
    expect(i).toBeGreaterThan(w.calls.indexOf(`writeRole:${TARGET}:admin`));
    expect(i).toBeLessThan(w.calls.indexOf("createAuditRow:outcome"));
    // merge order + preservation, end to end
    expect(w.users.get(TARGET)!.customClaims).toEqual({ admin: true, plan: "pro" });
    // operator verification used checkRevoked
    expect(w.calls).toContain("verifyIdToken:checkRevoked=true");
    const outcome = w.audit.get("system-admin-claim:req_1_abc:outcome")!;
    expect(outcome).toMatchObject({
      adminUid: OPERATOR,
      targetUid: TARGET,
      actionType: "GRANT_SYSTEM_ADMIN_CLAIM",
      before: { customClaims: { admin: false, plan: "pro" }, usersDocRole: "user" },
      after: { customClaims: { admin: true, plan: "pro" }, usersDocRole: "admin" },
      createdAt: "TS",
      requestId: "req_1_abc",
      metadata: { phase: "outcome", outcome: "applied", gitSha: "abc123", confirmClaim: GRANT_CONFIRM, authorization: "operator-id-token" },
    });
    const attempt = w.audit.get("system-admin-claim:req_1_abc:attempt")!;
    expect(attempt.after).toEqual({ customClaims: { admin: true, plan: "pro" }, usersDocRole: "admin" });
  });

  it("revoke removes only admin, writes the role anchor, calls revokeRefreshTokens once, observes the server cutoff", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true, plan: "pro" };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.outcome]).toEqual(["applied", 0, "applied"]);
    expect(r.sessionRevocation).toBe("required");
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
    // The role write is the server-time anchor: AFTER the claim write, BEFORE the revocation.
    expect(writeCalls(w)).toEqual([
      "createAuditRow:attempt",
      `writeCustomClaims:${TARGET}`,
      `writeRole:${TARGET}:user`,
      `revokeRefreshTokens:${TARGET}`,
      "createAuditRow:outcome",
    ]);
    expect(r.sessionRevocationObservations).toMatchObject({ cutoffObserved: true, marginSeconds: 2, detail: null });
    const outcomeRow = w.audit.get("system-admin-claim:req_1_abc:outcome")!;
    expect(outcomeRow.actionType).toBe("REVOKE_SYSTEM_ADMIN_CLAIM");
    expect(outcomeRow.metadata).toMatchObject({ sessionRevocation: "required", claimWrite: "write", outcome: "applied", completed: true });
    expect(w.audit.get("system-admin-claim:req_1_abc:attempt")!).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_ATTEMPT",
      metadata: { completed: false, afterSemantics: "intended-not-applied" },
    });
  });

  it("a grant never revokes sessions", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect(r.status).toBe("applied");
    expect(r.sessionRevocation).toBe("not_applicable");
    expect(w.calls.some((c) => c.startsWith("revokeRefreshTokens"))).toBe(false);
  });

  it("bootstrap: zero admin holders (pages followed) allows a grant recorded as operator-bootstrap", async () => {
    const w = world();
    w.users.get(OPERATOR)!.customClaims = {};
    const r = await runSystemAdminClaim(
      ctx(args(["--bootstrap-first-admin", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    expect(r.status).toBe("applied");
    expect(w.calls).toEqual(expect.arrayContaining(["listUsers:", "listUsers:p2"]));
    expect(w.audit.get("system-admin-claim:req_1_abc:attempt")).toMatchObject({
      adminUid: "operator-bootstrap",
      metadata: { authorization: "first-admin-bootstrap" },
    });
  });
});

describe("execute — refusals happen before ANY write", () => {
  const exec = ["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`];
  const cases: Array<[string, (w: World) => void, string[] | null, Partial<ExecutionDeps<string>>]> = [
    ["dirty_tree", () => undefined, null, { git: { sha: "abc", dirty: true } }],
    ["dirty_tree", () => undefined, null, { git: { sha: null, dirty: false } }],
    ["dirty_tree", () => undefined, null, { git: { sha: "abc", dirty: null } }],
    ["target_missing", (w) => w.users.delete(TARGET), null, {}],
    ["target_disabled", (w) => { w.users.get(TARGET)!.disabled = true; }, null, {}],
    ["target_disabled", (w) => { delete w.users.get(TARGET)!.disabled; }, null, {}],
    ["claims_invalid", (w) => { w.users.get(TARGET)!.customClaims = ["x"]; }, null, {}],
    ["reserved_claim", (w) => { w.users.get(TARGET)!.customClaims = { iss: "x" }; }, null, {}],
    ["claims_too_large", (w) => { w.users.get(TARGET)!.customClaims = { pad: "p".repeat(990) }; }, null, {}],
    ["operator_token_missing", () => undefined, ["--execute", `--confirm-claim=${GRANT_CONFIRM}`], {}],
    ["operator_token_invalid", (w) => { w.tokenDecoded = { error: "auth/argument-error" }; }, null, {}],
    ["operator_token_revoked", (w) => { w.tokenDecoded = { error: "auth/id-token-revoked" }; }, null, {}],
    ["operator_not_system_admin", (w) => { w.tokenDecoded = { uid: OPERATOR }; }, null, {}],
    ["operator_not_system_admin", (w) => { w.users.get(OPERATOR)!.customClaims = {}; }, null, {}],
    ["operator_not_system_admin", (w) => { w.users.get(OPERATOR)!.disabled = true; }, null, {}],
    ["operator_token_file_unsafe", () => undefined, null, {
      readOperatorToken: async () => ({ ok: false, code: "operator_token_file_unsafe", message: "m" }),
    }],
    ["bootstrap_not_first", () => undefined, ["--bootstrap-first-admin", "--execute", `--confirm-claim=${GRANT_CONFIRM}`], {}],
    ["admin_enumeration_failed", (w) => { w.fail.list = true; }, ["--bootstrap-first-admin", "--execute", `--confirm-claim=${GRANT_CONFIRM}`], {}],
    ["confirmation_mismatch", () => undefined, ["--operator-id-token-file=/t", "--execute", `--confirm-claim=grant:admin:true:convergepanel:${TARGET}`], {}],
  ];
  it.each(cases)("%s", async (code, mutate, argv, over) => {
    const w = world();
    mutate(w);
    const r = await runSystemAdminClaim(ctx(args(argv ?? exec)), deps(w, over));
    expect(r.status).toBe("refused");
    expect(r.exitCode).toBe(2);
    expect(r.code).toBe(code);
    // Exit 2 guarantees NO write call of any kind, the attempt audit row included.
    expect(writeCalls(w)).toEqual([]);
    expect(r.writesAttempted).toEqual([]);
    expect(w.audit.size).toBe(0);
  });

  it("CONTROL for the table above: the same world with no mutation applies", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect(r.status).toBe("applied");
  });

  it("users_doc_read_failed refuses before any write", async () => {
    const w = world();
    const d = deps(w);
    d.store.readUsersDocRole = async () => { throw new Error("x"); };
    const r = await runSystemAdminClaim(ctx(args(exec)), d);
    expect(r.code).toBe("users_doc_read_failed");
    expect(w.writes).toBe(0);
  });

  it("target_lookup_failed and target_mismatch refuse before any write", async () => {
    const w1 = world();
    const d1 = deps(w1);
    d1.auth.getUser = async () => { throw Object.assign(new Error("boom"), { code: "auth/internal-error" }); };
    expect((await runSystemAdminClaim(ctx(args(exec)), d1)).code).toBe("target_lookup_failed");
    const w2 = world();
    const d2 = deps(w2);
    const real = d2.auth.getUser;
    d2.auth.getUser = async (uid) => ({ ...(await real(uid)), uid: "someoneElse" });
    expect((await runSystemAdminClaim(ctx(args(exec)), d2)).code).toBe("target_mismatch");
    expect(w1.writes + w2.writes).toBe(0);
  });

  it("revoke refuses self_revoke and last_admin before any write", async () => {
    const revokeExec = REVOKE_EXEC;

    const w1 = world();
    w1.users.get(TARGET)!.customClaims = { admin: true };
    w1.tokenDecoded = { uid: TARGET, admin: true };
    w1.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    expect((await runSystemAdminClaim(ctx(args(revokeExec, "revoke")), deps(w1))).code).toBe("self_revoke");

    // last_admin: the target is the only enabled admin holder. (With a verified
    // operator token the operator is itself a holder, so this is reached in a
    // dry run, or when the only other holder is disabled.)
    const w2 = world();
    w2.users.get(TARGET)!.customClaims = { admin: true };
    w2.users.get(OPERATOR)!.customClaims = {};
    w2.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: true, customClaims: { admin: true } });
    expect((await runSystemAdminClaim(ctx(args([], "revoke")), deps(w2))).code).toBe("last_admin");

    // CONTROL: with one more ENABLED holder the same revoke dry run passes.
    const w3 = world();
    w3.users.get(TARGET)!.customClaims = { admin: true };
    w3.users.get(OPERATOR)!.customClaims = {};
    w3.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    expect((await runSystemAdminClaim(ctx(args([], "revoke")), deps(w3))).status).toBe("dry_run");
    expect(w1.writes + w2.writes + w3.writes).toBe(0);
  });
});

describe("audit ordering — attempt failure means no mint, and is exit 3 (outcome unknown), never 2", () => {
  const expectAttemptFailed = (r: Awaited<ReturnType<typeof runSystemAdminClaim>>, w: World) => {
    expect([r.status, r.exitCode, r.code, r.outcome]).toEqual(["incomplete", 3, "audit_attempt_failed", "audit_attempt_failed"]);
    expect(r.writesAttempted).toEqual(["audit_attempt_row"]);
    expect(r.auditRowIds).toEqual([]);
    expect(r.auditRowIdsUnconfirmed).toEqual(["system-admin-claim:req_1_abc:attempt"]);
    expect(r.message).toMatch(/may or may not exist/);
    expect(r.message).toContain(RERUN_GUIDANCE);
    expect(r.message).not.toMatch(/command is safe|harmless|idempotent/i);
    expect(r.message).not.toMatch(/nothing (was )?written/i);
    expect(writeCalls(w)).toEqual(["createAuditRow:attempt"]);
  };
  it("attempt create() throwing => no claim/session/role write, exit 3 audit_attempt_failed", async () => {
    const w = world();
    w.fail.attempt = true;
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    expectAttemptFailed(r, w);
    expect(w.users.get(TARGET)!.customClaims).toEqual({ admin: false, plan: "pro" });
  });
  it("the create landed but the call threw (orphan row) => still exit 3, never 2", async () => {
    const w = world();
    const d = deps(w);
    d.store.createAuditRow = async (id, record) => {
      w.calls.push("createAuditRow:attempt");
      w.writes++;
      w.audit.set(id, record);
      throw new Error("DEADLINE_EXCEEDED");
    };
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), d);
    expectAttemptFailed(r, w);
    expect(w.audit.size).toBe(1);
  });
  it("on a revoke: attempt failure revokes nothing either", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    w.fail.attempt = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expectAttemptFailed(r, w);
  });
  it("a pre-existing attempt row (create-only collision) also prevents the mint", async () => {
    const w = world();
    w.audit.set("system-admin-claim:req_1_abc:attempt", { stale: true });
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    expect([r.exitCode, r.code]).toEqual([3, "audit_attempt_failed"]);
    expect(w.calls.some((c) => c.startsWith("writeCustomClaims"))).toBe(false);
  });
});

describe("execute — failures after the write are exit 3 and recorded", () => {
  const exec = ["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`];
  it("verification_failed when the backend drops the claim write (read-back mismatch)", async () => {
    const w = world();
    w.dropClaimWrite = true;
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect(r.exitCode).toBe(3);
    expect(r.code).toBe("verification_failed");
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")!.metadata).toMatchObject({ outcome: "verification_failed" });
  });
  it("mint_failed skips later mutations but still reads back and writes the outcome row", async () => {
    const w = world();
    w.fail.claims = true;
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect(r.code).toBe("mint_failed");
    expect(w.calls.some((c) => c.startsWith("writeRole"))).toBe(false);
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")!.metadata).toMatchObject({ outcome: "mint_failed" });
  });
  it("users_doc_failed", async () => {
    const w = world();
    w.fail.role = true;
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect([r.exitCode, r.code]).toEqual([3, "users_doc_failed"]);
  });
  it("sessions_revoke_failed is INCOMPLETE (exit 3), prints the re-run guidance (clock sync; overwrite risk), and is recorded as incomplete", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    w.fail.revoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "sessions_revoke_failed"]);
    expect(r.message).toMatch(/^INCOMPLETE/);
    expect(r.message).toContain(RERUN_GUIDANCE);
    expect(r.message).not.toMatch(/command is safe|harmless|idempotent/i);
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      metadata: { outcome: "sessions_revoke_failed", completed: false },
    });
  });
  it("audit_outcome_missing when the outcome row cannot be created", async () => {
    const w = world();
    w.fail.outcome = true;
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect([r.exitCode, r.code]).toEqual([3, "audit_outcome_missing"]);
    expect(w.calls.some((c) => c.includes("AUDIT OUTCOME MISSING"))).toBe(true);
  });
  it("verification_failed when the read-back lookup itself fails", async () => {
    const w = world();
    w.fail.getUserAfterWrite = true;
    const r = await runSystemAdminClaim(ctx(args(exec)), deps(w));
    expect([r.exitCode, r.code]).toEqual([3, "verification_failed"]);
  });
});

describe("review round 1 — gaps", () => {
  const exec = ["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`];

  it("MINOR-1: bootstrap counts DISABLED admin holders too (a disabled admin:true account => bootstrap_not_first)", async () => {
    const w = world();
    w.users.get(OPERATOR)!.customClaims = {};
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: true, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args(["--bootstrap-first-admin", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect(r.code).toBe("bootstrap_not_first");
    expect(w.writes).toBe(0);
  });

  it("MINOR-2: a users/{uid}.role write that silently does nothing => verification_failed, exit 3", async () => {
    const w = world();
    const d = deps(w);
    d.store.writeUsersDocRole = async (uid, role) => {
      w.calls.push(`writeRole:${uid}:${role}`);
      w.writes++;
    };
    const r = await runSystemAdminClaim(ctx(args(exec)), d);
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "verification_failed"]);
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")!.metadata).toMatchObject({
      outcome: "verification_failed",
      outcomeDetail: "verification_failed: users/{uid}.role read-back mismatch",
    });
  });

});

describe("safe retry — revoke whose admin claim is already absent (R2 MINOR-1)", () => {
  const BEFORE_TVA = "Thu, 05 Nov 2026 09:00:00 GMT";
  const revokeWorld = () => {
    const w = world();
    const t = w.users.get(TARGET)!;
    t.customClaims = { admin: true, plan: "pro", team: { id: "t1" } };
    t.tokensValidAfterTime = BEFORE_TVA;
    w.roles.set(TARGET, "admin");
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    return w;
  };

  it("run 1 sessions_revoke_failed (exit 3) -> run 2, same command: requests revocation again, cutoff observed, no claim write, exit 0", async () => {
    const w = revokeWorld();
    w.fail.revoke = true;
    const r1 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_1_first"), deps(w));
    expect([r1.exitCode, r1.code]).toEqual([3, "sessions_revoke_failed"]);
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro", team: { id: "t1" } });
    expect(w.users.get(TARGET)!.tokensValidAfterTime).toBe(BEFORE_TVA);

    w.fail.revoke = false;
    w.calls.length = 0;
    const claimsObject = w.users.get(TARGET)!.customClaims;
    const r2 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_2_retry"), deps(w));
    expect([r2.status, r2.exitCode, r2.code, r2.outcome]).toEqual([
      "claim_already_absent_revocation_cutoff_observed", 0, null, "claim_already_absent_revocation_cutoff_observed",
    ]);
    expect(r2.claimWrite).toBe("skip_already_absent");
    expect(r2.message).not.toMatch(/no change/i);
    // Claims are NOT rewritten (same object, never passed to writeCustomClaims); unrelated claims intact.
    expect(writeCalls(w)).toEqual([
      "createAuditRow:attempt",
      `writeRole:${TARGET}:user`, // the server-time anchor: written on EVERY revoke
      `revokeRefreshTokens:${TARGET}`,
      "createAuditRow:outcome",
    ]);
    expect(w.users.get(TARGET)!.customClaims).toBe(claimsObject);
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro", team: { id: "t1" } });
    expect(w.users.get(TARGET)!.tokensValidAfterTime).not.toBe(BEFORE_TVA);
    expect(r2.sessionRevocationObservations).toMatchObject({ cutoffObserved: true, tokensValidAfterTimeBefore: BEFORE_TVA });
    expect(w.audit.get("system-admin-claim:req_2_retry:attempt")).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_ATTEMPT",
      metadata: { claimWrite: "skip_already_absent", sessionRevocation: "required", completed: false },
    });
    expect(w.audit.get("system-admin-claim:req_2_retry:outcome")).toMatchObject({
      actionType: "SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED",
      metadata: { outcome: "claim_already_absent_revocation_cutoff_observed", completed: true, claimWrite: "skip_already_absent" },
      after: { customClaims: { plan: "pro", team: { id: "t1" } }, usersDocRole: "user" },
    });
  });

  it("the retry uses the SAME typed confirmation as the original revoke", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    const dry = await runSystemAdminClaim(ctx(args([], "revoke")), deps(w));
    expect([dry.status, dry.exitCode]).toEqual(["dry_run", 2]);
    expect(dry.expectedConfirmation).toBe(REVOKE_CONFIRM);
    expect(w.calls).toContain("log:Claim write:    SKIPPED - the admin claim is already absent; claims will NOT be rewritten.");
    expect(w.writes).toBe(0);
  });

  it("role already 'user' => the retry still writes the role (the server-time anchor), never the claims", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    w.roles.set(TARGET, "user");
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode]).toEqual(["claim_already_absent_revocation_cutoff_observed", 0]);
    expect(writeCalls(w)).toEqual(["createAuditRow:attempt", `writeRole:${TARGET}:user`, `revokeRefreshTokens:${TARGET}`, "createAuditRow:outcome"]);
  });

  it("session revocation failing AGAIN on the retry => INCOMPLETE exit 3, never no_change/0", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    w.fail.revoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "sessions_revoke_failed"]);
    expect(r.message).toContain(RERUN_GUIDANCE);
    expect(r.message).not.toMatch(/command is safe|harmless|idempotent/i);
    expect(w.calls.some((c) => c.startsWith("writeCustomClaims"))).toBe(false);
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      metadata: { outcome: "sessions_revoke_failed", completed: false },
    });
  });

  it("a retry whose revocation call 'succeeds' but changes nothing => sessions_revoke_unverified, exit 3", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    const d = deps(w);
    d.auth.revokeRefreshTokens = async (uid) => {
      w.calls.push(`revokeRefreshTokens:${uid}`);
      w.writes++;
    };
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
    expect([r.exitCode, r.code]).toEqual([3, "sessions_revoke_unverified"]);
  });

  it.each(["sessions-revoked", "sessions-yes", "sessions-no"])("the retired %s confirmation is refused (confirmation_mismatch, zero writes) and named as retired", async (form) => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { admin: true, plan: "pro" };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=revoke:admin:removed:${form}:${PROJECT}:${TARGET}`], "revoke")),
      deps(w),
    );
    expect([r.exitCode, r.code, w.writes]).toEqual([2, "confirmation_mismatch", 0]);
    expect(r.message).toContain("That confirmation form is retired.");
    expect(r.message).toContain(`Expected exactly: revoke:admin:removed:revocation-requested:${PROJECT}:${TARGET}`);
  });

  it("a retry requires the typed confirmation (wrong string => refused, zero writes)", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=revoke:admin:removed:sessions-no:${PROJECT}:${TARGET}`], "revoke")),
      deps(w),
    );
    expect([r.status, r.exitCode, r.code, w.writes]).toEqual(["refused", 2, "confirmation_mismatch", 0]);
  });
});

describe("no-op", () => {
  it("already admin + --execute => no_change, exit 0, zero writes", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true, plan: "pro" };
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    expect([r.status, r.exitCode, w.writes]).toEqual(["no_change", 0, 0]);
  });
});

describe("no secret in any output", () => {
  it("the operator token never appears in logs, result, or audit rows", async () => {
    const w = world();
    const r = await runSystemAdminClaim(
      ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])),
      deps(w),
    );
    const everything = JSON.stringify({ r, calls: w.calls.filter((c) => c.startsWith("log:")), audit: [...w.audit.values()] });
    expect(everything).not.toContain("SECRET-TOKEN-VALUE");
    expect(everything).not.toContain(TOKEN);
  });
});

describe("M-1: read-back failure is never presented as a read snapshot", () => {
  const OUTCOME = "system-admin-claim:req_1_abc:outcome";
  const adminTargetWorld = () => {
    const w = world();
    const t = w.users.get(TARGET)!;
    t.customClaims = { admin: true, plan: "pro" };
    t.tokensValidAfterTime = "Thu, 05 Nov 2026 09:00:00 GMT";
    w.roles.set(TARGET, "admin");
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    return w;
  };

  it("reviewer repro: revoke on {admin:true, plan:'pro'}, revokeRefreshTokens throws, read-back getUser throws", async () => {
    const w = adminTargetWorld();
    w.fail.revoke = true;
    w.fail.getUserAfterRevoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    // Explicitly incomplete, first failure is the code.
    expect([r.status, r.exitCode, r.code, r.outcome]).toEqual(["incomplete", 3, "sessions_revoke_failed", "sessions_revoke_failed"]);
    // The result never fabricates a snapshot.
    expect(r.readBackClaims).toBeNull();
    expect(r.readBack).toEqual({ customClaims: "failed", usersDocRole: "read" });
    // BOTH failures are kept, in order.
    expect(r.failureDetails).toHaveLength(2);
    expect(r.failureDetails[0]).toMatch(/^sessions_revoke_failed: /);
    expect(r.failureDetails[1]).toMatch(/^verification_failed: read-back failed: target Auth record could not be read/);
    expect(r.message).toMatch(/read-back FAILED: the resulting state is UNKNOWN, not empty/);
    const row = w.audit.get(OUTCOME)!;
    expect(row).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      before: { customClaims: { admin: true, plan: "pro" } },
      after: { customClaims: null },
      metadata: {
        completed: false,
        afterSemantics: "unknown",
        readBack: { customClaims: "failed", usersDocRole: "read" },
        outcome: "sessions_revoke_failed",
      },
    });
    const md = row.metadata as { outcomeDetails: string[]; outcomeDetail: string };
    expect(md.outcomeDetails).toEqual(r.failureDetails);
    expect(md.outcomeDetail).toContain("sessions_revoke_failed");
    expect(md.outcomeDetail).toContain("read-back failed");
    // The real state: unrelated claims are intact (the row did not claim otherwise).
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
  });

  it("grant path: read-back getUser throws after a successful write => verification_failed, after.customClaims null, unknown", async () => {
    const w = world();
    w.fail.getUserAfterWrite = true;
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "verification_failed"]);
    expect(r.readBackClaims).toBeNull();
    expect(w.audit.get(OUTCOME)).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      after: { customClaims: null },
      metadata: { completed: false, afterSemantics: "unknown", readBack: { customClaims: "failed", usersDocRole: "read" } },
    });
  });

  it("grant path: users/{uid}.role read-back throws => role UNKNOWN (null + failed marker), never a mismatch claim", async () => {
    const w = world();
    w.fail.readRoleAfterWrite = true;
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "verification_failed"]);
    expect(r.readBack).toEqual({ customClaims: "read", usersDocRole: "failed" });
    expect(r.failureDetails).toEqual([expect.stringMatching(/^verification_failed: read-back failed: users\/\{uid\}\.role could not be read/)]);
    expect(w.audit.get(OUTCOME)).toMatchObject({
      after: { customClaims: { admin: true, plan: "pro" }, usersDocRole: null },
      metadata: { completed: false, afterSemantics: "unknown", readBack: { customClaims: "read", usersDocRole: "failed" } },
    });
  });

  it("mint failure followed by a read-back failure keeps BOTH details (not only the first)", async () => {
    const w = world();
    w.fail.claims = true;
    w.fail.getUserAfterWrite = true;
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect(r.code).toBe("mint_failed");
    expect(r.failureDetails.map((d) => d.split(":")[0])).toEqual(["mint_failed", "verification_failed"]);
    expect((w.audit.get(OUTCOME)!.metadata as { outcomeDetails: string[] }).outcomeDetails).toEqual(r.failureDetails);
  });

  it("an outcome-row failure is added to the details after the earlier ones", async () => {
    const w = world();
    w.fail.getUserAfterWrite = true;
    w.fail.outcome = true;
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect(r.code).toBe("verification_failed");
    expect(r.failureDetails.map((d) => d.split(":")[0])).toEqual(["verification_failed", "audit_outcome_missing"]);
  });

  it("sessions-only retry whose read-back fails: still no claim write, incomplete exit 3, claims UNKNOWN", async () => {
    const w = adminTargetWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    w.fail.getUserAfterRevoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code, r.claimWrite]).toEqual(["incomplete", 3, "verification_failed", "skip_already_absent"]);
    expect(w.calls.some((c) => c.startsWith("writeCustomClaims"))).toBe(false);
    expect(w.audit.get(OUTCOME)).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      after: { customClaims: null },
      metadata: { afterSemantics: "unknown", completed: false, claimWrite: "skip_already_absent" },
    });
  });

  it("CONTROL: a fully verified run records read-back semantics, a real snapshot, and no failure details", async () => {
    const w = adminTargetWorld();
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode]).toEqual(["applied", 0]);
    expect(r.readBack).toEqual({ customClaims: "read", usersDocRole: "read" });
    expect(r.failureDetails).toEqual([]);
    expect(w.audit.get(OUTCOME)).toMatchObject({
      after: { customClaims: { plan: "pro" }, usersDocRole: "user" },
      metadata: { afterSemantics: "read-back", completed: true, readBack: { customClaims: "read", usersDocRole: "read" } },
    });
    expect(w.audit.get(OUTCOME)!.metadata).not.toHaveProperty("outcomeDetail");
  });

  it("dry run / refusal: read-back is not_attempted and no snapshot is reported", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args([])), deps(w));
    expect(r.readBack).toEqual({ customClaims: "not_attempted", usersDocRole: "not_attempted" });
    expect(r.readBackClaims).toBeNull();
  });
});

describe("R3 MAJOR: the revocation cutoff is observed against a SERVER-anchored cutoff, never the operator clock", () => {
  const OUTCOME = "system-admin-claim:req_1_abc:outcome";
  const BEFORE_TVA = "Thu, 05 Nov 2026 09:00:00 GMT";
  const adminWorld = (skewMs = 0) => {
    const w = world();
    const t = w.users.get(TARGET)!;
    t.customClaims = { admin: true, plan: "pro" };
    t.tokensValidAfterTime = BEFORE_TVA;
    w.roles.set(TARGET, "admin");
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    w.skewMs = skewMs;
    return w;
  };
  const evidenceOf = (r: Awaited<ReturnType<typeof runSystemAdminClaim>>) => r.sessionRevocationObservations!;
  const secs = (iso: string | null) => Math.floor(Date.parse(iso as string) / 1000);

  it("CONTROL accurate operator clock: cutoff observed; validSince >= cutoff = anchor second + 1 + 2 s margin", async () => {
    const w = adminWorld(0);
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["applied", 0, null]);
    const ev = evidenceOf(r);
    expect(ev.cutoffObserved).toBe(true);
    expect(secs(ev.cutoff)).toBe(secs(ev.anchorServerTime) + 3);
    expect(secs(ev.tokensValidAfterTimeAfter)).toBeGreaterThanOrEqual(secs(ev.cutoff));
    // The anchor is the role write's commit time, taken after the claim write returned.
    expect(w.calls.indexOf(`writeRole:${TARGET}:user`)).toBeGreaterThan(w.calls.indexOf(`writeCustomClaims:${TARGET}`));
    // The tool waited before revoking (operator clock has to pass the cutoff), and only then revoked.
    const sleepIdx = w.calls.findIndex((c) => c.startsWith("sleep:"));
    expect(sleepIdx).toBeGreaterThan(w.calls.indexOf(`writeRole:${TARGET}:user`));
    expect(sleepIdx).toBeLessThan(w.calls.indexOf(`revokeRefreshTokens:${TARGET}`));
    expect(w.audit.get(OUTCOME)!.metadata).toMatchObject({ outcome: "applied", completed: true, sessionRevocationObservations: { cutoffObserved: true } });
  });

  it("exit-0 output and observations keep the things apart: request + acknowledgment, observed cutoff, clock ASSUMPTION, effect not observable, enforcement caveat, no proof claim", async () => {
    const w = adminWorld(0);
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode]).toEqual(["applied", 0]);
    const m = r.message!;
    expect(m).toContain("revocation requested and acknowledged; cutoff observed at or after the server-anchored cutoff under the Firestore≈Auth clock assumption (skew < 2 s assumed, unbounded); effective revocation not observable");
    expect(m).toContain("ASSUMPTION (unchecked by this tool)");
    expect(m).toMatch(/not proof that sessions were revoked/);
    expect(m).toMatch(/verify ID tokens without checkRevoked/);
    expect(m).toMatch(/up to about 1 hour/);
    expect(m).toMatch(/awaits S2/);
    // Only negated forms ("not proof") may appear; no affirmative proof wording.
    expect(m.replace(/\b(not|never|no)\s+(a\s+)?(proof|proven|guarantee|verified)\b/gi, "")).not.toMatch(/\b(proof|prove[sdn]?|proving|guarantee[sd]?|verified|verifies)\b/i);
    // No effect-implying "revoked" (the one negated use is the assumption text).
    expect(m.replace("not proof that sessions were revoked", "")).not.toMatch(/\brevoked\b/i);
    expect(w.calls).toContain(`log:${m}`);
    const ev = evidenceOf(r);
    expect(ev).toMatchObject({
      claimWrite: "confirmed", revocationRequested: true, revocationApiAcknowledged: true, cutoffObserved: true,
      sessionRevocationState: "CUTOFF_OBSERVED", effectiveRevocation: "not_observable", tokensValidAfterTimeLowerThanBefore: false,
      preCallCheck: { read: "read", decision: "call", tokensValidAfterTime: BEFORE_TVA },
    });
    expect([r.sessionRevocationState, r.effectiveRevocation]).toEqual(["CUTOFF_OBSERVED", "not_observable"]);
    expect(ev.clockAlignmentAssumption).toMatch(/unbounded/);
    expect(ev.currentPrivilegeEnforcement).toMatch(/S2/);
    expect(w.audit.get(OUTCOME)!.metadata).toMatchObject({
      effectiveRevocation: "not_observable",
      sessionRevocationState: "CUTOFF_OBSERVED",
      sessionRevocationObservations: { clockAlignmentAssumption: ev.clockAlignmentAssumption, currentPrivilegeEnforcement: ev.currentPrivilegeEnforcement },
    });
    expect(w.audit.get("system-admin-claim:req_1_abc:attempt")!.metadata).toMatchObject({ effectiveRevocation: "not_observable" });
    // Sessions-only re-run states the same.
    const r2 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_2_again"), deps(w));
    expect(r2.status).toBe("claim_already_absent_revocation_cutoff_observed");
    expect(r2.message).toContain("skew < 2 s assumed, unbounded); effective revocation not observable");
    expect(r2.message).toMatch(/awaits S2/);
    expect(r2.sessionRevocationObservations).toMatchObject({ claimWrite: "skipped_already_absent" });
    expect(w.audit.get("system-admin-claim:req_2_again:outcome")).toMatchObject({
      actionType: "SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED", metadata: { completed: true, effectiveRevocation: "not_observable" },
    });
  });

  it("a grant row carries no revocation fields (they are revoke-only)", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect([r.exitCode, r.sessionRevocationState, r.effectiveRevocation, r.sessionRevocationObservations]).toEqual([0, null, null, null]);
    for (const row of w.audit.values()) {
      expect(["effectiveRevocation" in (row.metadata as object), "sessionRevocationState" in (row.metadata as object)]).toEqual([false, false]);
    }
  });

  it("slow by less than the tolerance (1 s, i.e. an unsynced-but-close clock): cutoff observed on the server comparison", async () => {
    const w = adminWorld(-1_000);
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode]).toEqual(["applied", 0]);
    expect(secs(evidenceOf(r).tokensValidAfterTimeAfter)).toBeGreaterThanOrEqual(secs(evidenceOf(r).cutoff));
  });

  it("slow clock INSIDE the G3 gate but beyond the wait slack (2 s behind): CUTOFF_NOT_REACHED, exit 3 sessions_revoke_unverified", async () => {
    const w = adminWorld(-2_000);
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect(w.calls).toContain(`revokeRefreshTokens:${TARGET}`);
    expect([r.status, r.exitCode, r.code, r.sessionRevocationState]).toEqual(["incomplete", 3, "sessions_revoke_unverified", "CUTOFF_NOT_REACHED"]);
    expect(r.message).toMatch(/earlier than the server-anchored cutoff/);
    expect(r.message).toContain(RERUN_GUIDANCE);
    expect(r.message).not.toMatch(/command is safe|harmless|idempotent/i);
    expect(w.audit.get(OUTCOME)).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      metadata: { outcome: "sessions_revoke_unverified", completed: false, sessionRevocationState: "CUTOFF_NOT_REACHED" },
    });
  });

  it("boundary: validSince exactly ONE second below the cutoff fails; exactly AT the cutoff passes", async () => {
    // Pin the backend's validSince relative to the cutoff the tool derives.
    const run = async (offset: number) => {
      const w = adminWorld(0);
      const d = deps(w);
      d.auth.revokeRefreshTokens = async (uid) => {
        w.calls.push(`revokeRefreshTokens:${uid}`);
        w.writes++;
        const anchorSec = Math.floor(Date.parse(String(w.roleCommitIso)) / 1000);
        w.users.get(uid)!.tokensValidAfterTime = new Date((anchorSec + 3 + offset) * 1000).toUTCString();
      };
      const origRole = d.store.writeUsersDocRole;
      d.store.writeUsersDocRole = async (uid, role) => {
        const t = await origRole(uid, role);
        w.roleCommitIso = new Date(t.seconds * 1000).toISOString();
        return t;
      };
      // Faithful to the SDK: the clock the pre-call check reads is the clock the backend stamps from.
      const origNow = d.nowMs;
      d.nowMs = () => (w.roleCommitIso ? (Math.floor(Date.parse(w.roleCommitIso) / 1000) + 3 + offset) * 1000 + 500 : origNow());
      return runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
    };
    expect((await run(-1)).code).toBe("sessions_revoke_unverified");
    expect((await run(0)).code).toBeNull();
  });

  it("revocation call succeeds but the read-back record has NO tokensValidAfterTime => CUTOFF_ANOMALY, sessions_revoke_unverified", async () => {
    const w = adminWorld(0);
    const d = deps(w);
    d.auth.revokeRefreshTokens = async (uid) => {
      w.calls.push(`revokeRefreshTokens:${uid}`);
      w.writes++;
      delete w.users.get(uid)!.tokensValidAfterTime;
    };
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
    expect([r.exitCode, r.code, r.sessionRevocationState]).toEqual([3, "sessions_revoke_unverified", "CUTOFF_ANOMALY"]);
    expect(r.failureDetails.join()).toMatch(/no tokensValidAfterTime/);
  });

  it("a read-back far ahead of the anchor after a gate-checked clock (another writer) => CUTOFF_ANOMALY, exit 3 (never exit 0 with a note)", async () => {
    const w = adminWorld(0);
    const d = deps(w);
    const orig = d.auth.revokeRefreshTokens;
    d.auth.revokeRefreshTokens = async (uid) => {
      await orig(uid);
      w.users.get(uid)!.tokensValidAfterTime = new Date(w.serverMs + 3_600_000).toUTCString();
    };
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
    expect([r.exitCode, r.code, r.sessionRevocationState]).toEqual([3, "sessions_revoke_unverified", "CUTOFF_ANOMALY"]);
    expect(r.failureDetails.join()).toMatch(/more than 300s/);
  });

  it("revocation call succeeds but the Auth read-back throws => verification_failed AND sessions_revoke_unverified, exit 3", async () => {
    const w = adminWorld(0);
    w.fail.getUserAfterRevoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.exitCode, r.code, r.sessionRevocationState]).toEqual([3, "verification_failed", "ACKNOWLEDGED_UNOBSERVED"]);
    expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["verification_failed", "sessions_revoke_unverified"]);
    expect(evidenceOf(r)).toMatchObject({ cutoffObserved: false, tokensValidAfterTimeAfter: null });
  });

  describe("network failure at each step", () => {
    it("REVOKE claim write throws => no anchor write, revocation STILL called (privilege removal), INCOMPLETE mint_failed exit 3, recorded in result + audit", async () => {
      const w = adminWorld(0);
      w.fail.claims = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.status, r.exitCode, r.code, r.outcome]).toEqual(["incomplete", 3, "mint_failed", "mint_failed"]);
      expect(writeCalls(w)).toEqual([
        "createAuditRow:attempt", `writeCustomClaims:${TARGET}`, `revokeRefreshTokens:${TARGET}`, "createAuditRow:outcome",
      ]);
      expect(r.writesAttempted).toEqual(["audit_attempt_row", "custom_claims", "revoke_refresh_tokens", "audit_outcome_row"]);
      // No anchor => no wait, no cutoff, never "observed".
      expect(w.calls.some((c) => c.startsWith("sleep:"))).toBe(false);
      expect(evidenceOf(r)).toMatchObject({
        claimWrite: "unconfirmed", revocationApiAcknowledged: true, cutoffObserved: false, anchorServerTime: null, cutoff: null,
        sessionRevocationState: "ACKNOWLEDGED_UNOBSERVED",
      });
      expect(evidenceOf(r).detail).toMatch(/claim write threw and is UNCONFIRMED.*revokeRefreshTokens was still called and acknowledged/);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["mint_failed", "sessions_revoke_unverified"]);
      expect(w.audit.get(OUTCOME)).toMatchObject({
        actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
        metadata: {
          outcome: "mint_failed", completed: false,
          sessionRevocationObservations: { claimWrite: "unconfirmed", revocationApiAcknowledged: true, cutoffObserved: false },
        },
      });
      expect((w.audit.get(OUTCOME)!.metadata as { outcomeDetails: string[] }).outcomeDetails.join()).toMatch(/UNCONFIRMED/);
    });

    it("REVOKE claim write throws AND the revocation call fails => mint_failed + sessions_revoke_failed, exit 3", async () => {
      const w = adminWorld(0);
      w.fail.claims = true;
      w.fail.revoke = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.exitCode, r.code]).toEqual([3, "mint_failed"]);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["mint_failed", "sessions_revoke_failed"]);
      expect(evidenceOf(r)).toMatchObject({ claimWrite: "unconfirmed", revocationApiAcknowledged: false, cutoffObserved: false, sessionRevocationState: "REQUESTED_UNACKNOWLEDGED" });
    });

    it("GRANT claim write throws => no role write, no revocation (grant never revokes), mint_failed exit 3", async () => {
      const w = world();
      w.fail.claims = true;
      const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
      expect([r.exitCode, r.code]).toEqual([3, "mint_failed"]);
      expect(writeCalls(w)).toEqual(["createAuditRow:attempt", `writeCustomClaims:${TARGET}`, "createAuditRow:outcome"]);
      expect(r.sessionRevocationObservations).toBeNull();
    });

    it("server-time capture (role write) fails => revocation is STILL requested (no wait, local-clock validSince), but the run is INCOMPLETE", async () => {
      const w = adminWorld(0);
      w.fail.role = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect(writeCalls(w)).toEqual([
        "createAuditRow:attempt", `writeCustomClaims:${TARGET}`, `writeRole:${TARGET}:user`, `revokeRefreshTokens:${TARGET}`, "createAuditRow:outcome",
      ]);
      expect([r.exitCode, r.code]).toEqual([3, "users_doc_failed"]);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["users_doc_failed", "sessions_revoke_unverified"]);
      expect(r.failureDetails[1]).toMatch(/no server-time anchor/);
      // No anchor => no sleep: the tool never pretends a local wait is evidence.
      expect(w.calls.some((c) => c.startsWith("sleep:"))).toBe(false);
      expect(evidenceOf(r)).toMatchObject({ cutoffObserved: false, anchorServerTime: null, cutoff: null });
    });

    it("anchor that is NOT later than the attempt row's commit time (stale / no-op write time) => sessions_revoke_unverified", async () => {
      const w = adminWorld(0);
      const d = deps(w);
      const orig = d.store.writeUsersDocRole;
      d.store.writeUsersDocRole = async (uid, role) => {
        await orig(uid, role);
        return toServerTime(SERVER_START_MS - 60_000); // the document's previous update time
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      expect([r.exitCode, r.code]).toEqual([3, "sessions_revoke_unverified"]);
      expect(r.failureDetails[0]).toMatch(/not later than the attempt row/);
    });

    it("anchor missing from the role write result => sessions_revoke_unverified", async () => {
      const w = adminWorld(0);
      const d = deps(w);
      const orig = d.store.writeUsersDocRole;
      d.store.writeUsersDocRole = async (uid, role) => {
        await orig(uid, role);
        return undefined as unknown as { seconds: number; nanoseconds: number };
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      expect([r.exitCode, r.code]).toEqual([3, "sessions_revoke_unverified"]);
    });

    it("revocation call fails => sessions_revoke_failed, exit 3, REQUESTED_UNACKNOWLEDGED (effect UNKNOWN)", async () => {
      const w = adminWorld(0);
      w.fail.revoke = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.exitCode, r.code]).toEqual([3, "sessions_revoke_failed"]);
      expect(evidenceOf(r)).toMatchObject({
        cutoffObserved: false, revocationRequested: true, sessionRevocationState: "REQUESTED_UNACKNOWLEDGED",
        detail: "the revocation call failed or threw; its effect is UNKNOWN",
      });
    });

    it("attempt audit row fails => nothing else is written, no revocation, state NOT_REQUESTED", async () => {
      const w = adminWorld(0);
      w.fail.attempt = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.exitCode, r.code, r.sessionRevocationState, r.effectiveRevocation]).toEqual([3, "audit_attempt_failed", "NOT_REQUESTED", "not_observable"]);
      expect(writeCalls(w)).toEqual(["createAuditRow:attempt"]);
    });

    it("attempt row returns no commit time => the clock gate fails closed: exit 3 operator_clock_out_of_tolerance, no claim/role/revoke call", async () => {
      const w = adminWorld(0);
      const d = deps(w);
      const orig = d.store.createAuditRow;
      d.store.createAuditRow = async (id, rec) => {
        await orig(id, rec);
        return undefined as unknown as { seconds: number; nanoseconds: number };
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      expect([r.exitCode, r.code]).toEqual([3, "operator_clock_out_of_tolerance"]);
      expect(writeCalls(w)).toEqual(["createAuditRow:attempt", "createAuditRow:outcome"]);
      expect(r.failureDetails[0]).toMatch(/no usable server commit time/);
    });

    it("outcome audit row fails after an observed cutoff => audit_outcome_missing, exit 3 (never 0)", async () => {
      const w = adminWorld(0);
      w.fail.outcome = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.exitCode, r.code]).toEqual([3, "audit_outcome_missing"]);
      expect(evidenceOf(r).cutoffObserved).toBe(true);
    });
  });

  /**
   * G3 PRE-WRITE CLOCK GATE. The attempt row's commit time (server) must lie in
   * [localBefore − 2 s, localAfter + 2 s]. In this fake the attempt create ticks
   * RPC_LATENCY_MS before committing, so with skew k (operator − server):
   *   localBefore = s + k, commit = s + L, localAfter = s + L + k
   * and the gate accepts exactly −2000 ≤ k ≤ 2000 + L.
   */
  describe("G3: operator clock gate before any claim, role or revocation call", () => {
    const mutatingCalls = (w: World) => w.calls.filter((c) => /^(writeCustomClaims|writeRole|revokeRefreshTokens)/.test(c));

    it.each([
      ["revoke", -2_001, false], ["revoke", -2_000, true], ["revoke", 0, true], ["revoke", 2_000 + RPC_LATENCY_MS, true], ["revoke", 2_001 + RPC_LATENCY_MS, false],
      ["revoke", -10_000, false], ["revoke", 3_600_000, false],
      ["grant", -2_001, false], ["grant", 2_001 + RPC_LATENCY_MS, false], ["grant", 0, true],
    ] as const)("%s with operator skew %d ms: gate passes = %s", async (op, skewMs, passes) => {
      const w = op === "revoke" ? adminWorld(skewMs) : world();
      w.skewMs = skewMs;
      const exec = op === "revoke" ? REVOKE_EXEC : ["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`];
      const r = await runSystemAdminClaim(ctx(args(exec, op)), deps(w));
      if (passes) {
        expect(r.code).not.toBe("operator_clock_out_of_tolerance");
        expect(mutatingCalls(w).length).toBeGreaterThan(0);
        return;
      }
      expect([r.status, r.exitCode, r.code, r.outcome]).toEqual(["incomplete", 3, "operator_clock_out_of_tolerance", "operator_clock_out_of_tolerance"]);
      // ZERO claim, role or revocation calls; only the attempt and outcome rows.
      expect(mutatingCalls(w)).toEqual([]);
      expect(writeCalls(w)).toEqual(["createAuditRow:attempt", "createAuditRow:outcome"]);
      expect(r.writesAttempted).toEqual(["audit_attempt_row", "audit_outcome_row"]);
      expect(w.validSinceSent).toEqual([]);
      expect(r.failureDetails[0]).toMatch(new RegExp(`^operator_clock_out_of_tolerance: the operator clock is outside the 2 s tolerance .* operator clock ${skewMs > 0 ? "ahead" : "behind"} by about \\d+ s\\)\\. No claim, role or revocation call was made`));
      const row = w.audit.get(OUTCOME)!;
      expect(row).toMatchObject({ actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE", metadata: { outcome: "operator_clock_out_of_tolerance", completed: false } });
      if (op === "revoke") {
        expect(r.sessionRevocationObservations).toMatchObject({ sessionRevocationState: "NOT_REQUESTED", claimWrite: "not_attempted", revocationRequested: false, preCallCheck: { read: "not_attempted", decision: "not_reached" } });
        expect(row.metadata).toMatchObject({ sessionRevocationState: "NOT_REQUESTED", effectiveRevocation: "not_observable" });
        // The claim is untouched.
        expect(w.users.get(TARGET)!.customClaims).toEqual({ admin: true, plan: "pro" });
      }
    });

    it("request latency widens the window (measured, not assumed): a 1.5 s attempt create admits a clock 3.4 s ahead, still refuses 2.1 s behind", async () => {
      const slowCreate = (w: World, d: ExecutionDeps<string>) => {
        const orig = d.store.createAuditRow;
        d.store.createAuditRow = async (id, rec) => {
          if (id.endsWith(":attempt")) w.serverMs += 1_500;
          return orig(id, rec);
        };
        return d;
      };
      const ahead = adminWorld(3_400);
      const ra = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), slowCreate(ahead, deps(ahead)));
      expect(ra.code).not.toBe("operator_clock_out_of_tolerance");
      const behind = adminWorld(-2_100);
      const rb = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), slowCreate(behind, deps(behind)));
      expect(rb.code).toBe("operator_clock_out_of_tolerance");
    });

    it("a clock read that steps backward across the attempt create fails closed", async () => {
      const w = adminWorld(0);
      const d = deps(w);
      const reads = [SERVER_START_MS + 10_000, SERVER_START_MS];
      d.nowMs = () => reads.shift() ?? w.serverMs;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      expect(r.code).toBe("operator_clock_out_of_tolerance");
      expect(r.failureDetails[0]).toMatch(/stepped backward/);
    });

    it("re-running with the same off clock is refused the same way; after the clock is synced the re-run removes the claim (claim was never touched)", async () => {
      const w = adminWorld(-30_000);
      const r1 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_1_a"), deps(w));
      const r2 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_2_b"), deps(w));
      expect([r1.code, r2.code]).toEqual(["operator_clock_out_of_tolerance", "operator_clock_out_of_tolerance"]);
      expect(w.calls.some((c) => /^(writeCustomClaims|revokeRefreshTokens)/.test(c))).toBe(false);
      w.skewMs = 0;
      const r3 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_3_c"), deps(w));
      expect([r3.status, r3.exitCode]).toEqual(["applied", 0]);
      expect(w.audit.get("system-admin-claim:req_3_c:outcome")).toMatchObject({ actionType: "REVOKE_SYSTEM_ADMIN_CLAIM", metadata: { completed: true } });
    });
  });

  /**
   * G2 REFUSE-IF-AHEAD. Immediately before the call, a FRESH getUser gives
   * S (whole seconds) and the operator clock gives V = floor(now / 1000).
   * V < S => no call (exit 4 stored_cutoff_ahead); V >= S => call. A failed
   * fresh read => no call (exit 3 pre_call_read_failed; owner decision: no
   * fallback to the pre-run read or any assumed value).
   *
   * `storedDuringWait` sets the stored value while the tool waits (after the
   * pre-run read, before the fresh read), relative to the V the tool will
   * compute: the fresh getUser ticks RPC_LATENCY_MS before nowMs is read.
   */
  describe("G2: fresh pre-call read; the call is not made when it would lower the stored value", () => {
    const storedDuringWait = (w: World, d: ExecutionDeps<string>, relToV: number | "garbage") => {
      const origSleep = d.sleepMs;
      d.sleepMs = async (ms) => {
        await origSleep(ms);
        const v = Math.floor((w.serverMs + RPC_LATENCY_MS + w.skewMs) / 1000);
        w.users.get(TARGET)!.tokensValidAfterTime = relToV === "garbage" ? "not a date" : new Date((v + relToV) * 1000).toUTCString();
      };
      return d;
    };

    it.each([
      [-1, true], [0, true], [1, false], [3600, false],
    ] as const)("stored S = V %+d s => call made: %s", async (rel, called) => {
      const w = adminWorld(0);
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), storedDuringWait(w, deps(w), rel));
      const ev = evidenceOf(r);
      expect(ev.preCallCheck.read).toBe("read");
      expect(ev.preCallCheck.storedSeconds! - ev.preCallCheck.localSeconds!).toBe(rel);
      expect(w.calls.filter((c) => c.startsWith("revokeRefreshTokens")).length).toBe(called ? 1 : 0);
      if (called) {
        expect(ev.preCallCheck.decision).toBe("call");
        expect([r.exitCode, ev.sessionRevocationState]).toEqual([0, "CUTOFF_OBSERVED"]);
        return;
      }
      // Not called: the stored value is untouched, the claim removal is kept and reported.
      expect(w.validSinceSent).toEqual([]);
      expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
      expect([r.status, r.exitCode, r.code, r.outcome]).toEqual(["review_required", 4, "stored_cutoff_ahead", "stored_cutoff_ahead"]);
      expect(ev).toMatchObject({ sessionRevocationState: "NOT_REQUESTED", revocationRequested: false, revocationApiAcknowledged: false, cutoffObserved: false, preCallCheck: { decision: "skip_stored_ahead" } });
      expect(r.writesAttempted).not.toContain("revoke_refresh_tokens");
      expect(r.message).toMatch(/^REVIEW REQUIRED \(stored_cutoff_ahead\)\. /);
      expect(r.message).toContain(REVIEW_GUIDANCE);
      expect(r.message).not.toContain(RERUN_GUIDANCE);
      expect(r.message).toMatch(/revokeRefreshTokens was NOT called/);
      expect(w.audit.get(OUTCOME)).toMatchObject({
        actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
        after: { customClaims: { plan: "pro" }, usersDocRole: "user" },
        metadata: { outcome: "stored_cutoff_ahead", completed: false, sessionRevocationState: "NOT_REQUESTED", effectiveRevocation: "not_observable" },
      });
    });

    it("the decision uses the FRESH read, not the pre-run read: pre-run behind, stored ahead by the time of the call => no call", async () => {
      const w = adminWorld(0);
      expect(Date.parse(BEFORE_TVA)).toBeLessThan(SERVER_START_MS);
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), storedDuringWait(w, deps(w), 5));
      expect(evidenceOf(r).tokensValidAfterTimeBefore).toBe(BEFORE_TVA);
      expect([r.exitCode, r.code]).toEqual([4, "stored_cutoff_ahead"]);
      expect(w.validSinceSent).toEqual([]);
    });

    it("the fresh read is taken immediately before the call: after the role write and the wait, with no other call between", async () => {
      const w = adminWorld(0);
      await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      const i = w.calls.indexOf(`revokeRefreshTokens:${TARGET}`);
      expect(w.calls[i - 1]).toBe(`getUser:${TARGET}`);
      expect(w.calls[i - 2]).toMatch(/^sleep:/);
    });

    it("OWNER CHANGE: the fresh read FAILS => no call, exit 3 pre_call_read_failed, state NOT_REQUESTED — never a fallback to the pre-run value", async () => {
      const w = adminWorld(0);
      w.fail.getUserAfterWrite = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect(w.calls.some((c) => c.startsWith("revokeRefreshTokens"))).toBe(false);
      expect(w.validSinceSent).toEqual([]);
      expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "pre_call_read_failed"]);
      expect(r.failureDetails[0]).toMatch(/^pre_call_read_failed: the fresh Auth read immediately before revokeRefreshTokens failed \(auth\/internal-error\); the call was NOT made/);
      expect(evidenceOf(r)).toMatchObject({
        sessionRevocationState: "NOT_REQUESTED", revocationRequested: false,
        preCallCheck: { read: "failed", decision: "refuse_read_failed", storedSeconds: null, localSeconds: null, tokensValidAfterTime: null },
      });
      expect(r.writesAttempted).toEqual(["audit_attempt_row", "custom_claims", "users_doc_role", "audit_outcome_row"]);
      expect(r.message).toContain(RERUN_GUIDANCE);
      expect(w.audit.get(OUTCOME)).toMatchObject({ metadata: { outcome: "pre_call_read_failed", completed: false, sessionRevocationState: "NOT_REQUESTED" } });
    });

    it("the fresh read fails even when the pre-run value would have allowed the call (absent): still no call", async () => {
      const w = adminWorld(0);
      delete w.users.get(TARGET)!.tokensValidAfterTime;
      w.fail.getUserAfterWrite = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
      expect([r.code, w.calls.filter((c) => c.startsWith("revokeRefreshTokens")).length]).toEqual(["pre_call_read_failed", 0]);
    });

    it.each([
      ["an unparseable stored value", (w: World, d: ExecutionDeps<string>) => storedDuringWait(w, d, "garbage")],
      ["a record for another uid", (w: World, d: ExecutionDeps<string>) => {
        const orig = d.auth.getUser;
        let n = 0;
        d.auth.getUser = async (uid) => {
          const u = await orig(uid);
          // 1 = pre-run target read, 2 = operator live read, 3 = the fresh pre-call read.
          return ++n === 3 ? { ...u, uid: "SomeoneElse" } : u;
        };
        return d;
      }],
    ])("the fresh read returns %s => no call, exit 3 pre_call_read_failed", async (_label, rig) => {
      const w = adminWorld(0);
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), rig(w, deps(w)));
      expect([r.exitCode, r.code, w.calls.filter((c) => c.startsWith("revokeRefreshTokens")).length]).toEqual([3, "pre_call_read_failed", 0]);
      expect(evidenceOf(r).preCallCheck.decision).toBe("refuse_unusable");
    });

    it("a lowering visible ONLY against the fresh pre-call value is still detected (stored ahead, then lowered before the read-back, still above the pre-run value)", async () => {
      const w = adminWorld(0);
      const d = storedDuringWait(w, deps(w), 3600);
      const orig = d.auth.getUser;
      let n = 0;
      d.auth.getUser = async (uid) => {
        // 1 pre-run, 2 operator, 3 fresh pre-call, 4 read-back: lower by 10 s just before the read-back.
        if (++n === 4) {
          const s0 = secs(w.users.get(TARGET)!.tokensValidAfterTime!);
          w.users.get(TARGET)!.tokensValidAfterTime = new Date((s0 - 10) * 1000).toUTCString();
        }
        return orig(uid);
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      const ev = evidenceOf(r);
      expect(secs(ev.tokensValidAfterTimeAfter)).toBeGreaterThan(secs(BEFORE_TVA));
      expect(ev.tokensValidAfterTimeLowerThanBefore).toBe(true);
      expect([r.exitCode, r.code]).toEqual([4, "stored_cutoff_ahead"]);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["stored_cutoff_ahead", "revocation_cutoff_lowered"]);
    });

    it("stored-ahead on a run that also fails at the outcome row => exit 3 (3 > 4), with the review fact kept", async () => {
      const w = adminWorld(0);
      w.fail.outcome = true;
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), storedDuringWait(w, deps(w), 3600));
      expect([r.exitCode, r.code]).toEqual([3, "audit_outcome_missing"]);
      expect(r.failureDetails.map((d) => d.split(":")[0])).toEqual(["stored_cutoff_ahead", "audit_outcome_missing"]);
      expect(r.message).toContain("A review fact was ALSO recorded (stored_cutoff_ahead)");
    });
  });

  /**
   * CONCURRENCY over a fake Auth backend that overwrites validSince with the
   * CALLER's clock, floored to seconds (sdkRevoke), as accounts:update does.
   * No compare-and-set exists, so these pin what the tool narrows and what it
   * leaves (runbook, "Lowered cutoffs").
   */
  describe("concurrency: another writer inside the run window", () => {
    const withRevokeHook = (w: World, d: ExecutionDeps<string>, before?: () => void, after?: () => void) => {
      const orig = d.auth.revokeRefreshTokens;
      d.auth.revokeRefreshTokens = async (uid) => {
        before?.();
        await orig(uid);
        after?.();
      };
      return d;
    };

    it("RESIDUAL: a writer between the fresh read and the call stamps a HIGHER value; this run's call overwrites it (not detectable by this run)", async () => {
      const w = adminWorld(0);
      let x = 0;
      const d = withRevokeHook(w, deps(w), () => {
        x = Math.floor(w.serverMs / 1000) + 600;
        w.users.get(TARGET)!.tokensValidAfterTime = new Date(x * 1000).toUTCString();
      });
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      // The store really ends below the other writer's value...
      expect(secs(w.users.get(TARGET)!.tokensValidAfterTime!)).toBeLessThan(x);
      // ...and this run saw nothing ahead before its call: the documented interleaving window.
      expect(evidenceOf(r).preCallCheck.decision).toBe("call");
      expect(r.exitCode).toBe(0);
    });

    it("the OTHER run detects it: a lower write landing between a run's call and its read-back => CUTOFF_LOWERED, exit 4 revocation_cutoff_lowered, completed false", async () => {
      const w = adminWorld(0);
      const d = withRevokeHook(w, deps(w), undefined, () => {
        // Another caller's slower clock overwrites this run's value, one second lower (still >= the cutoff).
        const mine = secs(w.users.get(TARGET)!.tokensValidAfterTime!);
        w.users.get(TARGET)!.tokensValidAfterTime = new Date((mine - 1) * 1000).toUTCString();
      });
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      const ev = evidenceOf(r);
      expect(ev.cutoffObserved).toBe(true);
      expect([r.status, r.exitCode, r.code, r.outcome, ev.sessionRevocationState]).toEqual(["review_required", 4, "revocation_cutoff_lowered", "revocation_cutoff_lowered", "CUTOFF_LOWERED"]);
      expect(ev.tokensValidAfterTimeLowerThanBefore).toBe(true);
      expect(r.failureDetails[0]).toMatch(/^revocation_cutoff_lowered: the read-back tokensValidAfterTime .* is earlier than .*\(the value this run's call was cleared to write\), a value read earlier in this run \(cause not attributable/);
      expect(r.message).toContain(REVIEW_GUIDANCE);
      expect(r.message).not.toContain(RERUN_GUIDANCE);
      expect(r.message).not.toMatch(/^Applied|^Completed/);
      expect(w.audit.get(OUTCOME)).toMatchObject({
        actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
        metadata: { outcome: "revocation_cutoff_lowered", completed: false, sessionRevocationState: "CUTOFF_LOWERED" },
      });
    });

    it("a backward clock step between the check and the call is caught by the read-back (CUTOFF_LOWERED; below the cutoff it is exit 3, both recorded)", async () => {
      const w = adminWorld(0);
      const d = withRevokeHook(w, deps(w), () => { w.skewMs -= 3_000; });
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      const ev = evidenceOf(r);
      expect(ev.sessionRevocationState).toBe("CUTOFF_LOWERED");
      expect([r.exitCode, r.code]).toEqual([3, "sessions_revoke_unverified"]);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["sessions_revoke_unverified", "revocation_cutoff_lowered"]);
      expect(r.message).toContain("A review fact was ALSO recorded (revocation_cutoff_lowered)");
    });

    it("two operators interleaved: the second run's fresh read sees the first run's stamp; a slower second clock is refused, not written", async () => {
      const w = adminWorld(0);
      const r1 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_op1"), deps(w));
      expect(r1.exitCode).toBe(0);
      const stamped = w.users.get(TARGET)!.tokensValidAfterTime;
      // Operator 2 starts at once with a clock 1.9 s behind (inside the gate), so its V is below run 1's stamp.
      w.skewMs = -1_900;
      w.serverMs -= 4_000; // run 2 overlaps run 1 in server time
      const r2 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_op2"), deps(w));
      expect([r2.exitCode, r2.code]).toEqual([4, "stored_cutoff_ahead"]);
      expect(w.users.get(TARGET)!.tokensValidAfterTime).toBe(stamped);
      expect(w.validSinceSent).toHaveLength(1);
    });
  });

  /**
   * G1 GRID (spec): prior value × operator offset × acknowledgment × read-back.
   * The oracle below derives the expectation from quantities the fake records
   * (operator clock at the fresh read, the role write's commit second, what the
   * backend stored) — not from the tool's own result fields.
   */
  describe("G1 grid: exit, state, outcome, actionType, completed, message", () => {
    type Prior = "absent" | "behind" | "at_cutoff" | "ahead" | "far_ahead" | "unparseable";
    const PRIORS: Prior[] = ["absent", "behind", "at_cutoff", "ahead", "far_ahead", "unparseable"];
    const OFFSETS_S = [-5, -1, 0, 1, 5, 400];
    const ACKS = ["ok", "throw"] as const;
    const READBACKS = ["ok", "fail", "lowered"] as const;
    // The cutoff second of an accurate run in this fake is fixed by the
    // deterministic latency model: attempt commit, claim write, role write.
    const predictedCutoff = () => Math.floor((SERVER_START_MS + 4 * RPC_LATENCY_MS) / 1000) + 3;

    const seen = new Set<string>();
    const cells: [Prior, number, (typeof ACKS)[number], (typeof READBACKS)[number]][] = [];
    for (const p of PRIORS) for (const o of OFFSETS_S) for (const a of ACKS) for (const rb of READBACKS) cells.push([p, o, a, rb]);

    it.each(cells)("prior %s, offset %d s, ack %s, read-back %s", async (prior, offsetS, ack, rbMode) => {
      const w = adminWorld(offsetS * 1000);
      const cutoffGuess = predictedCutoff();
      const priorValue: Record<Prior, string | undefined> = {
        absent: undefined,
        behind: new Date((cutoffGuess - 60) * 1000).toUTCString(),
        at_cutoff: new Date(cutoffGuess * 1000).toUTCString(),
        ahead: new Date((cutoffGuess + 30) * 1000).toUTCString(),
        far_ahead: new Date((cutoffGuess + 7200) * 1000).toUTCString(),
        unparseable: "garbage",
      };
      const t = w.users.get(TARGET)!;
      if (priorValue[prior] === undefined) delete t.tokensValidAfterTime;
      else t.tokensValidAfterTime = priorValue[prior];
      if (ack === "throw") w.fail.revoke = true;

      // Recorders (oracle inputs).
      const d = deps(w);
      let roleCommitSec: number | null = null;
      const origRole = d.store.writeUsersDocRole;
      d.store.writeUsersDocRole = async (uid, role) => {
        const c = await origRole(uid, role);
        roleCommitSec = c.seconds;
        return c;
      };
      let getUsersAfterWrites = 0;
      let opClockAtFreshRead: number | null = null;
      let loweredTo: number | null = null;
      const origGet = d.auth.getUser;
      d.auth.getUser = async (uid) => {
        const isFreshRead = uid === TARGET && w.writes > 0 && getUsersAfterWrites === 0
          && w.calls.some((c) => c.startsWith("sleep:")) && !w.calls.some((c) => c.startsWith("revokeRefreshTokens"));
        const isReadBack = uid === TARGET && w.writes > 0 && !isFreshRead;
        if (rbMode === "fail" && isReadBack) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
        // When no call is made, a lowering writer still lands before the read-back.
        if (rbMode === "lowered" && loweredTo === null && uid === TARGET && getUsersAfterWrites >= 1 && !w.calls.some((c) => c.startsWith("revokeRefreshTokens"))) {
          const s0 = Date.parse(String(w.users.get(uid)!.tokensValidAfterTime));
          if (Number.isFinite(s0)) {
            loweredTo = Math.floor(s0 / 1000) - 1;
            w.users.get(uid)!.tokensValidAfterTime = new Date(loweredTo * 1000).toUTCString();
          }
        }
        const u = await origGet(uid); // throws first when configured to fail
        if (uid === TARGET && w.writes > 0) {
          getUsersAfterWrites++;
          if (getUsersAfterWrites === 1 && w.calls.some((c) => c.startsWith("sleep:")) && !w.calls.some((c) => c.startsWith("revokeRefreshTokens"))) {
            opClockAtFreshRead = w.serverMs + w.skewMs;
          }
        }
        return u;
      };
      const origRevoke = d.auth.revokeRefreshTokens;
      d.auth.revokeRefreshTokens = async (uid) => {
        try {
          await origRevoke(uid);
        } finally {
          if (rbMode === "lowered") {
            const v = Math.floor((opClockAtFreshRead as number) / 1000);
            loweredTo = v - 1;
            w.users.get(uid)!.tokensValidAfterTime = new Date(loweredTo * 1000).toUTCString();
          }
        }
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      const row = w.audit.get(OUTCOME)!;
      const revokeCalls = w.calls.filter((c) => c.startsWith("revokeRefreshTokens")).length;
      const claimCalls = w.calls.filter((c) => c.startsWith("writeCustomClaims")).length;
      const roleCalls = w.calls.filter((c) => c.startsWith("writeRole")).length;

      // ---- oracle ----
      type Exp = { exit: number; code: string | null; state: string; revokeCalls: number };
      let exp: Exp;
      const gateOk = Math.abs(offsetS) <= 1;
      if (!gateOk) {
        exp = { exit: 3, code: "operator_clock_out_of_tolerance", state: "NOT_REQUESTED", revokeCalls: 0 };
        expect([claimCalls, roleCalls]).toEqual([0, 0]);
      } else if (prior === "unparseable") {
        exp = { exit: 3, code: "pre_call_read_failed", state: "NOT_REQUESTED", revokeCalls: 0 };
      } else {
        expect(opClockAtFreshRead).not.toBeNull();
        const V = Math.floor((opClockAtFreshRead as number) / 1000);
        const S = priorValue[prior] === undefined ? null : Math.floor(Date.parse(priorValue[prior] as string) / 1000);
        const cutoff = (roleCommitSec as unknown as number) + 3;
        const priorsSec = [S].filter((x): x is number => x !== null);
        if (S !== null && V < S) {
          // No call. The read-back (if any) is S, or S-1 when a writer lowered it.
          const readFails = rbMode === "fail";
          exp = { exit: readFails ? 3 : 4, code: readFails ? "verification_failed" : "stored_cutoff_ahead", state: "NOT_REQUESTED", revokeCalls: 0 };
        } else if (ack === "throw") {
          const R = rbMode === "fail" ? null : rbMode === "lowered" ? (loweredTo as number) : S;
          const lowered = R !== null && priorsSec.length > 0 && R < Math.max(...priorsSec);
          exp = { exit: 3, code: rbMode === "fail" ? "sessions_revoke_failed" : "sessions_revoke_failed", state: lowered ? "CUTOFF_LOWERED" : "REQUESTED_UNACKNOWLEDGED", revokeCalls: 1 };
        } else if (rbMode === "fail") {
          exp = { exit: 3, code: "verification_failed", state: "ACKNOWLEDGED_UNOBSERVED", revokeCalls: 1 };
        } else {
          const R = rbMode === "lowered" ? (loweredTo as number) : secs(w.users.get(TARGET)!.tokensValidAfterTime!);
          if (rbMode === "ok") expect(R).toBe(w.validSinceSent[0]);
          const observed = R >= cutoff;
          const lowered = R < Math.max(V, ...priorsSec);
          const state = lowered ? "CUTOFF_LOWERED" : observed ? "CUTOFF_OBSERVED" : "CUTOFF_NOT_REACHED";
          exp = !observed
            ? { exit: 3, code: "sessions_revoke_unverified", state, revokeCalls: 1 }
            : lowered
              ? { exit: 4, code: "revocation_cutoff_lowered", state, revokeCalls: 1 }
              : { exit: 0, code: null, state, revokeCalls: 1 };
        }
      }

      expect({ exit: r.exitCode, code: r.code, state: r.sessionRevocationState, revokeCalls }).toEqual(exp);
      seen.add(`${exp.exit}:${exp.code}:${exp.state}`);
      expect(revokeCalls).toBeLessThanOrEqual(1);
      expect(r.sessionRevocationObservations!.sessionRevocationState).toBe(exp.state);
      expect(r.effectiveRevocation).toBe("not_observable");
      // Outcome row: actionType, completed, outcome, state agree with the exit.
      expect(row.metadata).toMatchObject({
        completed: exp.exit === 0,
        outcome: exp.exit === 0 ? "applied" : exp.code,
        sessionRevocationState: exp.state,
        effectiveRevocation: "not_observable",
      });
      expect(row.actionType).toBe(exp.exit === 0 ? "REVOKE_SYSTEM_ADMIN_CLAIM" : "SYSTEM_ADMIN_CLAIM_INCOMPLETE");
      expect(r.status).toBe(exp.exit === 0 ? "applied" : exp.exit === 4 ? "review_required" : "incomplete");
      // Never exit 0 with a lowered or ahead cutoff; never exit 4 when incomplete.
      if (exp.state === "CUTOFF_LOWERED") expect(r.exitCode).not.toBe(0);
      // Messages never state an effect: no "revoked" except the negated assumption text.
      expect(r.message!.replace(/not proof that sessions were revoked/g, "")).not.toMatch(/\brevoked\b/i);
    });

    it("CONTROL: the grid really reaches every exit class and every revoke state it claims to cover", () => {
      expect(cells).toHaveLength(6 * 6 * 2 * 3);
      for (const k of [
        "0:null:CUTOFF_OBSERVED",
        "4:revocation_cutoff_lowered:CUTOFF_LOWERED",
        "4:stored_cutoff_ahead:NOT_REQUESTED",
        "3:operator_clock_out_of_tolerance:NOT_REQUESTED",
        "3:pre_call_read_failed:NOT_REQUESTED",
        "3:sessions_revoke_failed:REQUESTED_UNACKNOWLEDGED",
        "3:sessions_revoke_failed:CUTOFF_LOWERED",
        "3:verification_failed:ACKNOWLEDGED_UNOBSERVED",
        "3:verification_failed:NOT_REQUESTED",
        "3:sessions_revoke_unverified:CUTOFF_LOWERED",
      ]) {
        expect({ k, seen: seen.has(k) }).toEqual({ k, seen: true });
      }
    });
  });

  describe("lowered cutoffs: recorded, never exit 0", () => {
    const syncedRun = async (w: World, id: string) => runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), id), deps(w));

    it("UNKNOWN direction is never reported as forward: no prior value and no call => null; read-back failed => null", async () => {
      const w2 = adminWorld(0);
      w2.fail.getUserAfterRevoke = true;
      const r2 = await syncedRun(w2, "req_norb");
      expect([r2.exitCode, r2.sessionRevocationObservations!.tokensValidAfterTimeLowerThanBefore]).toEqual([3, null]);
      const w3 = adminWorld(-10_000);
      delete w3.users.get(TARGET)!.tokensValidAfterTime;
      const r3 = await syncedRun(w3, "req_gate");
      expect([r3.exitCode, r3.sessionRevocationObservations!.tokensValidAfterTimeLowerThanBefore]).toEqual([3, null]);
    });

    it("CONTROL: two accurate runs in sequence move validSince forward: flag false, exit 0", async () => {
      const w = adminWorld(0);
      await syncedRun(w, "req_1_ok");
      const r2 = await syncedRun(w, "req_2_ok");
      expect([r2.status, r2.exitCode]).toEqual(["claim_already_absent_revocation_cutoff_observed", 0]);
      expect(r2.sessionRevocationObservations!.tokensValidAfterTimeLowerThanBefore).toBe(false);
      expect(r2.message).not.toMatch(/REVIEW|lower/i);
    });

    it("a lowering on a run that is already incomplete (role write failed) => exit 3 users_doc_failed, state CUTOFF_LOWERED, both recorded", async () => {
      const w = adminWorld(0);
      w.fail.role = true;
      const d = deps(w);
      const orig = d.auth.revokeRefreshTokens;
      d.auth.revokeRefreshTokens = async (uid) => {
        await orig(uid);
        w.users.get(uid)!.tokensValidAfterTime = BEFORE_TVA.replace("09:00:00", "08:00:00");
      };
      const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
      expect([r.exitCode, r.code, r.sessionRevocationState]).toEqual([3, "users_doc_failed", "CUTOFF_LOWERED"]);
      expect(r.failureDetails.map((x) => x.split(":")[0])).toEqual(["users_doc_failed", "sessions_revoke_unverified", "revocation_cutoff_lowered"]);
      expect(r.sessionRevocationObservations!.detail).toMatch(/no server-time anchor.*; the read-back tokensValidAfterTime .* is earlier than/);
    });

    it("every revoke that reaches the call calls revokeRefreshTokens EXACTLY once per run (no in-run retry); a failed fresh read makes zero calls", async () => {
      for (const [fail, n] of [[{}, 1], [{ revoke: true }, 1], [{ role: true }, 1], [{ claims: true }, 1], [{ getUserAfterRevoke: true }, 1], [{ outcome: true }, 1], [{ getUserAfterWrite: true }, 0]] as [World["fail"], number][]) {
        const w = adminWorld(0);
        w.fail = fail;
        await syncedRun(w, "req_once");
        expect({ fail, n: w.calls.filter((c) => c.startsWith("revokeRefreshTokens")).length }).toEqual({ fail, n });
      }
    });
  });

  describe("retry after partial claim removal", () => {
    it("claim write landed but the call threw => run 1 mint_failed, revocation still called; run 2 (same command) observes the cutoff, exit 0", async () => {
      const w = adminWorld(0);
      const d1 = deps(w);
      const orig = d1.auth.writeCustomClaims;
      d1.auth.writeCustomClaims = async (uid, claims) => {
        await orig(uid, claims);
        throw Object.assign(new Error("DEADLINE_EXCEEDED"), { code: "auth/internal-error" });
      };
      const r1 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_1_first"), d1);
      expect([r1.exitCode, r1.code]).toEqual([3, "mint_failed"]);
      expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
      // The claim removal may have applied server-side: the revocation is called anyway (privilege removal).
      expect(w.calls.filter((c) => c.startsWith("revokeRefreshTokens"))).toEqual([`revokeRefreshTokens:${TARGET}`]);
      expect(r1.sessionRevocationObservations).toMatchObject({ claimWrite: "unconfirmed", revocationApiAcknowledged: true, cutoffObserved: false });
      w.calls.length = 0;
      const r2 = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke"), "req_2_retry"), deps(w));
      expect([r2.status, r2.exitCode]).toEqual(["claim_already_absent_revocation_cutoff_observed", 0]);
      expect(w.calls.some((c) => c.startsWith("writeCustomClaims"))).toBe(false);
      expect(r2.sessionRevocationObservations!.cutoffObserved).toBe(true);
    });
  });
});

describe("R3 MINOR-1: disabled targets — revoke allowed, grant refused, never enabled", () => {
  it("revoke on a DISABLED admin target: claim removed, revocation requested with the cutoff observed, account stays disabled", async () => {
    const w = world();
    const t = w.users.get(TARGET)!;
    t.customClaims = { admin: true, plan: "pro" };
    t.disabled = true;
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["applied", 0, null]);
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
    expect(w.users.get(TARGET)!.disabled).toBe(true);
    expect(w.disabledWrites).toEqual([]);
    expect(w.calls).toContain(`revokeRefreshTokens:${TARGET}`);
    expect(w.calls).toContain("log:Target state:   DISABLED - the admin claim is still removed and refresh-token revocation is still requested; the account stays disabled.");
    expect(w.calls.join("\n")).not.toMatch(/sessions revoked/);
  });

  // The former "auth port has NO method that can change `disabled`" test here
  // enumerated the keys of THIS file's fake port, so it could never fail on a
  // change to the real wiring. It is replaced by behavioural tests against
  // the real port (realFirebaseFactory over a recording SDK Proxy) in
  // scripts/admin/__tests__/setSystemAdminClaimRealPorts.spec.ts.

  it("grant on a DISABLED target is refused with zero writes", async () => {
    const w = world();
    w.users.get(TARGET)!.disabled = true;
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect([r.status, r.exitCode, r.code, w.writes]).toEqual(["refused", 2, "target_disabled", 0]);
  });

  it("revoke on a record whose disabled state is not a boolean is refused (malformed record; fail closed)", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true };
    delete w.users.get(TARGET)!.disabled;
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code, w.writes]).toEqual(["refused", 2, "target_disabled", 0]);
  });
});

describe("R3 NIT: the result never carries the full target email (the audit row does)", () => {
  it("targetEmailMasked only", async () => {
    const w = world();
    const r = await runSystemAdminClaim(ctx(args(["--operator-id-token-file=/t", "--execute", `--confirm-claim=${GRANT_CONFIRM}`])), deps(w));
    expect(r.targetEmailMasked).toBe("targ…@…");
    expect(JSON.stringify(r)).not.toContain("target@example.com");
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")!.targetEmail).toBe("target@example.com");
  });
});
