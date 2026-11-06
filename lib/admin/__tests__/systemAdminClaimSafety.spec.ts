/**
 * Pure-module tests for the SYSTEM_ADMIN claim operator tool. Every guard has a
 * CONTROL (a valid input that passes, so the refusal assertion is not
 * vacuous) and a NEGATIVE case that must produce the named refusal code.
 */
import * as fs from "node:fs";
import * as path from "node:path";

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
  checkRevocationAnchor,
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
  observeRevocationCutoff,
  validSinceMovedBackward,
  validSinceMovedBackwardDetail,
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  REVOCATION_CLOCK_ASSUMPTION,
  revocationCutoffSeconds,
  REVOCATION_SKEW_MARGIN_SECONDS,
  type SessionRevocationEvidence,
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
      expect(r.args).toMatchObject({ operation: "grant", targetUid: UID, confirmProject: PROJECT, execute: false });
      expect(r.args).not.toHaveProperty("revokeSessions");
    }
  });
  it("CONTROL: a revoke with every required flag parses", () => {
    const r = parseSetSystemAdminClaimArgs(REVOKE);
    expect(r.ok && r.args.operation).toBe("revoke");
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
    // Owner policy: every executed revoke REQUESTS refresh-token revocation; the opt-out flag is gone in every form.
    ["unknown_flag", [...REVOKE, "--revoke-sessions=no"]],
    ["unknown_flag", [...REVOKE, "--revoke-sessions=yes"]],
    ["unknown_flag", [...REVOKE, "--revoke-sessions"]],
    ["unknown_flag", [...GRANT, "--revoke-sessions=yes"]],
    ["reduction_flag_missing", without(REVOKE, "--allow-claim-reduction")],
    ["flag_conflict", [...GRANT, "--allow-claim-reduction"]],
    ["flag_conflict", [...REVOKE, "--bootstrap-first-admin"]],
    ["flag_conflict", [...GRANT, "--bootstrap-first-admin", "--operator-id-token-file=/t"]],
    ["flag_conflict", [...GRANT, "--confirm-claim=x"]],
    ["confirmation_missing", [...GRANT, "--execute"]],
  ])("refuses %s", (code, argv) => {
    expect(parseCode(argv)).toBe(code);
  });
  it("--revoke-sessions is refused with a message that says every revoke REQUESTS revocation (no opt-out) and states its limits", () => {
    const r = parseSetSystemAdminClaimArgs([...REVOKE, "--revoke-sessions=no"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("Refusing --revoke-sessions: the flag was removed. Every executed revoke REQUESTS revocation of the target's refresh tokens (owner policy); there is no opt-out. The request can fail, and even an acknowledged one does not end already-issued ID tokens (runbook, \"Revocation and sessions\").");
    expect(r.message).not.toMatch(/ALWAYS revokes/);
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
  const chk = (resolvedFile: string, protectedRoots: string[] = [repo], caseInsensitive = false) =>
    checkResultPath({ resolvedFile, resolvedDir: path.dirname(resolvedFile), protectedRoots, caseInsensitive });
  it("CONTROL: a tmp path outside the repo passes", () => {
    expect(chk("/tmp/x/r.json")).toBeNull();
  });
  it("CONTROL: a sibling directory with a shared prefix is not 'inside' (no lexical prefix test)", () => {
    expect(chk("/Users/op/Apps/CP-other/r.json")).toBeNull();
    expect(chk("/Users/op/Apps/CPx/r.json", [repo], true)).toBeNull();
  });
  it("CONTROL: a directory literally named '..something' inside a non-protected dir is not confused with '..'", () => {
    expect(chk("/tmp/..cache/r.json", ["/tmp/x"])).toBeNull();
  });
  it("refuses result_path_inside_repo", () => {
    expect(chk(`${repo}/out/r.json`)?.code).toBe("result_path_inside_repo");
    expect(chk(`${repo}/r.json`)?.code).toBe("result_path_inside_repo");
    expect(chk(`${repo}/..cache/r.json`)?.code).toBe("result_path_inside_repo");
  });
  it("refuses a path inside ANY protected root (every git worktree of the repo), not only the first", () => {
    expect(chk("/Users/op/Apps/CP-WT2/sub/r.json", [repo, "/Users/op/Apps/CP-WT2"])?.code).toBe("result_path_inside_repo");
  });
  it("case-insensitive volume: a case variant of the repo path is inside (folded comparison)", () => {
    expect(chk("/users/op/apps/cp/out.json", [repo], true)?.code).toBe("result_path_inside_repo");
    expect(chk("/USERS/OP/APPS/CP/out.json", [repo], true)?.code).toBe("result_path_inside_repo");
    // On a case-SENSITIVE volume a case variant is a different directory.
    expect(chk("/users/op/apps/cp/out.json", [repo], false)).toBeNull();
  });
  it("refuses result_path_invalid (not .json / relative)", () => {
    expect(chk("/tmp/r.txt")?.code).toBe("result_path_invalid");
    expect(checkResultPath({ resolvedFile: "r.json", resolvedDir: "/tmp", protectedRoots: [repo], caseInsensitive: false })?.code).toBe("result_path_invalid");
  });
  it("fails closed: no protected root, a relative root, or a dir that is not the file's parent => result_path_invalid", () => {
    expect(chk("/tmp/x/r.json", [])?.code).toBe("result_path_invalid");
    expect(chk("/tmp/x/r.json", ["rel/root"])?.code).toBe("result_path_invalid");
    expect(checkResultPath({ resolvedFile: "/tmp/x/r.json", resolvedDir: "/tmp/y", protectedRoots: [repo], caseInsensitive: false })?.code).toBe("result_path_invalid");
  });
});

describe("checkTargetRecord", () => {
  it("CONTROL: matching uid and disabled === false passes for grant and revoke", () => {
    expect(checkTargetRecord({ uid: UID, disabled: false }, UID, "grant")).toBeNull();
    expect(checkTargetRecord({ uid: UID, disabled: false }, UID, "revoke")).toBeNull();
  });
  it.each([[true], [undefined], ["false"], [0], [null]])("GRANT refuses target_disabled when disabled is %p", (disabled) => {
    expect(checkTargetRecord({ uid: UID, disabled }, UID, "grant")?.code).toBe("target_disabled");
  });
  it("REVOKE (privilege removal) is allowed on a disabled account", () => {
    expect(checkTargetRecord({ uid: UID, disabled: true }, UID, "revoke")).toBeNull();
  });
  it.each([[undefined], ["false"], [0], [null], ["true"]])("REVOKE still refuses a non-boolean disabled state %p (malformed record)", (disabled) => {
    expect(checkTargetRecord({ uid: UID, disabled }, UID, "revoke")?.code).toBe("target_disabled");
  });
  it("refuses target_mismatch when the record has another uid", () => {
    expect(checkTargetRecord({ uid: "other", disabled: false }, UID, "grant")?.code).toBe("target_mismatch");
    expect(checkTargetRecord({ uid: "other", disabled: true }, UID, "revoke")?.code).toBe("target_mismatch");
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
  const g = expectedConfirmation({ operation: "grant", projectId: PROJECT, targetUid: UID });
  const rv = expectedConfirmation({ operation: "revoke", projectId: PROJECT, targetUid: UID });
  it("binds operation, project and uid (and the mandatory session revocation on revoke)", () => {
    expect(g).toBe(`grant:admin:true:${PROJECT}:${UID}`);
    expect(rv).toBe(`revoke:admin:removed:sessions-revoked:${PROJECT}:${UID}`);
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
    ["revoke: retired sessions-no string", `revoke:admin:removed:sessions-no:${PROJECT}:${UID}`],
    ["revoke: retired sessions-yes string", `revoke:admin:removed:sessions-yes:${PROJECT}:${UID}`],
  ])("refuses confirmation_mismatch: %s", (_l, provided) => {
    const expected = _l.startsWith("revoke:") ? rv : g;
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
});

describe("session revocation evidence — server clock only", () => {
  const T0 = Date.parse("2026-11-05T10:00:00Z") / 1000;
  const utc = (s: number) => new Date(s * 1000).toUTCString();
  it("cutoff = anchor whole seconds + 1 + the 2 s skew margin (nanoseconds never round down below the anchor)", () => {
    expect(REVOCATION_SKEW_MARGIN_SECONDS).toBe(2);
    expect(revocationCutoffSeconds({ seconds: T0, nanoseconds: 0 })).toBe(T0 + 3);
    expect(revocationCutoffSeconds({ seconds: T0, nanoseconds: 999_999_999 })).toBe(T0 + 3);
  });
  it("cutoff observed iff the read-back validSince (whole seconds) is AT or AFTER the cutoff", () => {
    const cutoff = T0 + 3;
    expect(observeRevocationCutoff(utc(cutoff), cutoff)).toEqual({ ok: true, validSinceSeconds: cutoff });
    expect(observeRevocationCutoff(utc(cutoff + 3600), cutoff).ok).toBe(true);
    const below = observeRevocationCutoff(utc(cutoff - 1), cutoff);
    expect(below).toMatchObject({ ok: false, validSinceSeconds: cutoff - 1 });
    expect(!below.ok && below.detail).toMatch(/earlier than the server-anchored cutoff/);
    expect(observeRevocationCutoff(undefined, cutoff)).toMatchObject({ ok: false, validSinceSeconds: null });
    expect(observeRevocationCutoff("garbage", cutoff).ok).toBe(false);
    expect(observeRevocationCutoff(utc(cutoff), Number.NaN).ok).toBe(false);
  });
  it("(f) backward move: strictly earlier whole second is true; equal/later is false; missing or unparseable is UNKNOWN (null), never forward", () => {
    expect(validSinceMovedBackward(utc(T0), utc(T0 - 1))).toBe(true);
    expect(validSinceMovedBackward(utc(T0 + 3600), utc(T0))).toBe(true);
    expect(validSinceMovedBackward(utc(T0), utc(T0))).toBe(false);
    expect(validSinceMovedBackward(utc(T0), utc(T0 + 1))).toBe(false);
    // Sub-second differences inside one whole second are not a move (Auth stores whole seconds).
    expect(validSinceMovedBackward(new Date(T0 * 1000 + 900).toISOString(), new Date(T0 * 1000 + 100).toISOString())).toBe(false);
    expect(validSinceMovedBackward(null, utc(T0))).toBeNull();
    expect(validSinceMovedBackward(utc(T0), null)).toBeNull();
    expect(validSinceMovedBackward(undefined, undefined)).toBeNull();
    expect(validSinceMovedBackward("garbage", utc(T0))).toBeNull();
    expect(validSinceMovedBackward(utc(T0), "garbage")).toBeNull();
    const d = validSinceMovedBackwardDetail(utc(T0), utc(T0 - 60));
    expect(d).toContain(`from ${utc(T0)} to ${utc(T0 - 60)}`);
    expect(d).toMatch(/overwrites validSince/);
    expect(d).toMatch(/does not keep the later value/);
    expect(d).toMatch(/This tool does not prevent that \(unresolved risk/);
  });
  it("the anchor must be a well-formed server time STRICTLY later than the attempt row's commit time", () => {
    const attempt = { seconds: T0, nanoseconds: 500 };
    expect(checkRevocationAnchor({ seconds: T0, nanoseconds: 501 }, attempt)).toEqual({ ok: true, anchor: { seconds: T0, nanoseconds: 501 } });
    expect(checkRevocationAnchor({ seconds: T0 + 1, nanoseconds: 0 }, attempt).ok).toBe(true);
    expect(checkRevocationAnchor({ seconds: T0, nanoseconds: 500 }, attempt).ok).toBe(false); // equal: stale/no-op
    expect(checkRevocationAnchor({ seconds: T0 - 1, nanoseconds: 999 }, attempt).ok).toBe(false);
    expect(checkRevocationAnchor(undefined, attempt).ok).toBe(false);
    expect(checkRevocationAnchor({ seconds: T0 + 1, nanoseconds: 0 }, null).ok).toBe(false);
    for (const bad of [{ seconds: "1", nanoseconds: 0 }, { seconds: 1.5, nanoseconds: 0 }, { seconds: T0 + 1, nanoseconds: 1e9 }, { seconds: T0 + 1, nanoseconds: -1 }, { seconds: 0, nanoseconds: 0 }]) {
      expect(checkRevocationAnchor(bad, attempt).ok).toBe(false);
    }
  });
});

const VERIFIED_EVIDENCE: SessionRevocationEvidence = {
  claimWrite: "confirmed",
  revocationApiAcknowledged: true,
  anchorSource: "firestore-commit-time:users/{uid}.role",
  anchorServerTime: "2026-11-05T10:00:00.000Z",
  marginSeconds: 2,
  cutoff: "2026-11-05T10:00:03.000Z",
  tokensValidAfterTimeBefore: null,
  tokensValidAfterTimeAfter: "Thu, 05 Nov 2026 10:00:03 GMT",
  tokensValidAfterTimeMovedBackward: null,
  validSinceMinusAnchorSeconds: 3,
  cutoffObserved: true,
  clockAlignmentAssumption: REVOCATION_CLOCK_ASSUMPTION,
  currentPrivilegeEnforcement: CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  detail: null,
};

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
    claimWrite: "write",
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
    // An attempt row is NEVER labelled as a grant/revoke: it is not a completed change.
    expect(rec.actionType).toBe("SYSTEM_ADMIN_CLAIM_ATTEMPT");
    expect(rec.metadata).toMatchObject({
      source: "operator-script",
      phase: "attempt",
      script: "scripts/admin/set-system-admin-claim.ts",
      requestedOperation: "grant",
      completed: false,
      afterSemantics: "intended-not-applied",
      claimWrite: "write",
      sessionRevocation: "not_applicable",
    });
    expect(rec.metadata).not.toHaveProperty("outcome");
    expect(rec.metadata).not.toHaveProperty("revokeSessions");
  });
  it("outcome rows carry metadata.outcome; optional emails are omitted, never undefined", () => {
    const out = buildClaimAuditRecord({
      ...{
        requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke" as const, authorization: "first-admin-bootstrap" as const,
        adminUid: "operator-bootstrap", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: null,
        claimWrite: "write" as const, credentialSource: "explicit-key-file" as const, credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      },
      phase: "outcome",
      outcome: "applied",
      readBack: { customClaims: "read", usersDocRole: "read" },
      sessionRevocationEvidence: VERIFIED_EVIDENCE,
    });
    expect(out.metadata.outcome).toBe("applied");
    expect(out.metadata.sessionRevocationEvidence).toEqual(VERIFIED_EVIDENCE);
    expect(out.metadata).toMatchObject({ completed: true, afterSemantics: "read-back", sessionRevocation: "required" });
    expect(out.actionType).toBe("REVOKE_SYSTEM_ADMIN_CLAIM");
    expect("adminEmail" in out).toBe(false);
    expect("targetEmail" in out).toBe(false);
  });
  it.each<[string, "grant" | "revoke", "attempt" | "outcome", string | undefined, string, boolean]>([
    ["attempt grant", "grant", "attempt", undefined, "SYSTEM_ADMIN_CLAIM_ATTEMPT", false],
    ["attempt revoke", "revoke", "attempt", undefined, "SYSTEM_ADMIN_CLAIM_ATTEMPT", false],
    ["grant applied", "grant", "outcome", "applied", "GRANT_SYSTEM_ADMIN_CLAIM", true],
    ["revoke applied", "revoke", "outcome", "applied", "REVOKE_SYSTEM_ADMIN_CLAIM", true],
    ["revoke sessions-only", "revoke", "outcome", "claim_already_absent_sessions_revoked", "REVOKE_SYSTEM_ADMIN_SESSIONS", true],
    ["revoke sessions failed", "revoke", "outcome", "sessions_revoke_failed", "SYSTEM_ADMIN_CLAIM_INCOMPLETE", false],
    ["grant mint failed", "grant", "outcome", "mint_failed", "SYSTEM_ADMIN_CLAIM_INCOMPLETE", false],
    ["outcome row missing", "grant", "outcome", "audit_outcome_missing", "SYSTEM_ADMIN_CLAIM_INCOMPLETE", false],
    ["verification failed", "revoke", "outcome", "verification_failed", "SYSTEM_ADMIN_CLAIM_INCOMPLETE", false],
  ])("actionType/completed: %s", (_l, operation, phase, outcome, actionType, completed) => {
    const r = buildClaimAuditRecord({
      requestId: "r", createdAt: TS, projectId: PROJECT, operation, authorization: "operator-id-token",
      adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: null,
      claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      phase,
      outcome: outcome as never,
      readBack: { customClaims: "read", usersDocRole: "read" },
      sessionRevocationEvidence: VERIFIED_EVIDENCE,
    });
    expect([r.actionType, r.metadata.completed]).toEqual([actionType, completed]);
  });

  it("fail closed: a COMPLETED revoke outcome without an acknowledged revocation AND an observed cutoff is downgraded to sessions_revoke_unverified", () => {
    // Stricter than a1c2159: an observed cutoff WITHOUT an acknowledged revocation call is not completed either.
    for (const ev of [undefined, null, { ...VERIFIED_EVIDENCE, cutoffObserved: false }, { ...VERIFIED_EVIDENCE, revocationApiAcknowledged: false }]) {
      for (const outcome of ["applied", "claim_already_absent_sessions_revoked"] as const) {
        const r = buildClaimAuditRecord({
          requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke", authorization: "operator-id-token",
          adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: "user",
          claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
          phase: "outcome", outcome, readBack: { customClaims: "read", usersDocRole: "read" }, sessionRevocationEvidence: ev,
        });
        expect([r.actionType, r.metadata.completed, r.metadata.outcome]).toEqual(["SYSTEM_ADMIN_CLAIM_INCOMPLETE", false, "sessions_revoke_unverified"]);
      }
    }
  });
  it("grant outcome rows carry no session evidence field", () => {
    const r = buildClaimAuditRecord({
      requestId: "r", createdAt: TS, projectId: PROJECT, operation: "grant", authorization: "operator-id-token",
      adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: { admin: true }, usersDocRoleBefore: null, usersDocRoleAfter: "admin",
      claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      phase: "outcome", outcome: "applied", readBack: { customClaims: "read", usersDocRole: "read" },
    });
    expect([r.metadata.completed, "sessionRevocationEvidence" in r.metadata]).toEqual([true, false]);
  });

  describe("M-1: an outcome row never presents unread state as read", () => {
    const base = {
      requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke" as const, authorization: "operator-id-token" as const,
      adminUid: "op", targetUid: UID, beforeClaims: { admin: true, plan: "pro" }, usersDocRoleBefore: "admin",
      claimWrite: "write" as const, credentialSource: "explicit-key-file" as const, credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      phase: "outcome" as const,
    };
    it("claims read-back failed: after.customClaims is null (never {}), afterSemantics unknown, marker recorded", () => {
      const r = buildClaimAuditRecord({
        ...base, outcome: "sessions_revoke_failed", afterClaims: null, usersDocRoleAfter: "user",
        readBack: { customClaims: "failed", usersDocRole: "read" },
        outcomeDetails: ["sessions_revoke_failed: x", "verification_failed: read-back failed"],
      });
      expect(r.after).toEqual({ customClaims: null, usersDocRole: "user" });
      expect(r.metadata).toMatchObject({
        completed: false,
        afterSemantics: "unknown",
        readBack: { customClaims: "failed", usersDocRole: "read" },
        outcome: "sessions_revoke_failed",
        outcomeDetail: "sessions_revoke_failed: x; verification_failed: read-back failed",
        outcomeDetails: ["sessions_revoke_failed: x", "verification_failed: read-back failed"],
      });
      expect(r.actionType).toBe("SYSTEM_ADMIN_CLAIM_INCOMPLETE");
    });
    it("a stale/fabricated afterClaims passed with a failed read is DROPPED to null", () => {
      const r = buildClaimAuditRecord({
        ...base, outcome: "verification_failed", afterClaims: {}, usersDocRoleAfter: null,
        readBack: { customClaims: "failed", usersDocRole: "read" },
      });
      expect(r.after.customClaims).toBeNull();
      expect(r.metadata.afterSemantics).toBe("unknown");
    });
    it("role read-back failed: after.usersDocRole null and afterSemantics unknown", () => {
      const r = buildClaimAuditRecord({
        ...base, outcome: "verification_failed", afterClaims: { plan: "pro" }, usersDocRoleAfter: "user",
        readBack: { customClaims: "read", usersDocRole: "failed" },
      });
      expect(r.after).toEqual({ customClaims: { plan: "pro" }, usersDocRole: null });
      expect(r.metadata).toMatchObject({ afterSemantics: "unknown", readBack: { customClaims: "read", usersDocRole: "failed" } });
    });
    it("fail closed: a COMPLETED outcome with a failed or missing read-back is downgraded to verification_failed (never completed)", () => {
      for (const readBack of [undefined, { customClaims: "failed" as const, usersDocRole: "read" as const }, { customClaims: "read" as const, usersDocRole: "failed" as const }]) {
        const r = buildClaimAuditRecord({ ...base, outcome: "applied", afterClaims: { plan: "pro" }, usersDocRoleAfter: "user", readBack });
        expect([r.actionType, r.metadata.completed, r.metadata.outcome, r.metadata.afterSemantics]).toEqual([
          "SYSTEM_ADMIN_CLAIM_INCOMPLETE", false, "verification_failed", "unknown",
        ]);
      }
    });
    it("CONTROL: full read-back => read-back semantics and the read snapshot", () => {
      const r = buildClaimAuditRecord({
        ...base, outcome: "applied", afterClaims: { plan: "pro" }, usersDocRoleAfter: "user",
        readBack: { customClaims: "read", usersDocRole: "read" },
        sessionRevocationEvidence: VERIFIED_EVIDENCE,
      });
      expect(r.after).toEqual({ customClaims: { plan: "pro" }, usersDocRole: "user" });
      expect(r.metadata).toMatchObject({ afterSemantics: "read-back", completed: true });
      expect(r.metadata).not.toHaveProperty("outcomeDetail");
    });
  });
  it("every claim action type is declared in lib/admin/auditLog.ts#AdminActionType", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "auditLog.ts"), "utf8");
    for (const t of ["SYSTEM_ADMIN_CLAIM_ATTEMPT", "GRANT_SYSTEM_ADMIN_CLAIM", "REVOKE_SYSTEM_ADMIN_CLAIM", "REVOKE_SYSTEM_ADMIN_SESSIONS", "SYSTEM_ADMIN_CLAIM_INCOMPLETE"]) {
      expect({ t, declared: src.includes(`"${t}"`) }).toEqual({ t, declared: true });
    }
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
