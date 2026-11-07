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
  validSinceLowerThanBefore,
  validSinceLowerThanBeforeDetail,
  highestEarlierValue,
  checkOperatorClock,
  checkPreCallCutoff,
  isReviewRequiredOutcome,
  COMPLETED_OUTCOMES,
  POST_WRITE_FAILURES,
  REVIEW_REQUIRED_OUTCOMES,
  RETIRED_REVOKE_CONFIRMATION_PREFIXES,
  CURRENT_PRIVILEGE_ENFORCEMENT_NOTE,
  REVOCATION_CLOCK_ASSUMPTION,
  revocationCutoffSeconds,
  REVOCATION_SKEW_MARGIN_SECONDS,
  type SessionRevocationObservations,
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
  it("binds operation, project and uid (and the mandatory revocation REQUEST on revoke; no effect is named)", () => {
    expect(g).toBe(`grant:admin:true:${PROJECT}:${UID}`);
    expect(rv).toBe(`revoke:admin:removed:revocation-requested:${PROJECT}:${UID}`);
  });
  it.each(RETIRED_REVOKE_CONFIRMATION_PREFIXES.map((p) => [p]))("the retired form %s is refused (confirmation_mismatch) and named as retired", (prefix) => {
    const r = checkConfirmation(`${prefix}${PROJECT}:${UID}`, rv);
    expect(r?.code).toBe("confirmation_mismatch");
    expect(r?.message).toContain("That confirmation form is retired.");
    // CONTROL: an ordinary wrong string is refused without the retirement note.
    expect(checkConfirmation(`${rv}x`, rv)?.message).not.toContain("retired");
  });
  it("the retired list covers sessions-revoked, sessions-yes and sessions-no", () => {
    expect([...RETIRED_REVOKE_CONFIRMATION_PREFIXES].sort()).toEqual([
      "revoke:admin:removed:sessions-no:", "revoke:admin:removed:sessions-revoked:", "revoke:admin:removed:sessions-yes:",
    ]);
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
    ["revoke: retired sessions-revoked string", `revoke:admin:removed:sessions-revoked:${PROJECT}:${UID}`],
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
  it("(f) lowered: strictly earlier whole second than ANY earlier value is true; equal/later is false; missing or unparseable is UNKNOWN (null), never forward", () => {
    expect(validSinceLowerThanBefore([utc(T0)], utc(T0 - 1))).toBe(true);
    expect(validSinceLowerThanBefore([utc(T0 + 3600)], utc(T0))).toBe(true);
    expect(validSinceLowerThanBefore([utc(T0)], utc(T0))).toBe(false);
    expect(validSinceLowerThanBefore([utc(T0)], utc(T0 + 1))).toBe(false);
    // Against the HIGHEST earlier value: pre-run behind, fresh pre-call ahead.
    expect(validSinceLowerThanBefore([utc(T0 - 60), utc(T0 + 5)], utc(T0))).toBe(true);
    expect(validSinceLowerThanBefore([utc(T0 + 5), utc(T0 - 60)], utc(T0))).toBe(true);
    // Numbers are whole seconds (the V an acknowledged call was cleared to write).
    expect(validSinceLowerThanBefore([utc(T0 - 60), T0], utc(T0 - 1))).toBe(true);
    expect(validSinceLowerThanBefore([utc(T0 - 60), T0], utc(T0))).toBe(false);
    expect(validSinceLowerThanBefore([1.5], utc(T0))).toBeNull();
    // Sub-second differences inside one whole second are not a lowering (Auth stores whole seconds).
    expect(validSinceLowerThanBefore([new Date(T0 * 1000 + 900).toISOString()], new Date(T0 * 1000 + 100).toISOString())).toBe(false);
    expect(validSinceLowerThanBefore([null], utc(T0))).toBeNull();
    expect(validSinceLowerThanBefore([], utc(T0))).toBeNull();
    expect(validSinceLowerThanBefore([utc(T0)], null)).toBeNull();
    expect(validSinceLowerThanBefore([undefined], undefined)).toBeNull();
    expect(validSinceLowerThanBefore(["garbage"], utc(T0))).toBeNull();
    expect(validSinceLowerThanBefore([utc(T0)], "garbage")).toBeNull();
    // An unusable earlier value is ignored, not treated as zero.
    expect(validSinceLowerThanBefore(["garbage", utc(T0)], utc(T0 - 1))).toBe(true);
    expect(highestEarlierValue([utc(T0 - 60), utc(T0 + 5), null])).toBe(utc(T0 + 5));
    expect(highestEarlierValue([utc(T0 - 60), T0 + 9])).toMatch(/the value this run's call was cleared to write/);
    expect(highestEarlierValue([null, "garbage"])).toBeNull();
    const d = validSinceLowerThanBeforeDetail(utc(T0), utc(T0 - 60));
    expect(d).toContain(`the read-back tokensValidAfterTime ${utc(T0 - 60)} is earlier than ${utc(T0)}, a value read earlier in this run`);
    expect(d).toMatch(/cause not attributable: this run's revokeRefreshTokens call, which overwrites validSince with the caller's clock, or another writer inside the run window/);
    expect(d).toMatch(/Review before doing anything else/);
    // Causation-neutral: never "this run's call lowered" / "moved BACKWARD during this run".
    expect(d).not.toMatch(/moved BACKWARD|call lowered|LOWERED the stored/);
  });
  describe("G3 checkOperatorClock: commit within [before - m, after + m] (ms), fail closed", () => {
    const st = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
    const B = T0 * 1000 + 250;
    it.each([
      ["commit exactly before - m", B, B + 100, B - 2000, true],
      ["commit 1 ms earlier than before - m", B, B + 100, B - 2001, false],
      ["commit exactly after + m", B, B + 100, B + 2100, true],
      ["commit 1 ms later than after + m", B, B + 100, B + 2101, false],
      ["commit inside the call", B, B + 100, B + 50, true],
      ["latency widens: a 3 s call admits commit at after + m", B, B + 3000, B + 5000, true],
      ["clock far ahead (commit 1 h before)", B, B + 100, B - 3_600_000, false],
      ["clock far behind (commit 1 h after)", B, B + 100, B + 3_600_000, false],
    ] as const)("%s => ok %s", (_l, before, after, commitMs, ok) => {
      const r = checkOperatorClock({ localBeforeMs: before, localAfterMs: after, commit: st(commitMs), marginSeconds: 2 });
      expect(r.ok).toBe(ok);
      if (!r.ok) expect(r.detail).toMatch(/No claim, role or revocation call was made/);
    });
    it("names the direction: local ahead of the commit is 'ahead', behind is 'behind'", () => {
      const ahead = checkOperatorClock({ localBeforeMs: B + 10_000, localAfterMs: B + 10_100, commit: st(B), marginSeconds: 2 });
      const behind = checkOperatorClock({ localBeforeMs: B - 10_000, localAfterMs: B - 9_900, commit: st(B), marginSeconds: 2 });
      expect(!ahead.ok && ahead.detail).toMatch(/operator clock ahead by about 10 s/);
      expect(!behind.ok && behind.detail).toMatch(/operator clock behind by about 10 s/);
    });
    it.each([
      ["no commit time", B, B + 100, undefined],
      ["malformed commit time", B, B + 100, { seconds: "1", nanoseconds: 0 }],
      ["NaN clock", Number.NaN, B, st(B)],
      ["clock stepped backward across the call", B + 100, B, st(B + 50)],
    ] as const)("fails closed: %s", (_l, before, after, commit) => {
      expect(checkOperatorClock({ localBeforeMs: before, localAfterMs: after, commit, marginSeconds: 2 }).ok).toBe(false);
    });
  });
  describe("G2 checkPreCallCutoff: V = floor(now/1000), S = stored whole seconds; V < S skips", () => {
    const rec = (tva?: unknown) => ({ uid: UID, disabled: false, ...(tva === undefined ? {} : { tokensValidAfterTime: tva as string }) });
    const at = (sec: number, ms = 0) => sec * 1000 + ms;
    it.each([
      ["V = S - 1 (999 ms into the second still floors to V)", T0 + 10, at(T0 + 9, 999), "skip_stored_ahead"],
      ["V = S", T0 + 10, at(T0 + 10), "call"],
      ["V = S (late in the second)", T0 + 10, at(T0 + 10, 999), "call"],
      ["V = S + 1", T0 + 10, at(T0 + 11), "call"],
      ["V far below S", T0 + 7200, at(T0), "skip_stored_ahead"],
    ] as const)("%s => %s", (_l, sSec, nowMs, decision) => {
      const r = checkPreCallCutoff(rec(utc(sSec)), UID, nowMs);
      expect(r.decision).toBe(decision);
      expect([r.storedSeconds, r.localSeconds]).toEqual([sSec, Math.floor(nowMs / 1000)]);
      if (r.decision === "skip_stored_ahead") expect(r.detail).toMatch(/revokeRefreshTokens was NOT called: it overwrites and would have lowered the stored value/);
    });
    it("absent stored value (never set) => call", () => {
      expect(checkPreCallCutoff(rec(undefined), UID, at(T0))).toEqual({ decision: "call", storedSeconds: null, localSeconds: T0 });
    });
    it.each([
      ["unparseable stored value", rec("garbage"), UID, at(T0)],
      ["non-string stored value", rec(12345), UID, at(T0)],
      ["record for another uid", { ...rec(utc(T0)), uid: "other" }, UID, at(T0)],
      ["NaN local clock", rec(utc(T0)), UID, Number.NaN],
    ] as const)("fails closed (no call): %s", (_l, r0, uid, now) => {
      expect(checkPreCallCutoff(r0 as never, uid, now).decision).toBe("refuse_unusable");
    });
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

const VERIFIED_EVIDENCE: SessionRevocationObservations = {
  sessionRevocationState: "CUTOFF_OBSERVED",
  effectiveRevocation: "not_observable",
  claimWrite: "confirmed",
  revocationRequested: true,
  revocationApiAcknowledged: true,
  anchorSource: "firestore-commit-time:users/{uid}.role",
  anchorServerTime: "2026-11-05T10:00:00.000Z",
  marginSeconds: 2,
  cutoff: "2026-11-05T10:00:03.000Z",
  tokensValidAfterTimeBefore: null,
  preCallCheck: { read: "read", tokensValidAfterTime: null, storedSeconds: null, localSeconds: 1793872803, decision: "call" },
  tokensValidAfterTimeAfter: "Thu, 05 Nov 2026 10:00:03 GMT",
  tokensValidAfterTimeLowerThanBefore: false,
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
      sessionRevocationObservations: VERIFIED_EVIDENCE,
    });
    expect(out.metadata.outcome).toBe("applied");
    expect(out.metadata.sessionRevocationObservations).toEqual(VERIFIED_EVIDENCE);
    expect(out.metadata).toMatchObject({
      completed: true, afterSemantics: "read-back", sessionRevocation: "required",
      sessionRevocationState: "CUTOFF_OBSERVED", effectiveRevocation: "not_observable",
    });
    expect(out.actionType).toBe("REVOKE_SYSTEM_ADMIN_CLAIM");
    expect("adminEmail" in out).toBe(false);
    expect("targetEmail" in out).toBe(false);
  });
  it.each<[string, "grant" | "revoke", "attempt" | "outcome", string | undefined, string, boolean]>([
    ["attempt grant", "grant", "attempt", undefined, "SYSTEM_ADMIN_CLAIM_ATTEMPT", false],
    ["attempt revoke", "revoke", "attempt", undefined, "SYSTEM_ADMIN_CLAIM_ATTEMPT", false],
    ["grant applied", "grant", "outcome", "applied", "GRANT_SYSTEM_ADMIN_CLAIM", true],
    ["revoke applied", "revoke", "outcome", "applied", "REVOKE_SYSTEM_ADMIN_CLAIM", true],
    ["revoke sessions-only", "revoke", "outcome", "claim_already_absent_revocation_cutoff_observed", "SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED", true],
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
      sessionRevocationObservations: VERIFIED_EVIDENCE,
    });
    expect([r.actionType, r.metadata.completed]).toEqual([actionType, completed]);
  });

  it("fail closed: a COMPLETED revoke outcome without an acknowledged revocation AND an observed cutoff is downgraded to sessions_revoke_unverified", () => {
    // Stricter than a1c2159: an observed cutoff WITHOUT an acknowledged revocation call is not completed either.
    for (const ev of [undefined, null, { ...VERIFIED_EVIDENCE, cutoffObserved: false }, { ...VERIFIED_EVIDENCE, revocationApiAcknowledged: false }]) {
      for (const outcome of ["applied", "claim_already_absent_revocation_cutoff_observed"] as const) {
        const r = buildClaimAuditRecord({
          requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke", authorization: "operator-id-token",
          adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: "user",
          claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
          phase: "outcome", outcome, readBack: { customClaims: "read", usersDocRole: "read" }, sessionRevocationObservations: ev,
        });
        expect([r.actionType, r.metadata.completed, r.metadata.outcome]).toEqual(["SYSTEM_ADMIN_CLAIM_INCOMPLETE", false, "sessions_revoke_unverified"]);
      }
    }
  });
  const revokeOutcome = (outcome: string, ev: SessionRevocationObservations | null | undefined, readBack: { customClaims: "read" | "failed"; usersDocRole: "read" | "failed" } = { customClaims: "read", usersDocRole: "read" }) =>
    buildClaimAuditRecord({
      requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke", authorization: "operator-id-token",
      adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: {}, usersDocRoleBefore: null, usersDocRoleAfter: "user",
      claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      phase: "outcome", outcome: outcome as never, readBack, sessionRevocationObservations: ev,
    });

  it("G1: a COMPLETED revoke whose read-back is lower than an earlier value is downgraded to revocation_cutoff_lowered (never completed)", () => {
    for (const ev of [
      { ...VERIFIED_EVIDENCE, tokensValidAfterTimeLowerThanBefore: true },
      { ...VERIFIED_EVIDENCE, sessionRevocationState: "CUTOFF_LOWERED" as const },
    ]) {
      for (const outcome of ["applied", "claim_already_absent_revocation_cutoff_observed"]) {
        const r = revokeOutcome(outcome, ev);
        expect([r.actionType, r.metadata.completed, r.metadata.outcome]).toEqual(["SYSTEM_ADMIN_CLAIM_INCOMPLETE", false, "revocation_cutoff_lowered"]);
      }
    }
  });

  it("G1 precedence 3 > 4: lowered AND not acknowledged/observed => sessions_revoke_unverified (exit-3 class), not revocation_cutoff_lowered", () => {
    for (const ev of [
      { ...VERIFIED_EVIDENCE, tokensValidAfterTimeLowerThanBefore: true, cutoffObserved: false },
      { ...VERIFIED_EVIDENCE, tokensValidAfterTimeLowerThanBefore: true, revocationApiAcknowledged: false },
    ]) {
      expect(revokeOutcome("applied", ev).metadata.outcome).toBe("sessions_revoke_unverified");
    }
  });

  it("backstop: a COMPLETED revoke row must carry CUTOFF_OBSERVED", () => {
    for (const state of ["NOT_REQUESTED", "REQUESTED_UNACKNOWLEDGED", "ACKNOWLEDGED_UNOBSERVED", "CUTOFF_NOT_REACHED", "CUTOFF_ANOMALY"] as const) {
      const r = revokeOutcome("applied", { ...VERIFIED_EVIDENCE, sessionRevocationState: state });
      expect({ state, outcome: r.metadata.outcome, completed: r.metadata.completed }).toEqual({ state, outcome: "sessions_revoke_unverified", completed: false });
    }
    expect(revokeOutcome("applied", VERIFIED_EVIDENCE).metadata.completed).toBe(true); // CONTROL
  });

  it("exit-4 outcomes are recorded as given, never completed; with a failed read-back they become verification_failed (3 > 4)", () => {
    for (const o of REVIEW_REQUIRED_OUTCOMES) {
      const r = revokeOutcome(o, VERIFIED_EVIDENCE);
      expect([r.actionType, r.metadata.completed, r.metadata.outcome]).toEqual(["SYSTEM_ADMIN_CLAIM_INCOMPLETE", false, o]);
      expect(revokeOutcome(o, VERIFIED_EVIDENCE, { customClaims: "failed", usersDocRole: "read" }).metadata.outcome).toBe("verification_failed");
    }
  });

  it("every revoke row (attempt and outcome) carries effectiveRevocation: not_observable; a missing observation records NOT_REQUESTED", () => {
    const attempt = buildClaimAuditRecord({
      requestId: "r", createdAt: TS, projectId: PROJECT, operation: "revoke", authorization: "operator-id-token",
      adminUid: "op", targetUid: UID, beforeClaims: { admin: true }, afterClaims: {}, usersDocRoleBefore: "admin", usersDocRoleAfter: "user",
      claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c", phase: "attempt",
    });
    expect(attempt.metadata).toMatchObject({ effectiveRevocation: "not_observable" });
    expect(attempt.metadata).not.toHaveProperty("sessionRevocationState");
    const none = revokeOutcome("audit_attempt_failed", null);
    expect(none.metadata).toMatchObject({ effectiveRevocation: "not_observable", sessionRevocationState: "NOT_REQUESTED", sessionRevocationObservations: null });
  });

  it("row shape (revoke outcome): the metadata key set and the observation key set are pinned", () => {
    const r = revokeOutcome("applied", VERIFIED_EVIDENCE);
    expect(Object.keys(r.metadata).sort()).toEqual([
      "afterSemantics", "authorization", "claimWrite", "completed", "confirmClaim", "credentialClientEmailMasked", "credentialSource",
      "effectiveRevocation", "gitSha", "outcome", "phase", "projectId", "readBack", "requestedOperation", "script",
      "sessionRevocation", "sessionRevocationObservations", "sessionRevocationState", "source",
    ]);
    expect(Object.keys(r.metadata.sessionRevocationObservations as object).sort()).toEqual([
      "anchorServerTime", "anchorSource", "claimWrite", "clockAlignmentAssumption", "currentPrivilegeEnforcement", "cutoff", "cutoffObserved",
      "detail", "effectiveRevocation", "marginSeconds", "preCallCheck", "revocationApiAcknowledged", "revocationRequested",
      "sessionRevocationState", "tokensValidAfterTimeAfter", "tokensValidAfterTimeBefore", "tokensValidAfterTimeLowerThanBefore",
      "validSinceMinusAnchorSeconds",
    ]);
    expect(Object.keys(r.metadata.sessionRevocationObservations as object)).not.toContain("tokensValidAfterTimeMovedBackward");
    expect(Object.keys(r.metadata)).not.toContain("sessionRevocationEvidence");
  });

  it("outcome inventories are disjoint and classify correctly", () => {
    const all = [...COMPLETED_OUTCOMES, ...REVIEW_REQUIRED_OUTCOMES, ...POST_WRITE_FAILURES];
    expect(new Set(all).size).toBe(all.length);
    for (const o of REVIEW_REQUIRED_OUTCOMES) expect(isReviewRequiredOutcome(o)).toBe(true);
    for (const o of [...COMPLETED_OUTCOMES, ...POST_WRITE_FAILURES]) expect(isReviewRequiredOutcome(o)).toBe(false);
  });

  it("grant outcome rows carry no session evidence field", () => {
    const r = buildClaimAuditRecord({
      requestId: "r", createdAt: TS, projectId: PROJECT, operation: "grant", authorization: "operator-id-token",
      adminUid: "op", targetUid: UID, beforeClaims: {}, afterClaims: { admin: true }, usersDocRoleBefore: null, usersDocRoleAfter: "admin",
      claimWrite: "write", credentialSource: "explicit-key-file", credentialClientEmailMasked: "x…@…", gitSha: "s", confirmClaim: "c",
      phase: "outcome", outcome: "applied", readBack: { customClaims: "read", usersDocRole: "read" },
    });
    expect([r.metadata.completed, "sessionRevocationObservations" in r.metadata]).toEqual([true, false]);
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
        sessionRevocationObservations: VERIFIED_EVIDENCE,
      });
      expect(r.after).toEqual({ customClaims: { plan: "pro" }, usersDocRole: "user" });
      expect(r.metadata).toMatchObject({ afterSemantics: "read-back", completed: true });
      expect(r.metadata).not.toHaveProperty("outcomeDetail");
    });
  });
  it("every claim action type is declared in lib/admin/auditLog.ts#AdminActionType", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "auditLog.ts"), "utf8");
    for (const t of ["SYSTEM_ADMIN_CLAIM_ATTEMPT", "GRANT_SYSTEM_ADMIN_CLAIM", "REVOKE_SYSTEM_ADMIN_CLAIM", "SYSTEM_ADMIN_REVOCATION_CUTOFF_OBSERVED", "SYSTEM_ADMIN_CLAIM_INCOMPLETE"]) {
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
