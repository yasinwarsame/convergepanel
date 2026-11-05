/**
 * SYSTEM_ADMIN claim operator tool: pure safety logic.
 *
 * Used by `scripts/admin/set-system-admin-claim.ts` (the only supported way to
 * grant or revoke the Firebase `admin` custom claim from an operator shell) and
 * by `lib/admin/systemAdminClaimExecution.ts` (the orchestrator).
 *
 * This module does no I/O. It never reads `process.env`, the filesystem, the
 * network or the clock. Every function takes already-resolved values and
 * returns either `{ ok: true, ... }` or a typed refusal, so every guard is
 * unit-testable without mocking anything. (Pattern:
 * `lib/governance/adaptiveGovernanceSeedSafety.ts`.)
 *
 * WHAT THESE GUARDS ARE, HONESTLY.
 *
 * A process that holds the project's service-account private key already has
 * more power than SYSTEM_ADMIN: it can call the Admin SDK directly from a
 * five-line script of its own. Nothing in this module or the script is a
 * security boundary against the key-holder. The real boundary is CUSTODY OF
 * THE SERVICE-ACCOUNT KEY (IAM: who can create or download keys, and where the
 * key file lives). These guards are procedural and attribution controls: they
 * make the honest path refuse mistakes (wrong project, wrong user, disabled
 * user, claim wipe, accidental write) and make every honest write attributable
 * in `admin_audit_logs` and in a local result file.
 *
 * SEAM FOR PR #294 (operator production grant). Credential evidence carries a
 * `source` discriminant. Today the only source is `"explicit-key-file"`
 * (validated here by `validateServiceAccountKey`). When the operator grant
 * from PR #294 lands, the script adds a second source (`"operator-grant"`) and
 * replaces its credential loader; nothing in this module's planning, argv,
 * confirmation or audit logic depends on how the credential was obtained.
 */

import * as nodePath from "node:path";

// ---------------------------------------------------------------------------
// Constants

export const SCRIPT_PATH = "scripts/admin/set-system-admin-claim.ts";
export const AUDIT_COLLECTION = "admin_audit_logs";
/** Firebase rejects a custom-claims payload whose JSON serialization exceeds 1000 bytes. */
export const CLAIMS_MAX_BYTES = 1000;
/** Claim names Firebase reserves (OIDC / Firebase token fields). A payload carrying one is refused. */
export const RESERVED_CLAIM_NAMES: readonly string[] = [
  "acr", "amr", "at_hash", "aud", "auth_time", "azp", "cnf", "c_hash", "exp",
  "firebase", "iat", "iss", "jti", "nbf", "nonce", "sub",
];

/**
 * UIDs are restricted to the URL-safe alphabet Firebase generates. A custom
 * UID with other characters is refused (fail closed) rather than guessed at.
 */
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Google Cloud project id rules: 6–30 chars, lowercase letter first, no trailing hyphen. */
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Result types

export type RefusalCode =
  // environment
  | "runtime_unsafe"
  | "emulator_env_present"
  // argv
  | "unknown_flag"
  | "duplicate_flag"
  | "positional_arg"
  | "flag_value_missing"
  | "flag_value_unexpected"
  | "flag_conflict"
  | "project_confirmation_missing"
  | "project_id_invalid"
  | "credentials_missing"
  | "operation_missing"
  | "operation_invalid"
  | "target_missing_arg"
  | "target_uid_invalid"
  | "revoke_sessions_missing"
  | "revoke_sessions_invalid"
  | "reduction_flag_missing"
  | "confirmation_missing"
  // local files
  | "result_path_invalid"
  | "result_path_inside_repo"
  | "credentials_file_unreadable"
  | "credentials_file_unsafe"
  | "credentials_invalid"
  | "project_confirmation_mismatch"
  | "operator_token_file_unsafe"
  // pre-execution
  | "dirty_tree"
  // target
  | "target_missing"
  | "target_lookup_failed"
  | "target_mismatch"
  | "target_disabled"
  | "users_doc_read_failed"
  // plan
  | "claims_invalid"
  | "unrelated_claims_changed"
  | "reserved_claim"
  | "claims_too_large"
  // authorization
  | "operator_token_missing"
  | "operator_token_invalid"
  | "operator_token_revoked"
  | "operator_not_system_admin"
  | "admin_enumeration_failed"
  | "bootstrap_not_first"
  | "self_revoke"
  | "last_admin"
  // confirmation and audit
  | "confirmation_mismatch"
  | "audit_unavailable";

/** Every refusal code, for exhaustive test coverage. */
export const REFUSAL_CODES: readonly RefusalCode[] = [
  "runtime_unsafe", "emulator_env_present",
  "unknown_flag", "duplicate_flag", "positional_arg", "flag_value_missing", "flag_value_unexpected",
  "flag_conflict", "project_confirmation_missing", "project_id_invalid", "credentials_missing",
  "operation_missing", "operation_invalid", "target_missing_arg", "target_uid_invalid",
  "revoke_sessions_missing", "revoke_sessions_invalid", "reduction_flag_missing", "confirmation_missing",
  "result_path_invalid", "result_path_inside_repo", "credentials_file_unreadable", "credentials_file_unsafe",
  "credentials_invalid", "project_confirmation_mismatch", "operator_token_file_unsafe",
  "dirty_tree",
  "target_missing", "target_lookup_failed", "target_mismatch", "target_disabled", "users_doc_read_failed",
  "claims_invalid", "unrelated_claims_changed", "reserved_claim", "claims_too_large",
  "operator_token_missing", "operator_token_invalid", "operator_token_revoked", "operator_not_system_admin",
  "admin_enumeration_failed", "bootstrap_not_first", "self_revoke", "last_admin",
  "confirmation_mismatch", "audit_unavailable",
];

/** Outcomes that can only happen AFTER a Firebase write was attempted. */
export type PostWriteFailure =
  | "mint_failed"
  | "sessions_revoke_failed"
  | "users_doc_failed"
  | "verification_failed"
  | "audit_outcome_missing";

export type Refusal = { ok: false; code: RefusalCode; message: string };

export function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Environment

/**
 * The tool must only ever run in an operator's local shell. Any sign of a
 * Vercel build/runtime, a Next.js runtime, or NODE_ENV=production refuses.
 * Emulator host variables are refused too: the Admin SDK would silently send
 * every call (including the audit rows) to the emulator while the operator
 * believes they are acting on the named project.
 */
export function checkRuntimeEnvironment(env: Readonly<Record<string, string | undefined>>): Refusal | null {
  const present = (k: string) => typeof env[k] === "string" && env[k] !== "";
  for (const k of ["VERCEL", "VERCEL_ENV", "NEXT_RUNTIME"]) {
    if (present(k)) {
      return refuse("runtime_unsafe", `Refusing: ${k} is set. This tool runs only from a local operator shell, never in a Vercel or Next.js runtime.`);
    }
  }
  if (env.NODE_ENV === "production") {
    return refuse("runtime_unsafe", "Refusing: NODE_ENV=production. This tool runs only from a local operator shell.");
  }
  for (const k of ["FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"]) {
    if (present(k)) {
      return refuse("emulator_env_present", `Refusing: ${k} is set, so Admin SDK calls would go to an emulator, not the confirmed project. Unset it.`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argv

export type ClaimOperation = "grant" | "revoke";
export type RevokeSessions = "yes" | "no";

export type ParsedClaimArgs = {
  confirmProject: string;
  credentialsPath: string;
  targetUid: string;
  operation: ClaimOperation;
  /** Required on revoke, refused on grant. Owner policy is UNRESOLVED, so there is no default. */
  revokeSessions: RevokeSessions | null;
  operatorIdTokenFile: string | null;
  bootstrapFirstAdmin: boolean;
  allowClaimReduction: boolean;
  execute: boolean;
  confirmClaim: string | null;
  resultFile: string | null;
};

const VALUE_FLAGS = [
  "--confirm-project",
  "--credentials",
  "--target-uid",
  "--operation",
  "--revoke-sessions",
  "--operator-id-token-file",
  "--confirm-claim",
  "--result-file",
] as const;
const BOOLEAN_FLAGS = ["--execute", "--bootstrap-first-admin", "--allow-claim-reduction"] as const;

export const ALLOWED_FLAGS: readonly string[] = [...VALUE_FLAGS, ...BOOLEAN_FLAGS];

/**
 * Strict argv parser. Every token must be a known flag; each flag may appear
 * at most once; positional arguments are refused (they are how
 * `set-admin-by-uid.js <UID>` was used); value flags need a non-empty
 * `=value`; boolean flags take no value. Then required flags and mutually
 * exclusive combinations are checked. First failure wins.
 */
export function parseSetSystemAdminClaimArgs(argv: readonly string[]): { ok: true; args: ParsedClaimArgs } | Refusal {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (const token of argv) {
    if (!token.startsWith("--")) {
      return refuse("positional_arg", `Refusing positional argument "${token}". Every input is a named --flag=value.`);
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const isValueFlag = (VALUE_FLAGS as readonly string[]).includes(name);
    const isBooleanFlag = (BOOLEAN_FLAGS as readonly string[]).includes(name);
    if (!isValueFlag && !isBooleanFlag) {
      return refuse("unknown_flag", `Refusing unknown flag ${name}. Allowed: ${ALLOWED_FLAGS.join(", ")}.`);
    }
    if (values.has(name) || booleans.has(name)) {
      return refuse("duplicate_flag", `Refusing: ${name} given more than once.`);
    }
    if (isBooleanFlag) {
      if (eq !== -1) return refuse("flag_value_unexpected", `Refusing: ${name} takes no value.`);
      booleans.add(name);
      continue;
    }
    const value = eq === -1 ? "" : token.slice(eq + 1);
    if (value === "") return refuse("flag_value_missing", `Refusing: ${name} needs a value (${name}=...).`);
    values.set(name, value);
  }

  const confirmProject = values.get("--confirm-project");
  if (confirmProject === undefined) {
    return refuse("project_confirmation_missing", "Refusing: --confirm-project=<projectId> is required. There is no default project.");
  }
  if (!PROJECT_ID_PATTERN.test(confirmProject)) {
    return refuse("project_id_invalid", `Refusing: --confirm-project value is not a valid Google Cloud project id.`);
  }
  const credentialsPath = values.get("--credentials");
  if (credentialsPath === undefined) {
    return refuse("credentials_missing", "Refusing: --credentials=<service-account key file> is required. Credentials from environment variables or local env files are never used.");
  }
  const operationRaw = values.get("--operation");
  if (operationRaw === undefined) return refuse("operation_missing", "Refusing: --operation=grant|revoke is required.");
  if (operationRaw !== "grant" && operationRaw !== "revoke") {
    return refuse("operation_invalid", "Refusing: --operation must be exactly grant or revoke.");
  }
  const operation: ClaimOperation = operationRaw;
  const targetUid = values.get("--target-uid");
  if (targetUid === undefined) return refuse("target_missing_arg", "Refusing: --target-uid=<uid> is required. Targets are resolved by UID only.");
  if (!UID_PATTERN.test(targetUid)) {
    return refuse("target_uid_invalid", "Refusing: --target-uid must be 1-128 characters of [A-Za-z0-9_-].");
  }

  const revokeRaw = values.get("--revoke-sessions");
  let revokeSessions: RevokeSessions | null = null;
  if (operation === "revoke") {
    if (revokeRaw === undefined) {
      return refuse(
        "revoke_sessions_missing",
        "Refusing: --operation=revoke requires an explicit --revoke-sessions=yes|no. There is no default (owner policy decision; see docs/operations/system-admin-claim-script.md).",
      );
    }
    if (revokeRaw !== "yes" && revokeRaw !== "no") {
      return refuse("revoke_sessions_invalid", "Refusing: --revoke-sessions must be exactly yes or no.");
    }
    revokeSessions = revokeRaw;
    if (!booleans.has("--allow-claim-reduction")) {
      return refuse("reduction_flag_missing", "Refusing: removing the admin claim requires --allow-claim-reduction.");
    }
  } else {
    if (revokeRaw !== undefined) return refuse("flag_conflict", "Refusing: --revoke-sessions applies only to --operation=revoke.");
    if (booleans.has("--allow-claim-reduction")) {
      return refuse("flag_conflict", "Refusing: --allow-claim-reduction applies only to --operation=revoke.");
    }
  }

  const bootstrapFirstAdmin = booleans.has("--bootstrap-first-admin");
  const operatorIdTokenFile = values.get("--operator-id-token-file") ?? null;
  if (bootstrapFirstAdmin && operation !== "grant") {
    return refuse("flag_conflict", "Refusing: --bootstrap-first-admin applies only to --operation=grant.");
  }
  if (bootstrapFirstAdmin && operatorIdTokenFile !== null) {
    return refuse("flag_conflict", "Refusing: --bootstrap-first-admin and --operator-id-token-file are mutually exclusive.");
  }

  const execute = booleans.has("--execute");
  const confirmClaim = values.get("--confirm-claim") ?? null;
  if (!execute && confirmClaim !== null) {
    return refuse("flag_conflict", "Refusing: --confirm-claim is only meaningful with --execute. Run the dry run first, without either.");
  }
  if (execute && confirmClaim === null) {
    return refuse("confirmation_missing", "Refusing: --execute requires --confirm-claim=<exact string printed by the dry run>.");
  }

  return {
    ok: true,
    args: {
      confirmProject,
      credentialsPath,
      targetUid,
      operation,
      revokeSessions,
      operatorIdTokenFile,
      bootstrapFirstAdmin,
      allowClaimReduction: booleans.has("--allow-claim-reduction"),
      execute,
      confirmClaim,
      resultFile: values.get("--result-file") ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Local files

/** A secret-bearing file must be a regular file with no group or other permission bits (0600 or stricter). */
export function checkSecretFileMode(
  stat: { isFile: boolean; mode: number },
  code: "credentials_file_unsafe" | "operator_token_file_unsafe",
  label: string,
): Refusal | null {
  if (!stat.isFile) return refuse(code, `Refusing: ${label} is not a regular file.`);
  if ((stat.mode & 0o077) !== 0) {
    return refuse(code, `Refusing: ${label} is readable or writable by group/other (mode ${(stat.mode & 0o777).toString(8)}). chmod 600 it.`);
  }
  return null;
}

export type ServiceAccountEvidence = {
  source: "explicit-key-file";
  projectId: string;
  clientEmail: string;
  clientEmailMasked: string;
};

/**
 * Validates a parsed service-account key object. Never echoes any field of the
 * key except `project_id` (which is not secret) and a masked `client_email`.
 * `private_key` is checked for presence and shape only.
 */
export function validateServiceAccountKey(
  raw: unknown,
  confirmProject: string,
): { ok: true; evidence: ServiceAccountEvidence; privateKey: string } | Refusal {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("credentials_invalid", "Refusing: the credentials file is not a JSON object.");
  }
  const o = raw as Record<string, unknown>;
  if (o.type !== "service_account") {
    return refuse("credentials_invalid", 'Refusing: the credentials file is not a service-account key (type must be "service_account").');
  }
  if (typeof o.project_id !== "string" || !PROJECT_ID_PATTERN.test(o.project_id)) {
    return refuse("credentials_invalid", "Refusing: the credentials file has no valid project_id.");
  }
  if (typeof o.client_email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(o.client_email)) {
    return refuse("credentials_invalid", "Refusing: the credentials file has no valid client_email.");
  }
  if (typeof o.private_key !== "string" || !o.private_key.includes("PRIVATE KEY")) {
    return refuse("credentials_invalid", "Refusing: the credentials file has no usable private_key.");
  }
  if (o.project_id !== confirmProject) {
    return refuse(
      "project_confirmation_mismatch",
      `Refusing: --confirm-project=${confirmProject} does not match the credential's project_id (${o.project_id}).`,
    );
  }
  return {
    ok: true,
    evidence: {
      source: "explicit-key-file",
      projectId: o.project_id,
      clientEmail: o.client_email,
      clientEmailMasked: maskEmail(o.client_email),
    },
    privateKey: o.private_key,
  };
}

/** True when `child` is `parent` or lies beneath it (both already absolute and resolved). */
export function isPathInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/**
 * The local result file holds UIDs and must never be committed. Its directory
 * (after symlink resolution, done by the caller) must be outside the repo.
 */
export function checkResultPath(args: { resolvedFile: string; resolvedDir: string; repoRoot: string }): Refusal | null {
  if (!nodePath.isAbsolute(args.resolvedFile) || !args.resolvedFile.endsWith(".json")) {
    return refuse("result_path_invalid", "Refusing: --result-file must resolve to an absolute path ending in .json.");
  }
  if (isPathInside(args.resolvedDir, args.repoRoot) || isPathInside(args.resolvedFile, args.repoRoot)) {
    return refuse("result_path_inside_repo", "Refusing: the result file must be outside the git worktree (it contains UIDs).");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Target

export type UserRecordLike = {
  uid: string;
  email?: string;
  disabled?: unknown;
  customClaims?: unknown;
  tokensValidAfterTime?: string;
};

/** `disabled === false` strictly: a missing or non-boolean value refuses (admin-authority-tiers.md). */
export function checkTargetRecord(record: UserRecordLike, targetUid: string): Refusal | null {
  if (record.uid !== targetUid) {
    return refuse("target_mismatch", "Refusing: the Auth record returned does not have the requested UID.");
  }
  if (record.disabled !== false) {
    return refuse("target_disabled", "Refusing: the target account is disabled (or its disabled state is unknown).");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claim planning

export type Claims = Record<string, unknown>;

export type DiffLine = { kind: "add" | "change" | "remove"; key: string; before?: unknown; after?: unknown };

export type ClaimPlan = {
  operation: ClaimOperation;
  before: Claims;
  after: Claims;
  diff: DiffLine[];
  changed: boolean;
  targetIsAdminBefore: boolean;
};

function isPlainObject(v: unknown): v is Claims {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deterministic JSON with recursively sorted object keys, for byte-equality comparisons. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Every claim except `admin`, canonicalised. */
export function unrelatedClaimsFingerprint(claims: Claims): string {
  const rest: Claims = {};
  for (const k of Object.keys(claims)) if (k !== "admin") rest[k] = claims[k];
  return canonicalJson(rest);
}

export function claimsByteLength(claims: Claims): number {
  return Buffer.byteLength(JSON.stringify(claims), "utf8");
}

/**
 * Plans the change. Grant writes `{ ...before, admin: true }` — the intended
 * key LAST, so an existing `admin: false` cannot win (the defect in the
 * retired `set-admin-claim.js` / `set-admin-by-uid.js`). Revoke removes ONLY
 * the `admin` key. Every other claim is preserved (the retired
 * `setAdmin.ts` / `set-admin-simple.js` wiped them).
 */
export function planClaimChange(current: unknown, operation: ClaimOperation): { ok: true; plan: ClaimPlan } | Refusal {
  if (current !== undefined && current !== null && !isPlainObject(current)) {
    return refuse("claims_invalid", "Refusing: the target's current custom claims are not a plain object.");
  }
  const before: Claims = current ? { ...current } : {};
  let after: Claims;
  if (operation === "grant") {
    after = { ...before, admin: true };
  } else {
    after = {};
    for (const k of Object.keys(before)) if (k !== "admin") after[k] = before[k];
  }

  const diff: DiffLine[] = [];
  const hadAdmin = Object.prototype.hasOwnProperty.call(before, "admin");
  const hasAdmin = Object.prototype.hasOwnProperty.call(after, "admin");
  if (!hadAdmin && hasAdmin) diff.push({ kind: "add", key: "admin", after: after.admin });
  else if (hadAdmin && !hasAdmin) diff.push({ kind: "remove", key: "admin", before: before.admin });
  else if (hadAdmin && hasAdmin && canonicalJson(before.admin) !== canonicalJson(after.admin)) {
    diff.push({ kind: "change", key: "admin", before: before.admin, after: after.admin });
  }

  return {
    ok: true,
    plan: {
      operation,
      before,
      after,
      diff,
      changed: diff.length > 0,
      targetIsAdminBefore: before.admin === true,
    },
  };
}

/** Invariants every plan must satisfy before it may be written. Independent of how the plan was built. */
export function checkPlanInvariants(plan: ClaimPlan): Refusal | null {
  if (unrelatedClaimsFingerprint(plan.before) !== unrelatedClaimsFingerprint(plan.after)) {
    return refuse("unrelated_claims_changed", "Refusing: the planned claims change a claim other than admin.");
  }
  if (plan.operation === "grant" && plan.after.admin !== true) {
    return refuse("unrelated_claims_changed", "Refusing: the planned grant does not end with admin === true.");
  }
  if (plan.operation === "revoke" && Object.prototype.hasOwnProperty.call(plan.after, "admin")) {
    return refuse("unrelated_claims_changed", "Refusing: the planned revoke does not remove the admin key.");
  }
  const reserved = Object.keys(plan.after).filter((k) => RESERVED_CLAIM_NAMES.includes(k));
  if (reserved.length > 0) {
    return refuse("reserved_claim", `Refusing: the claims carry reserved name(s): ${reserved.join(", ")}.`);
  }
  const bytes = claimsByteLength(plan.after);
  if (bytes > CLAIMS_MAX_BYTES) {
    return refuse("claims_too_large", `Refusing: the resulting claims are ${bytes} bytes; Firebase allows ${CLAIMS_MAX_BYTES}.`);
  }
  return null;
}

export function formatDiff(plan: ClaimPlan): string[] {
  if (plan.diff.length === 0) return ["(no change)"];
  return plan.diff.map((d) =>
    d.kind === "add"
      ? `+ ${d.key}: ${canonicalJson(d.after)}`
      : d.kind === "remove"
        ? `- ${d.key} (was ${canonicalJson(d.before)})`
        : `~ ${d.key}: ${canonicalJson(d.before)} -> ${canonicalJson(d.after)}`,
  );
}

// ---------------------------------------------------------------------------
// Confirmation

/**
 * The exact typed confirmation. It binds the operation, the claim result, the
 * project and the UID (and, for revoke, the session decision), so a string
 * copied from a rehearsal on another project or another user cannot authorise
 * this write.
 */
export function expectedConfirmation(args: {
  operation: ClaimOperation;
  projectId: string;
  targetUid: string;
  revokeSessions: RevokeSessions | null;
}): string {
  if (args.operation === "grant") return `grant:admin:true:${args.projectId}:${args.targetUid}`;
  return `revoke:admin:removed:sessions-${args.revokeSessions ?? "unset"}:${args.projectId}:${args.targetUid}`;
}

export function checkConfirmation(provided: string | null, expected: string): Refusal | null {
  if (provided === null) {
    return refuse("confirmation_missing", "Refusing: --execute requires --confirm-claim.");
  }
  if (provided !== expected) {
    return refuse("confirmation_mismatch", `Refusing: --confirm-claim does not match. Expected exactly: ${expected}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Authorization

export type DecodedTokenLike = { uid: string; admin?: unknown; email?: unknown };

/**
 * SYSTEM_ADMIN is the `admin` custom claim ONLY (admin-authority-tiers.md);
 * ADMIN_EMAILS membership does not qualify. Requires the verified token AND the
 * live Auth record to carry `admin === true`, the live record to be enabled,
 * and both to name the same uid.
 */
export function checkOperatorAuthorization(decoded: DecodedTokenLike, live: UserRecordLike): Refusal | null {
  if (decoded.uid !== live.uid) {
    return refuse("operator_not_system_admin", "Refusing: the operator token and live record disagree on uid.");
  }
  if (decoded.admin !== true) {
    return refuse("operator_not_system_admin", "Refusing: the operator token does not carry admin === true.");
  }
  const liveClaims = isPlainObject(live.customClaims) ? live.customClaims : {};
  if (liveClaims.admin !== true) {
    return refuse("operator_not_system_admin", "Refusing: the operator's live Auth record does not carry admin === true.");
  }
  if (live.disabled !== false) {
    return refuse("operator_not_system_admin", "Refusing: the operator account is disabled (or its state is unknown).");
  }
  return null;
}

/** Firebase ID token shape check (three base64url segments). Never echoes the token. */
export function checkIdTokenShape(token: string): Refusal | null {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return refuse("operator_token_invalid", "Refusing: the operator token file does not contain a single ID token.");
  }
  return null;
}

/** Maps a verifyIdToken error to a refusal using only its code. The raw message is never used. */
export function classifyOperatorTokenError(code: unknown): Refusal {
  if (code === "auth/id-token-revoked") {
    return refuse("operator_token_revoked", "Refusing: the operator's sessions have been revoked. Sign in again and export a fresh token.");
  }
  if (code === "auth/user-disabled") {
    return refuse("operator_not_system_admin", "Refusing: the operator account is disabled.");
  }
  return refuse("operator_token_invalid", `Refusing: the operator ID token did not verify (${typeof code === "string" ? code : "unknown error"}).`);
}

/** Holders of `admin === true`, optionally only enabled ones. */
export function countAdminHolders(users: readonly UserRecordLike[], opts: { enabledOnly: boolean; excludeUid?: string }): number {
  return users.filter((u) => {
    if (opts.excludeUid !== undefined && u.uid === opts.excludeUid) return false;
    if (opts.enabledOnly && u.disabled !== false) return false;
    return isPlainObject(u.customClaims) && u.customClaims.admin === true;
  }).length;
}

/** First-admin bootstrap is valid only while NO account (enabled or not) holds admin === true. */
export function checkBootstrapFirstAdmin(adminHolders: number): Refusal | null {
  if (adminHolders !== 0) {
    return refuse("bootstrap_not_first", `Refusing: --bootstrap-first-admin requires zero existing admin holders; found ${adminHolders}.`);
  }
  return null;
}

export function checkRevokeSafety(args: {
  targetUid: string;
  operatorUid: string | null;
  targetIsAdminBefore: boolean;
  enabledAdminHoldersExcludingTarget: number;
}): Refusal | null {
  if (!args.targetIsAdminBefore) return null;
  if (args.operatorUid !== null && args.operatorUid === args.targetUid) {
    return refuse("self_revoke", "Refusing: an operator cannot revoke their own admin claim.");
  }
  if (args.enabledAdminHoldersExcludingTarget < 1) {
    return refuse("last_admin", "Refusing: this revoke would leave zero enabled admin holders.");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read-back

export function verifyReadBack(plan: ClaimPlan, readBackClaims: unknown): { ok: true } | { ok: false; detail: string } {
  const rb: Claims = isPlainObject(readBackClaims) ? readBackClaims : {};
  if (plan.operation === "grant" && rb.admin !== true) {
    return { ok: false, detail: "read-back admin is not true" };
  }
  if (plan.operation === "revoke" && Object.prototype.hasOwnProperty.call(rb, "admin")) {
    return { ok: false, detail: "read-back still carries an admin key" };
  }
  if (unrelatedClaimsFingerprint(rb) !== unrelatedClaimsFingerprint(plan.before)) {
    return { ok: false, detail: "read-back unrelated claims differ from before" };
  }
  return { ok: true };
}

/**
 * `tokensValidAfterTime` has one-second resolution; the revocation must be at
 * or after the second in which the run started.
 */
export function verifySessionsRevoked(tokensValidAfterTime: string | undefined, startedAtMs: number): boolean {
  if (typeof tokensValidAfterTime !== "string") return false;
  const t = Date.parse(tokensValidAfterTime);
  return Number.isFinite(t) && t >= Math.floor(startedAtMs / 1000) * 1000;
}

// ---------------------------------------------------------------------------
// Audit record (matches lib/admin/auditLog.ts#AuditLogEntry)

export type ClaimAuditActionType = "GRANT_SYSTEM_ADMIN_CLAIM" | "REVOKE_SYSTEM_ADMIN_CLAIM";
export type AuthorizationMode = "operator-id-token" | "first-admin-bootstrap";
export type AuditPhase = "attempt" | "outcome";
export type AuditOutcome = "applied" | PostWriteFailure;

export function generateRequestId(nowMs: number, randomPart: string): string {
  return `req_${nowMs}_${randomPart}`;
}

export function auditDocId(requestId: string, phase: AuditPhase): string {
  return `system-admin-claim:${requestId}:${phase}`;
}

/**
 * Builds one `admin_audit_logs` row in the EXISTING admin/billing schema read
 * by `/api/admin/users/[uid]/details` (targetUid + createdAt desc). It has no
 * `action` and no `at` field, so the governance audit reader ignores it.
 * `createdAt` is supplied by the caller (a Firestore `Timestamp`), keeping this
 * module free of firebase-admin.
 */
export function buildClaimAuditRecord<TS>(input: {
  phase: AuditPhase;
  outcome?: AuditOutcome;
  outcomeDetail?: string;
  requestId: string;
  createdAt: TS;
  projectId: string;
  operation: ClaimOperation;
  authorization: AuthorizationMode;
  adminUid: string;
  adminEmail?: string;
  targetUid: string;
  targetEmail?: string;
  beforeClaims: Claims;
  afterClaims: Claims;
  usersDocRoleBefore: string | null;
  usersDocRoleAfter: string | null;
  revokeSessions: RevokeSessions | null;
  credentialSource: ServiceAccountEvidence["source"];
  credentialClientEmailMasked: string;
  gitSha: string;
  confirmClaim: string;
}) {
  const metadata: Record<string, unknown> = {
    source: "operator-script",
    script: SCRIPT_PATH,
    phase: input.phase,
    projectId: input.projectId,
    authorization: input.authorization,
    credentialSource: input.credentialSource,
    credentialClientEmailMasked: input.credentialClientEmailMasked,
    revokeSessions: input.revokeSessions,
    gitSha: input.gitSha,
    confirmClaim: input.confirmClaim,
  };
  if (input.phase === "outcome") {
    metadata.outcome = input.outcome ?? "verification_failed";
    if (input.outcomeDetail) metadata.outcomeDetail = input.outcomeDetail;
  }
  const record: {
    adminUid: string;
    adminEmail?: string;
    targetUid: string;
    targetEmail?: string;
    actionType: ClaimAuditActionType;
    before: { customClaims: Claims; usersDocRole: string | null };
    after: { customClaims: Claims; usersDocRole: string | null };
    createdAt: TS;
    requestId: string;
    metadata: Record<string, unknown>;
  } = {
    adminUid: input.adminUid,
    targetUid: input.targetUid,
    actionType: input.operation === "grant" ? "GRANT_SYSTEM_ADMIN_CLAIM" : "REVOKE_SYSTEM_ADMIN_CLAIM",
    before: { customClaims: input.beforeClaims, usersDocRole: input.usersDocRoleBefore },
    after: { customClaims: input.afterClaims, usersDocRole: input.usersDocRoleAfter },
    createdAt: input.createdAt,
    requestId: input.requestId,
    metadata,
  };
  // Firestore rejects `undefined` field values; omit absent optionals.
  if (input.adminEmail) record.adminEmail = input.adminEmail;
  if (input.targetEmail) record.targetEmail = input.targetEmail;
  return record;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  const local = at === -1 ? email : email.slice(0, at);
  return `${local.slice(0, 4)}…@…`;
}
