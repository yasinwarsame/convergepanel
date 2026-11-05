/**
 * Orchestration tests over call-counting fakes. No Firebase, no network.
 * Proves: dry run performs zero writes (exit 2); the attempt audit row
 * precedes the claim write and its failure prevents the write but is exit 3
 * (outcome unknown), never 2; read-back and the outcome row follow; refusals
 * happen before any write; every revoke revokes sessions; a revoke re-run whose
 * claim is already absent completes the session revocation without rewriting
 * claims.
 */
import {
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
  fail: Partial<Record<"attempt" | "outcome" | "claims" | "revoke" | "role" | "getUserAfterWrite" | "readRoleAfterWrite" | "list", boolean>>;
  tokenDecoded: { uid: string; admin?: unknown } | { error: string };
  /** A broken backend that silently ignores the claim write. */
  dropClaimWrite?: boolean;
};

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
  };
}

function deps(w: World, overrides: Partial<ExecutionDeps<string>> = {}): ExecutionDeps<string> {
  let wroteClaims = false;
  const auth: ClaimAuthPort = {
    getUser: async (uid) => {
      w.calls.push(`getUser:${uid}`);
      if ((wroteClaims || w.writes > 0) && w.fail.getUserAfterWrite) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
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
      w.calls.push(`writeCustomClaims:${uid}`);
      w.writes++;
      wroteClaims = true;
      if (w.fail.claims) throw Object.assign(new Error("x"), { code: "auth/internal-error" });
      if (w.dropClaimWrite) return;
      const u = w.users.get(uid)!;
      u.customClaims = JSON.parse(JSON.stringify(claims));
    },
    revokeRefreshTokens: async (uid) => {
      w.calls.push(`revokeRefreshTokens:${uid}`);
      w.writes++;
      if (w.fail.revoke) throw new Error("x");
      w.users.get(uid)!.tokensValidAfterTime = new Date(Date.parse("2026-11-05T10:00:05Z")).toUTCString();
    },
  };
  const store: ClaimStorePort = {
    readUsersDocRole: async (uid) => {
      w.calls.push(`readRole:${uid}`);
      if (w.fail.readRoleAfterWrite && w.writes > 0) throw Object.assign(new Error("x"), { code: "unavailable" });
      return w.roles.get(uid) ?? null;
    },
    writeUsersDocRole: async (uid, role) => {
      w.calls.push(`writeRole:${uid}:${role}`);
      w.writes++;
      if (w.fail.role) throw new Error("x");
      w.roles.set(uid, role);
    },
    createAuditRow: async (id, record) => {
      const phase = id.endsWith(":attempt") ? "attempt" : "outcome";
      w.calls.push(`createAuditRow:${phase}`);
      w.writes++;
      if (w.fail[phase]) throw new Error("audit down");
      if (w.audit.has(id)) throw new Error("ALREADY_EXISTS");
      w.audit.set(id, JSON.parse(JSON.stringify(record)));
    },
  };
  return {
    auth,
    store,
    timestampNow: () => "TS",
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
    expect(r.expectedConfirmation).toBe(`revoke:admin:removed:sessions-revoked:${PROJECT}:${TARGET}`);
    expect(w.calls).toContain("log:Sessions:       the target's refresh tokens WILL be revoked (mandatory on revoke; signs the user out everywhere).");
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

  it("revoke removes only admin, ALWAYS revokes tokens, verifies tokensValidAfterTime", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true, plan: "pro" };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.outcome]).toEqual(["applied", 0, "applied"]);
    expect(r.sessionRevocation).toBe("required");
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
    expect(writeCalls(w)).toEqual([
      "createAuditRow:attempt",
      `writeCustomClaims:${TARGET}`,
      `revokeRefreshTokens:${TARGET}`,
      `writeRole:${TARGET}:user`,
      "createAuditRow:outcome",
    ]);
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
    expect(r.message).toMatch(/Re-running the same command is safe/);
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
  it("sessions_revoke_failed is INCOMPLETE (exit 3), says re-run is safe, and is recorded as incomplete", async () => {
    const w = world();
    w.users.get(TARGET)!.customClaims = { admin: true };
    w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
    w.fail.revoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "sessions_revoke_failed"]);
    expect(r.message).toMatch(/^INCOMPLETE/);
    expect(r.message).toMatch(/Re-running the same command is safe/);
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

  describe("MINOR-3: session revocation is judged on server timestamps only", () => {
    const revokeExec = REVOKE_EXEC;
    const setup = (serverAfter: string | null) => {
      const w = world();
      const target = w.users.get(TARGET)!;
      target.customClaims = { admin: true };
      target.tokensValidAfterTime = "Thu, 05 Nov 2026 09:00:00 GMT"; // server value before the write
      w.users.set(OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } });
      const d = deps(w);
      d.auth.revokeRefreshTokens = async (uid) => {
        w.calls.push(`revokeRefreshTokens:${uid}`);
        w.writes++;
        if (serverAfter !== null) w.users.get(uid)!.tokensValidAfterTime = serverAfter;
      };
      return { w, d };
    };
    it("local clock far BEHIND the server: a real revocation still verifies", async () => {
      const { d } = setup("Thu, 05 Nov 2026 10:00:00 GMT");
      const realNow = Date.now;
      Date.now = () => Date.parse("2001-01-01T00:00:00Z");
      try {
        expect((await runSystemAdminClaim(ctx(args(revokeExec, "revoke")), d)).status).toBe("applied");
      } finally {
        Date.now = realNow;
      }
    });
    it("local clock far AHEAD of the server: a real revocation still verifies", async () => {
      const { d } = setup("Thu, 05 Nov 2026 10:00:00 GMT");
      const realNow = Date.now;
      Date.now = () => Date.parse("2099-01-01T00:00:00Z");
      try {
        expect((await runSystemAdminClaim(ctx(args(revokeExec, "revoke")), d)).status).toBe("applied");
      } finally {
        Date.now = realNow;
      }
    });
    it("a revocation that did not advance the server value fails verification (whatever the local clock says)", async () => {
      const { d } = setup(null);
      const realNow = Date.now;
      Date.now = () => Date.parse("2001-01-01T00:00:00Z");
      try {
        const r = await runSystemAdminClaim(ctx(args(revokeExec, "revoke")), d);
        expect([r.exitCode, r.code]).toEqual([3, "verification_failed"]);
      } finally {
        Date.now = realNow;
      }
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

  it("run 1 sessions_revoke_failed (exit 3) -> run 2, same command: completes sessions, no claim write, exit 0", async () => {
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
      "claim_already_absent_sessions_revoked", 0, null, "claim_already_absent_sessions_revoked",
    ]);
    expect(r2.claimWrite).toBe("skip_already_absent");
    expect(r2.message).not.toMatch(/no change/i);
    // Claims are NOT rewritten (same object, never passed to writeCustomClaims); unrelated claims intact.
    expect(writeCalls(w)).toEqual([
      "createAuditRow:attempt",
      `revokeRefreshTokens:${TARGET}`,
      `writeRole:${TARGET}:user`, // still outstanding from run 1
      "createAuditRow:outcome",
    ]);
    expect(w.users.get(TARGET)!.customClaims).toBe(claimsObject);
    expect(w.users.get(TARGET)!.customClaims).toEqual({ plan: "pro", team: { id: "t1" } });
    expect(w.users.get(TARGET)!.tokensValidAfterTime).not.toBe(BEFORE_TVA);
    expect(w.audit.get("system-admin-claim:req_2_retry:attempt")).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_ATTEMPT",
      metadata: { claimWrite: "skip_already_absent", sessionRevocation: "required", completed: false },
    });
    expect(w.audit.get("system-admin-claim:req_2_retry:outcome")).toMatchObject({
      actionType: "REVOKE_SYSTEM_ADMIN_SESSIONS",
      metadata: { outcome: "claim_already_absent_sessions_revoked", completed: true, claimWrite: "skip_already_absent" },
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

  it("role already 'user' => the retry writes NOTHING but the attempt row, the session revocation and the outcome row", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    w.roles.set(TARGET, "user");
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode]).toEqual(["claim_already_absent_sessions_revoked", 0]);
    expect(writeCalls(w)).toEqual(["createAuditRow:attempt", `revokeRefreshTokens:${TARGET}`, "createAuditRow:outcome"]);
  });

  it("session revocation failing AGAIN on the retry => INCOMPLETE exit 3, never no_change/0", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    w.fail.revoke = true;
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), deps(w));
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "sessions_revoke_failed"]);
    expect(r.message).toMatch(/Re-running the same command is safe/);
    expect(w.calls.some((c) => c.startsWith("writeCustomClaims"))).toBe(false);
    expect(w.audit.get("system-admin-claim:req_1_abc:outcome")).toMatchObject({
      actionType: "SYSTEM_ADMIN_CLAIM_INCOMPLETE",
      metadata: { outcome: "sessions_revoke_failed", completed: false },
    });
  });

  it("a retry whose revocation does not advance tokensValidAfterTime => verification_failed, exit 3", async () => {
    const w = revokeWorld();
    w.users.get(TARGET)!.customClaims = { plan: "pro" };
    const d = deps(w);
    d.auth.revokeRefreshTokens = async (uid) => {
      w.calls.push(`revokeRefreshTokens:${uid}`);
      w.writes++;
    };
    const r = await runSystemAdminClaim(ctx(args(REVOKE_EXEC, "revoke")), d);
    expect([r.exitCode, r.code]).toEqual([3, "verification_failed"]);
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
    w.fail.getUserAfterWrite = true;
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
    w.fail.getUserAfterWrite = true;
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
