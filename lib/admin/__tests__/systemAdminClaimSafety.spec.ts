/**
 * Pure-module tests for the SYSTEM_ADMIN claim operator tool. Every guard has a
 * CONTROL (a valid input that passes, so the refusal assertion is not
 * vacuous) and a NEGATIVE case that must produce the named refusal code.
 */
import {
  CLAIMS_MAX_BYTES,
  REFUSAL_CODES,
  auditDocId,
  buildClaimAuditRecord,
  canonicalJson,
  checkBootstrapFirstAdmin,
  checkConfirmation,
  checkIdTokenShape,
  checkOperatorAuthorization,
  checkPlanInvariants,
  checkResultDirStat,
  checkResultPath,
  checkRevokeSafety,
  checkRuntimeEnvironment,
  checkSecretFileMode,
  checkTargetRecord,
  classifyOperatorTokenError,
  countAdminHolders,
  expectedConfirmation,
  generateRequestId,
  maskEmail,
  parseSetSystemAdminClaimArgs,
  planClaimChange,
  unrelatedClaimsFingerprint,
  validateServiceAccountKey,
  verifyReadBack,
  verifySessionsRevoked,
  type ClaimPlan,
} from "../systemAdminClaimSafety";

const UID = "AbCdEfGhIjKlMnOpQrStUvWxYz12";
const PROJECT = "cp-rehearsal-1";

const GRANT = [
  `--confirm-project=${PROJECT}`,
  "--credentials=/keys/sa.json",
  `--target-uid=${UID}`,
  "--operation=grant",
];
const REVOKE = [
  `--confirm-project=${PROJECT}`,
  "--credentials=/keys/sa.json",
  `--target-uid=${UID}`,
  "--operation=revoke",
  "--revoke-sessions=no",
  "--allow-claim-reduction",
];

function parseCode(argv: string[]): string {
  const r = parseSetSystemAdminClaimArgs(argv);
  return r.ok ? "ok" : r.code;
}
const without = (argv: string[], prefix: string) => argv.filter((a) => !a.startsWith(prefix));

describe("checkRuntimeEnvironment", () => {
  it("CONTROL: a clean operator shell passes (NODE_ENV=development, empty VERCEL)", () => {
    expect(checkRuntimeEnvironment({ NODE_ENV: "development", VERCEL: "" })).toBeNull();
  });
  it.each([
    [{ VERCEL: "1" }],
    [{ VERCEL_ENV: "preview" }],
    [{ NEXT_RUNTIME: "nodejs" }],
    [{ NODE_ENV: "production" }],
  ])("refuses runtime_unsafe for %j", (env) => {
    expect(checkRuntimeEnvironment(env)?.code).toBe("runtime_unsafe");
  });
  it.each([[{ FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }], [{ FIRESTORE_EMULATOR_HOST: "localhost:8080" }]])(
    "refuses emulator_env_present for %j",
    (env) => {
      expect(checkRuntimeEnvironment(env)?.code).toBe("emulator_env_present");
    },
  );
});

describe("parseSetSystemAdminClaimArgs", () => {
  it("CONTROL: a minimal grant dry run parses with execute=false", () => {
    const r = parseSetSystemAdminClaimArgs(GRANT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toMatchObject({ operation: "grant", targetUid: UID, confirmProject: PROJECT, execute: false, revokeSessions: null });
    }
  });
  it("CONTROL: a revoke with every required flag parses", () => {
    const r = parseSetSystemAdminClaimArgs(REVOKE);
    expect(r.ok && r.args.revokeSessions).toBe("no");
  });
  it("CONTROL: execute with a confirmation parses", () => {
    expect(parseCode([...GRANT, "--execute", "--confirm-claim=x"])).toBe("ok");
  });

  it("dry run is the default: no --execute means execute === false", () => {
    const r = parseSetSystemAdminClaimArgs([...GRANT, "--operator-id-token-file=/t"]);
    expect(r.ok && r.args.execute).toBe(false);
  });

  it.each<[string, string[]]>([
    ["unknown_flag", [...GRANT, "--yes"]],
    ["unknown_flag", [...GRANT, "--dry-run"]],
    ["unknown_flag", [...GRANT, "--target-email=a@b.c"]],
    ["duplicate_flag", [...GRANT, `--target-uid=${UID}`]],
    ["duplicate_flag", [...GRANT, "--execute", "--execute", "--confirm-claim=x"]],
    ["positional_arg", [...GRANT, UID]],
    ["flag_value_missing", [...without(GRANT, "--target-uid"), "--target-uid="]],
    ["flag_value_missing", [...without(GRANT, "--target-uid"), "--target-uid"]],
    ["flag_value_unexpected", [...GRANT, "--execute=true", "--confirm-claim=x"]],
    ["project_confirmation_missing", without(GRANT, "--confirm-project")],
    ["project_id_invalid", [...without(GRANT, "--confirm-project"), "--confirm-project=Bad_Project"]],
    ["credentials_missing", without(GRANT, "--credentials")],
    ["operation_missing", without(GRANT, "--operation")],
    ["operation_invalid", [...without(GRANT, "--operation"), "--operation=GRANT"]],
    ["target_missing_arg", without(GRANT, "--target-uid")],
    ["target_uid_invalid", [...without(GRANT, "--target-uid"), "--target-uid=a@b.com"]],
    ["target_uid_invalid", [...without(GRANT, "--target-uid"), `--target-uid=${"a".repeat(129)}`]],
    ["revoke_sessions_missing", without(REVOKE, "--revoke-sessions")],
    ["revoke_sessions_invalid", [...without(REVOKE, "--revoke-sessions"), "--revoke-sessions=true"]],
    ["reduction_flag_missing", without(REVOKE, "--allow-claim-reduction")],
    ["flag_conflict", [...GRANT, "--revoke-sessions=yes"]],
    ["flag_conflict", [...GRANT, "--allow-claim-reduction"]],
    ["flag_conflict", [...REVOKE, "--bootstrap-first-admin"]],
    ["flag_conflict", [...GRANT, "--bootstrap-first-admin", "--operator-id-token-file=/t"]],
    ["flag_conflict", [...GRANT, "--confirm-claim=x"]],
    ["confirmation_missing", [...GRANT, "--execute"]],
  ])("refuses %s", (code, argv) => {
    expect(parseCode(argv)).toBe(code);
  });

  it("there is no default project and no default target (an empty argv refuses)", () => {
    expect(parseCode([])).toBe("project_confirmation_missing");
  });
});

describe("checkSecretFileMode", () => {
  it("CONTROL: a regular 0600 file passes", () => {
    expect(checkSecretFileMode({ isFile: true, mode: 0o100600 }, "credentials_file_unsafe", "f")).toBeNull();
    expect(checkSecretFileMode({ isFile: true, mode: 0o100400 }, "credentials_file_unsafe", "f")).toBeNull();
  });
  it.each([0o100640, 0o100604, 0o100644, 0o100660])("refuses mode %o", (mode) => {
    expect(checkSecretFileMode({ isFile: true, mode }, "operator_token_file_unsafe", "f")?.code).toBe("operator_token_file_unsafe");
  });
  it("refuses a non-regular file", () => {
    expect(checkSecretFileMode({ isFile: false, mode: 0o40700 }, "credentials_file_unsafe", "f")?.code).toBe("credentials_file_unsafe");
  });
});

describe("validateServiceAccountKey", () => {
  const FAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-MATERIAL-DO-NOT-PRINT\n-----END PRIVATE KEY-----\n";
  const key = { type: "service_account", project_id: PROJECT, client_email: "firebase-adminsdk@cp-rehearsal-1.iam.gserviceaccount.com", private_key: FAKE_PRIVATE_KEY };

  it("CONTROL: a valid key for the confirmed project passes and only masked email is in evidence", () => {
    const r = validateServiceAccountKey(key, PROJECT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence).toEqual({
        source: "explicit-key-file",
        projectId: PROJECT,
        clientEmail: key.client_email,
        clientEmailMasked: "fire…@…",
      });
      expect(JSON.stringify(r.evidence)).not.toContain("FAKE-KEY-MATERIAL");
    }
  });
  it.each<[string, unknown]>([
    ["not an object", "x"],
    ["array", []],
    ["wrong type", { ...key, type: "authorized_user" }],
    ["missing project_id", { ...key, project_id: undefined }],
    ["missing client_email", { ...key, client_email: undefined }],
    ["missing private_key", { ...key, private_key: undefined }],
    ["non-PEM private_key", { ...key, private_key: "abc" }],
  ])("refuses credentials_invalid: %s", (_label, raw) => {
    expect((validateServiceAccountKey(raw, PROJECT) as { code?: string }).code).toBe("credentials_invalid");
  });
  it("refuses project_confirmation_mismatch when project_id differs from --confirm-project", () => {
    const r = validateServiceAccountKey({ ...key, project_id: "convergepanel" }, PROJECT);
    expect(r.ok ? "ok" : r.code).toBe("project_confirmation_mismatch");
  });
  it("no refusal message ever contains private key material", () => {
    const msgs = [
      validateServiceAccountKey({ ...key, type: "x" }, PROJECT),
      validateServiceAccountKey({ ...key, project_id: "otherproj" }, PROJECT),
      validateServiceAccountKey({ ...key, client_email: 3 }, PROJECT),
    ].map((r) => (r.ok ? "" : r.message));
    for (const m of msgs) expect(m).not.toContain("FAKE-KEY-MATERIAL");
  });
});

describe("checkResultPath", () => {
  const repo = "/Users/op/Apps/CP";
  it("CONTROL: a tmp path outside the repo passes", () => {
    expect(checkResultPath({ resolvedFile: "/tmp/x/r.json", resolvedDir: "/tmp/x", repoRoot: repo })).toBeNull();
  });
  it("CONTROL: a sibling directory with a shared prefix is not 'inside'", () => {
    expect(checkResultPath({ resolvedFile: "/Users/op/Apps/CP-other/r.json", resolvedDir: "/Users/op/Apps/CP-other", repoRoot: repo })).toBeNull();
  });
  it("refuses result_path_inside_repo", () => {
    expect(checkResultPath({ resolvedFile: `${repo}/out/r.json`, resolvedDir: `${repo}/out`, repoRoot: repo })?.code).toBe("result_path_inside_repo");
    expect(checkResultPath({ resolvedFile: `${repo}/r.json`, resolvedDir: repo, repoRoot: repo })?.code).toBe("result_path_inside_repo");
  });
  it("refuses result_path_invalid (not .json / relative)", () => {
    expect(checkResultPath({ resolvedFile: "/tmp/r.txt", resolvedDir: "/tmp", repoRoot: repo })?.code).toBe("result_path_invalid");
    expect(checkResultPath({ resolvedFile: "r.json", resolvedDir: "/tmp", repoRoot: repo })?.code).toBe("result_path_invalid");
  });
});

describe("checkTargetRecord", () => {
  it("CONTROL: matching uid and disabled === false passes", () => {
    expect(checkTargetRecord({ uid: UID, disabled: false }, UID)).toBeNull();
  });
  it.each([[true], [undefined], ["false"], [0], [null]])("refuses target_disabled when disabled is %p", (disabled) => {
    expect(checkTargetRecord({ uid: UID, disabled }, UID)?.code).toBe("target_disabled");
  });
  it("refuses target_mismatch when the record has another uid", () => {
    expect(checkTargetRecord({ uid: "other", disabled: false }, UID)?.code).toBe("target_mismatch");
  });
});

describe("planClaimChange — merge order and claim preservation", () => {
  it("grant over existing admin:false yields admin:true and preserves every other claim (merge-order defect)", () => {
    const before = { admin: false, plan: "pro", nested: { a: [1, 2] } };
    const r = planClaimChange(before, "grant");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.after).toEqual({ admin: true, plan: "pro", nested: { a: [1, 2] } });
    expect(r.plan.diff).toEqual([{ kind: "change", key: "admin", before: false, after: true }]);
    expect(r.plan.changed).toBe(true);
    expect(checkPlanInvariants(r.plan)).toBeNull();
    // input not mutated
    expect(before.admin).toBe(false);
  });
  it("grant with no claims adds admin only", () => {
    const r = planClaimChange(undefined, "grant");
    expect(r.ok && r.plan.after).toEqual({ admin: true });
    expect(r.ok && r.plan.diff[0].kind).toBe("add");
  });
  it("grant when already admin is no change", () => {
    const r = planClaimChange({ admin: true, x: 1 }, "grant");
    expect(r.ok && r.plan.changed).toBe(false);
  });
  it("revoke removes ONLY the admin key and preserves others", () => {
    const r = planClaimChange({ admin: true, plan: "pro", team: "t1" }, "revoke");
    expect(r.ok && r.plan.after).toEqual({ plan: "pro", team: "t1" });
    expect(r.ok && Object.prototype.hasOwnProperty.call(r.plan.after, "admin")).toBe(false);
    expect(r.ok && r.plan.diff).toEqual([{ kind: "remove", key: "admin", before: true }]);
    expect(r.ok && r.plan.targetIsAdminBefore).toBe(true);
  });
  it("revoke when no admin key is no change", () => {
    const r = planClaimChange({ plan: "pro" }, "revoke");
    expect(r.ok && r.plan.changed).toBe(false);
  });
  it("revoke over admin:false removes the key (a change, but the target was not an admin)", () => {
    const r = planClaimChange({ admin: false }, "revoke");
    expect(r.ok && r.plan.changed).toBe(true);
    expect(r.ok && r.plan.targetIsAdminBefore).toBe(false);
  });
  it.each([[[1]], ["str"], [new Date()]])("refuses claims_invalid for %p", (claims) => {
    const r = planClaimChange(claims, "grant");
    expect(r.ok ? "ok" : r.code).toBe("claims_invalid");
  });
});

describe("checkPlanInvariants", () => {
  const base = (over: Partial<ClaimPlan>): ClaimPlan => ({
    operation: "grant", before: { x: 1 }, after: { x: 1, admin: true }, diff: [], changed: true, targetIsAdminBefore: false, ...over,
  });
  it("CONTROL: a correct grant plan passes", () => {
    expect(checkPlanInvariants(base({}))).toBeNull();
  });
  it("refuses unrelated_claims_changed when a claim-wiping plan is presented (the old setAdmin.ts shape)", () => {
    expect(checkPlanInvariants(base({ after: { admin: true } }))?.code).toBe("unrelated_claims_changed");
  });
  it("refuses unrelated_claims_changed when a grant plan does not end admin === true (the old spread-order shape)", () => {
    expect(checkPlanInvariants(base({ before: { admin: false }, after: { admin: false } }))?.code).toBe("unrelated_claims_changed");
  });
  it("refuses unrelated_claims_changed when a revoke plan keeps the admin key", () => {
    expect(checkPlanInvariants(base({ operation: "revoke", before: { admin: true }, after: { admin: false } }))?.code).toBe("unrelated_claims_changed");
  });
  it("refuses reserved_claim", () => {
    expect(checkPlanInvariants(base({ before: { sub: "x" }, after: { sub: "x", admin: true } }))?.code).toBe("reserved_claim");
  });
  it("enforces the 1000-byte limit: exactly at the limit passes, one byte over refuses claims_too_large", () => {
    const overhead = JSON.stringify({ pad: "", admin: true }).length;
    const atLimit = { pad: "p".repeat(CLAIMS_MAX_BYTES - overhead) };
    const r1 = planClaimChange(atLimit, "grant");
    expect(r1.ok && JSON.stringify(r1.plan.after).length).toBe(CLAIMS_MAX_BYTES);
    expect(r1.ok && checkPlanInvariants(r1.plan)).toBeNull();
    const r2 = planClaimChange({ pad: "p".repeat(CLAIMS_MAX_BYTES - overhead + 1) }, "grant");
    expect(r2.ok && checkPlanInvariants(r2.plan)?.code).toBe("claims_too_large");
  });
  it("counts bytes, not characters (multi-byte claim values)", () => {
    const overhead = JSON.stringify({ pad: "", admin: true }).length;
    const n = Math.floor((CLAIMS_MAX_BYTES - overhead) / 2) + 1; // 2-byte chars push it over
    const r = planClaimChange({ pad: "é".repeat(n) }, "grant");
    expect(r.ok && checkPlanInvariants(r.plan)?.code).toBe("claims_too_large");
  });
});

describe("confirmation", () => {
  const g = expectedConfirmation({ operation: "grant", projectId: PROJECT, targetUid: UID, revokeSessions: null });
  const rv = expectedConfirmation({ operation: "revoke", projectId: PROJECT, targetUid: UID, revokeSessions: "yes" });
  it("binds operation, project and uid (and the session decision on revoke)", () => {
    expect(g).toBe(`grant:admin:true:${PROJECT}:${UID}`);
    expect(rv).toBe(`revoke:admin:removed:sessions-yes:${PROJECT}:${UID}`);
  });
  it("CONTROL: the exact string passes", () => {
    expect(checkConfirmation(g, g)).toBeNull();
  });
  it.each([
    ["case-folded", g.toUpperCase()],
    ["prefix only", g.slice(0, -1)],
    ["trailing space", `${g} `],
    ["other project", `grant:admin:true:convergepanel:${UID}`],
    ["other uid", `grant:admin:true:${PROJECT}:someoneElse`],
    ["revoke string for a grant", rv],
    ["revoke with the other session decision", expectedConfirmation({ operation: "revoke", projectId: PROJECT, targetUid: UID, revokeSessions: "no" })],
  ])("refuses confirmation_mismatch: %s", (_l, provided) => {
    const expected = _l === "revoke with the other session decision" ? rv : g;
    expect(checkConfirmation(provided, expected)?.code).toBe("confirmation_mismatch");
  });
  it("refuses confirmation_missing", () => {
    expect(checkConfirmation(null, g)?.code).toBe("confirmation_missing");
  });
});

describe("operator authorization", () => {
  const live = { uid: "op1", disabled: false, customClaims: { admin: true } };
  it("CONTROL: token admin + live admin + enabled passes", () => {
    expect(checkOperatorAuthorization({ uid: "op1", admin: true }, live)).toBeNull();
  });
  it.each<[string, { uid: string; admin?: unknown }, Record<string, unknown>]>([
    ["token lacks admin (e.g. an ADMIN_EMAILS member)", { uid: "op1" }, live],
    ["token admin is truthy but not true", { uid: "op1", admin: "true" }, live],
    ["live record lost admin (token is stale)", { uid: "op1", admin: true }, { ...live, customClaims: { admin: false } }],
    ["live record disabled", { uid: "op1", admin: true }, { ...live, disabled: true }],
    ["live disabled unknown", { uid: "op1", admin: true }, { uid: "op1", customClaims: { admin: true } }],
    ["uid disagreement", { uid: "op2", admin: true }, live],
  ])("refuses operator_not_system_admin: %s", (_l, decoded, rec) => {
    expect(checkOperatorAuthorization(decoded, rec as never)?.code).toBe("operator_not_system_admin");
  });
  it("token shape: CONTROL passes; garbage refuses operator_token_invalid", () => {
    expect(checkIdTokenShape("aaa.bbb.ccc")).toBeNull();
    expect(checkIdTokenShape("aaa.bbb")?.code).toBe("operator_token_invalid");
    expect(checkIdTokenShape("aaa.bbb.ccc\nddd.eee.fff")?.code).toBe("operator_token_invalid");
  });
  it("classifies verify errors by code only", () => {
    expect(classifyOperatorTokenError("auth/id-token-revoked").code).toBe("operator_token_revoked");
    expect(classifyOperatorTokenError("auth/user-disabled").code).toBe("operator_not_system_admin");
    expect(classifyOperatorTokenError("auth/id-token-expired").code).toBe("operator_token_invalid");
    expect(classifyOperatorTokenError(undefined).code).toBe("operator_token_invalid");
  });
});

describe("admin holder counting, bootstrap, revoke safety", () => {
  const users = [
    { uid: "a", disabled: false, customClaims: { admin: true } },
    { uid: "b", disabled: true, customClaims: { admin: true } },
    { uid: "c", disabled: false, customClaims: { admin: "true" } },
    { uid: "d", disabled: false },
  ];
  it("counts only admin === true; enabledOnly excludes disabled; excludeUid excludes the target", () => {
    expect(countAdminHolders(users, { enabledOnly: false })).toBe(2);
    expect(countAdminHolders(users, { enabledOnly: true })).toBe(1);
    expect(countAdminHolders(users, { enabledOnly: true, excludeUid: "a" })).toBe(0);
  });
  it("bootstrap: CONTROL 0 holders passes; 1 holder refuses bootstrap_not_first", () => {
    expect(checkBootstrapFirstAdmin(0)).toBeNull();
    expect(checkBootstrapFirstAdmin(1)?.code).toBe("bootstrap_not_first");
  });
  it("revoke safety: CONTROL another enabled admin remains passes", () => {
    expect(checkRevokeSafety({ targetUid: "t", operatorUid: "op", targetIsAdminBefore: true, enabledAdminHoldersExcludingTarget: 1 })).toBeNull();
  });
  it("refuses self_revoke", () => {
    expect(checkRevokeSafety({ targetUid: "op", operatorUid: "op", targetIsAdminBefore: true, enabledAdminHoldersExcludingTarget: 3 })?.code).toBe("self_revoke");
  });
  it("refuses last_admin", () => {
    expect(checkRevokeSafety({ targetUid: "t", operatorUid: "op", targetIsAdminBefore: true, enabledAdminHoldersExcludingTarget: 0 })?.code).toBe("last_admin");
  });
  it("does not apply when the target is not currently an admin", () => {
    expect(checkRevokeSafety({ targetUid: "t", operatorUid: "t", targetIsAdminBefore: false, enabledAdminHoldersExcludingTarget: 0 })).toBeNull();
  });
});

describe("read-back verification", () => {
  const grant = planClaimChange({ admin: false, plan: "pro" }, "grant");
  const revoke = planClaimChange({ admin: true, plan: "pro" }, "revoke");
  if (!grant.ok || !revoke.ok) throw new Error("fixture");
  it("CONTROL: correct grant / revoke read-backs verify", () => {
    expect(verifyReadBack(grant.plan, { plan: "pro", admin: true }).ok).toBe(true);
    expect(verifyReadBack(revoke.plan, { plan: "pro" }).ok).toBe(true);
  });
  it("fails when admin did not land, when admin survived a revoke, or when another claim changed", () => {
    expect(verifyReadBack(grant.plan, { plan: "pro", admin: false }).ok).toBe(false);
    expect(verifyReadBack(revoke.plan, { plan: "pro", admin: false }).ok).toBe(false);
    expect(verifyReadBack(grant.plan, { admin: true }).ok).toBe(false);
    expect(verifyReadBack(grant.plan, { admin: true, plan: "free" }).ok).toBe(false);
  });
  it("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
  });
  it("sessions-revoked: server read-back must be STRICTLY later than the server pre-write value", () => {
    const before = "Thu, 05 Nov 2026 09:00:00 GMT";
    expect(verifySessionsRevoked("Thu, 05 Nov 2026 10:00:00 GMT", before)).toBe(true);
    expect(verifySessionsRevoked(before, before)).toBe(false); // did not advance
    expect(verifySessionsRevoked("Thu, 05 Nov 2026 08:00:00 GMT", before)).toBe(false);
    expect(verifySessionsRevoked(undefined, before)).toBe(false);
    expect(verifySessionsRevoked("garbage", before)).toBe(false);
    expect(verifySessionsRevoked("Thu, 05 Nov 2026 10:00:00 GMT", "garbage")).toBe(false);
    // no pre-write value: a present read-back value is new server state
    expect(verifySessionsRevoked("Thu, 05 Nov 2026 10:00:00 GMT", undefined)).toBe(true);
  });
});

describe("audit record — matches lib/admin/auditLog.ts#AuditLogEntry", () => {
  const TS = { __timestamp: true };
  const rec = buildClaimAuditRecord({
    phase: "attempt",
    requestId: "req_1_abc",
    createdAt: TS,
    projectId: PROJECT,
    operation: "grant",
    authorization: "operator-id-token",
    adminUid: "op1",
    adminEmail: "op@example.com",
    targetUid: UID,
    targetEmail: "t@example.com",
    beforeClaims: { admin: false },
    afterClaims: { admin: true },
    usersDocRoleBefore: null,
    usersDocRoleAfter: "admin",
    revokeSessions: null,
    credentialSource: "explicit-key-file",
    credentialClientEmailMasked: "fire…@…",
    gitSha: "abc123",
    confirmClaim: `grant:admin:true:${PROJECT}:${UID}`,
  });
  it("has exactly the AuditLogEntry key set and no governance fields", () => {
    expect(Object.keys(rec).sort()).toEqual(
      ["actionType", "adminEmail", "adminUid", "after", "before", "createdAt", "metadata", "requestId", "targetEmail", "targetUid"].sort(),
    );
    expect(rec).not.toHaveProperty("action");
    expect(rec).not.toHaveProperty("at");
    expect(rec.createdAt).toBe(TS);
    expect(rec.actionType).toBe("GRANT_SYSTEM_ADMIN_CLAIM");
    expect(rec.metadata).toMatchObject({ source: "operator-script", phase: "attempt", script: "scripts/admin/set-system-admin-claim.ts" });
    expect(rec.metadata).not.toHaveProperty("outcome");
  });
  it("outcome rows carry metadata.outcome; optional emails are omitted, never undefined", () => {
    const out = buildClaimAuditRecord({
      ...{
        requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke" as const, authorization: "first-admin-bootstrap" as const,
        adminUid: "operator-bootstrap", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: null,
        revokeSessions: "yes" as const, credentialSource: "explicit-key-file" as const, credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      },
      phase: "outcome",
      outcome: "applied",
    });
    expect(out.metadata.outcome).toBe("applied");
    expect(out.actionType).toBe("REVOKE_SYSTEM_ADMIN_CLAIM");
    expect("adminEmail" in out).toBe(false);
    expect("targetEmail" in out).toBe(false);
  });
  it("doc ids are deterministic per request and phase", () => {
    expect(auditDocId("req_1_a", "attempt")).toBe("system-admin-claim:req_1_a:attempt");
    expect(auditDocId("req_1_a", "outcome")).toBe("system-admin-claim:req_1_a:outcome");
    expect(generateRequestId(123, "abc")).toBe("req_123_abc");
  });
  it("masks email", () => {
    expect(maskEmail("firebase-adminsdk@x.iam.gserviceaccount.com")).toBe("fire…@…");
  });
});

describe("NIT-1 — own __proto__ claim key", () => {
  it("is refused with claims_prototype_key (it would otherwise be silently dropped on copy)", () => {
    const claims = JSON.parse('{"__proto__":{"x":1},"plan":"pro"}');
    expect(Object.prototype.hasOwnProperty.call(claims, "__proto__")).toBe(true);
    const r = planClaimChange(claims, "grant");
    expect(r.ok ? "ok" : r.code).toBe("claims_prototype_key");
    expect(planClaimChange(claims, "revoke").ok).toBe(false);
  });
  it("CONTROL: an ordinary key named constructor is preserved byte-equal through grant and revoke", () => {
    const g = planClaimChange({ constructor: "c", plan: "pro" }, "grant");
    expect(g.ok && g.plan.after).toEqual({ constructor: "c", plan: "pro", admin: true });
    const v = planClaimChange({ constructor: "c", admin: true }, "revoke");
    expect(v.ok && v.plan.after).toEqual({ constructor: "c" });
  });
  it("the unrelated-claims fingerprint keeps an own __proto__ key (copy is define-based, not assignment)", () => {
    const a = JSON.parse('{"__proto__":{"x":1}}');
    expect(unrelatedClaimsFingerprint(a)).not.toBe(unrelatedClaimsFingerprint({}));
  });
});

describe("MINOR-4 — checkResultDirStat", () => {
  const ok = { isSymlink: false, isDirectory: true, uid: 501, mode: 0o40700 };
  it("CONTROL: own, real directory, mode 0700 passes", () => {
    expect(checkResultDirStat(ok, 501)).toBeNull();
  });
  it.each<[string, Parameters<typeof checkResultDirStat>[0], number | null]>([
    ["symlink", { ...ok, isSymlink: true }, 501],
    ["file", { ...ok, isDirectory: false }, 501],
    ["other owner", { ...ok, uid: 0 }, 501],
    ["group-readable", { ...ok, mode: 0o40750 }, 501],
    ["world-writable", { ...ok, mode: 0o40777 }, 501],
    ["too strict is still not 0700", { ...ok, mode: 0o40500 }, 501],
    ["missing", null, 501],
    ["unknown uid", ok, null],
  ])("refuses result_dir_unsafe: %s", (_l, stat, uid) => {
    expect(checkResultDirStat(stat, uid)?.code).toBe("result_dir_unsafe");
  });
});

describe("NIT-2 — symlinked secret files", () => {
  it("a symlinked credentials file refuses credentials_file_symlink; a symlinked token refuses operator_token_file_unsafe", () => {
    expect(checkSecretFileMode({ isSymlink: true, isFile: false, mode: 0o120777 }, "credentials_file_unsafe", "f")?.code).toBe("credentials_file_symlink");
    expect(checkSecretFileMode({ isSymlink: true, isFile: false, mode: 0o120777 }, "operator_token_file_unsafe", "f")?.code).toBe("operator_token_file_unsafe");
    expect(checkSecretFileMode({ isSymlink: false, isFile: true, mode: 0o100600 }, "credentials_file_unsafe", "f")).toBeNull();
  });
});

describe("refusal code inventory", () => {
  it("every refusal code is unique", () => {
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
  });
});
