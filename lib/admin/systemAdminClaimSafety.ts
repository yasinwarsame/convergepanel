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
 * CREDENTIAL SOURCE SEAM. Credential evidence carries a `source`
 * discriminant. Today the only source is `"explicit-key-file"` (validated here
 * by `validateServiceAccountKey`). PR #294 (Firebase environment isolation,
 * merged as 8a6ea65) added the operator production grant
 * (`scripts/lib/operatorProductionAccess.ts`); THIS tool has not adopted it
 * yet — that is a pending follow-up. Adopting it adds a second source
 * (`"operator-grant"`) and replaces the script's credential loader; nothing in
 * this module's planning, argv, confirmation or audit logic depends on how the
 * credential was obtained.
 */

import * as nodePath from "node:path";

import type { AdminActionType } from "./auditLog";

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
  | "reduction_flag_missing"
  | "confirmation_missing"
  // local files
  | "result_path_invalid"
  | "result_path_inside_repo"
  | "result_dir_unsafe"
  | "credentials_file_unreadable"
  | "credentials_file_unsafe"
  | "credentials_file_symlink"
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
  | "claims_prototype_key"
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
  // confirmation
  | "confirmation_mismatch";

/** Every refusal code, for exhaustive test coverage. */
export const REFUSAL_CODES: readonly RefusalCode[] = [
  "runtime_unsafe", "emulator_env_present",
  "unknown_flag", "duplicate_flag", "positional_arg", "flag_value_missing", "flag_value_unexpected",
  "flag_conflict", "project_confirmation_missing", "project_id_invalid", "credentials_missing",
  "operation_missing", "operation_invalid", "target_missing_arg", "target_uid_invalid",
  "reduction_flag_missing", "confirmation_missing",
  "result_path_invalid", "result_path_inside_repo", "result_dir_unsafe", "credentials_file_unreadable", "credentials_file_unsafe",
  "credentials_file_symlink",
  "credentials_invalid", "project_confirmation_mismatch", "operator_token_file_unsafe",
  "dirty_tree",
  "target_missing", "target_lookup_failed", "target_mismatch", "target_disabled", "users_doc_read_failed",
  "claims_invalid", "claims_prototype_key", "unrelated_claims_changed", "reserved_claim", "claims_too_large",
  "operator_token_missing", "operator_token_invalid", "operator_token_revoked", "operator_not_system_admin",
  "admin_enumeration_failed", "bootstrap_not_first", "self_revoke", "last_admin",
  "confirmation_mismatch",
];

/**
 * Outcomes that can only happen AFTER a Firebase write call was issued
 * (exit 3). `audit_attempt_failed` is the first write call itself failing: its
 * outcome is unknown (the create may have landed before the error), so it is
 * never reported as "nothing written".
 */
export type PostWriteFailure =
  | "audit_attempt_failed"
  | "mint_failed"
  | "sessions_revoke_failed"
  /**
   * The revocation cutoff was NOT observed: no server-time anchor, no
   * read-back `tokensValidAfterTime`, a value below the server-anchored
   * cutoff, or (revoke) a claim write that threw and is unconfirmed. Even the
   * opposite case — cutoff observed — is an observation under an unbounded
   * clock-alignment assumption, not proof of revocation.
   */
  | "sessions_revoke_unverified"
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

export type ParsedClaimArgs = {
  confirmProject: string;
  credentialsPath: string;
  targetUid: string;
  operation: ClaimOperation;
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
    if (name === "--revoke-sessions") {
      return refuse(
        "unknown_flag",
        "Refusing --revoke-sessions: the flag was removed. Revoking admin ALWAYS revokes the target's refresh tokens (owner policy); there is no opt-out.",
      );
    }
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

  if (operation === "revoke") {
    if (!booleans.has("--allow-claim-reduction")) {
      return refuse("reduction_flag_missing", "Refusing: removing the admin claim requires --allow-claim-reduction.");
    }
  } else {
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
  stat: { isFile: boolean; mode: number; isSymlink?: boolean },
  code: "credentials_file_unsafe" | "operator_token_file_unsafe",
  label: string,
): Refusal | null {
  // lstat result: a symlink is refused outright (the key file named on the
  // command line must be the file read, not whatever the link points at now).
  if (stat.isSymlink === true) {
    return refuse(code === "credentials_file_unsafe" ? "credentials_file_symlink" : code, `Refusing: ${label} is a symbolic link. Name the real file.`);
  }
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

/**
 * True when `child` is `parent` or lies beneath it. Both MUST already be
 * filesystem-canonical (realpath.native of an existing directory); this is a
 * `path.relative` comparison, never a lexical prefix test. With
 * `caseInsensitive` both are case-folded first, so `/users/op/apps/cp` is
 * inside `/Users/op/Apps/CP` on a case-insensitive volume (macOS/Windows default).
 */
export function isPathInside(child: string, parent: string, caseInsensitive = false): boolean {
  const c = caseInsensitive ? child.toLowerCase() : child;
  const p = caseInsensitive ? parent.toLowerCase() : parent;
  const rel = nodePath.relative(p, c);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel));
}

/**
 * The local result file holds UIDs and must never be committed. The caller
 * passes the filesystem-canonical parent directory (realpath.native — symlinks
 * resolved and on-disk case restored) and the canonical root of EVERY git
 * worktree of this repository; the file must lie inside none of them. Fails
 * closed: no protected root at all is a refusal.
 */
export function checkResultPath(args: {
  resolvedFile: string;
  resolvedDir: string;
  protectedRoots: readonly string[];
  caseInsensitive: boolean;
}): Refusal | null {
  if (!nodePath.isAbsolute(args.resolvedFile) || !args.resolvedFile.endsWith(".json")) {
    return refuse("result_path_invalid", "Refusing: --result-file must resolve to an absolute path ending in .json.");
  }
  if (!nodePath.isAbsolute(args.resolvedDir) || nodePath.dirname(args.resolvedFile) !== args.resolvedDir) {
    return refuse("result_path_invalid", "Refusing: the result file's directory could not be canonicalised.");
  }
  if (args.protectedRoots.length === 0 || args.protectedRoots.some((r) => !nodePath.isAbsolute(r))) {
    return refuse("result_path_invalid", "Refusing: the repository root could not be canonicalised.");
  }
  for (const root of args.protectedRoots) {
    if (isPathInside(args.resolvedDir, root, args.caseInsensitive) || isPathInside(args.resolvedFile, root, args.caseInsensitive)) {
      return refuse("result_path_inside_repo", "Refusing: the result file must be outside every git worktree of this repository (it contains UIDs).");
    }
  }
  return null;
}

export type DirStat = { isSymlink: boolean; isDirectory: boolean; uid: number; mode: number };

/**
 * The DEFAULT result directory lives in a shared temp location. On a
 * multi-user host another account could pre-create it (or a symlink in its
 * place) and race the result file. Require: not a symlink, a directory, owned
 * by the current uid, mode exactly 0700.
 */
export function checkResultDirStat(stat: DirStat | null, currentUid: number | null): Refusal | null {
  if (stat === null) return refuse("result_dir_unsafe", "Refusing: the default result directory could not be created or inspected.");
  if (stat.isSymlink) return refuse("result_dir_unsafe", "Refusing: the default result directory is a symbolic link.");
  if (!stat.isDirectory) return refuse("result_dir_unsafe", "Refusing: the default result directory path is not a directory.");
  if (currentUid === null || stat.uid !== currentUid) {
    return refuse("result_dir_unsafe", "Refusing: the default result directory is not owned by the current user.");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    return refuse("result_dir_unsafe", `Refusing: the default result directory has mode ${(stat.mode & 0o777).toString(8)}; it must be 700.`);
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

/**
 * GRANT requires `disabled === false` strictly: a disabled account, or one
 * whose disabled state is missing / not a boolean, never receives SYSTEM_ADMIN
 * (admin-authority-tiers.md).
 *
 * REVOKE is privilege REMOVAL and is allowed on a disabled account (owner
 * decision 2026-11-06): an operator who disabled a compromised admin must
 * still be able to strip the claim and revoke its sessions. The tool never
 * changes the `disabled` flag in either direction — it has no port that can.
 * A revoke still refuses a record whose disabled state is not a boolean
 * (malformed record; fail closed).
 */
export function checkTargetRecord(record: UserRecordLike, targetUid: string, operation: ClaimOperation): Refusal | null {
  if (record.uid !== targetUid) {
    return refuse("target_mismatch", "Refusing: the Auth record returned does not have the requested UID.");
  }
  if (operation === "grant" && record.disabled !== false) {
    return refuse("target_disabled", "Refusing: the target account is disabled (or its disabled state is unknown). A disabled account is never granted admin.");
  }
  if (operation === "revoke" && typeof record.disabled !== "boolean") {
    return refuse("target_disabled", "Refusing: the target account's disabled state is unknown (not a boolean).");
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
  return canonicalJson(Object.fromEntries(Object.entries(claims).filter(([k]) => k !== "admin")));
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
  if (current && Object.prototype.hasOwnProperty.call(current, "__proto__")) {
    // An own "__proto__" key would be silently dropped (or turned into a
    // prototype) by ordinary property assignment while copying claims.
    return refuse("claims_prototype_key", 'Refusing: the target\'s current claims carry an own "__proto__" key.');
  }
  const before: Claims = current ? Object.fromEntries(Object.entries(current)) : {};
  let after: Claims;
  if (operation === "grant") {
    after = { ...before, admin: true };
  } else {
    after = Object.fromEntries(Object.entries(before).filter(([k]) => k !== "admin"));
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
 * project and the UID (and, for revoke, the mandatory session revocation), so
 * a string copied from a rehearsal on another project or another user cannot
 * authorise this write. A revoke re-run whose claim is already absent (it only
 * completes the outstanding session revocation) uses the SAME string, so a
 * re-run of the exact same command is always accepted.
 */
export function expectedConfirmation(args: {
  operation: ClaimOperation;
  projectId: string;
  targetUid: string;
}): string {
  if (args.operation === "grant") return `grant:admin:true:${args.projectId}:${args.targetUid}`;
  return `revoke:admin:removed:sessions-revoked:${args.projectId}:${args.targetUid}`;
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
 * SESSION REVOCATION EVIDENCE (see the runbook, "What a revoke reports").
 *
 * firebase-admin's `revokeRefreshTokens(uid)` sends
 * `validSince: Math.floor(new Date().getTime() / 1000)` — the OPERATOR'S LOCAL
 * clock (firebase-admin 12.7.0, lib/auth/auth-api-request.js:1261). Auth
 * stores that value as `tokensValidAfterTime`; a session is revoked when its
 * `auth_time` (whole seconds) is strictly earlier
 * (lib/auth/base-auth.js:968-972). A slow operator clock therefore leaves
 * sessions signed in during the lag valid, and "the value advanced" says
 * nothing about coverage.
 *
 * What the tool records, kept apart on purpose:
 *   (a) API acknowledgment: `revokeRefreshTokens` returned without error.
 *   (b) Observed cutoff: the read-back `tokensValidAfterTime` compared with a
 *       server-anchored cutoff:
 *         anchor = the Firestore commit time of a write issued only AFTER the
 *                  claim write returned (the users/{uid}.role mirror);
 *         cutoff = anchor whole seconds + 1 + REVOCATION_SKEW_MARGIN_SECONDS;
 *         observed iff read-back tokensValidAfterTime (whole seconds) >= cutoff.
 *       The +1 covers the second containing the anchor (auth_time is truncated
 *       to seconds and the comparison is strict).
 *   (c) ASSUMPTION, not a guarantee: the anchor comes from Firestore and
 *       `tokensValidAfterTime` is judged by Firebase Auth. Google publishes no
 *       bound on the clock skew between them; the 2 s margin ASSUMES it is
 *       smaller. The comparison is therefore not proof of session revocation.
 *   (d) Enforcement of current admin privileges is NOT provided by any of
 *       this: SYSTEM_ADMIN bearer guards call verifyIdToken without
 *       checkRevoked (lib/firebase/auth-helpers.ts verifyAdminToken,
 *       lib/firebase/adminAuth.ts getRequestUser), so an already-issued ID
 *       token keeps admin: true until it expires (up to ~1 h). Session-cookie
 *       paths (verifySessionCookie(cookie, true)) do check revocation. Live
 *       enforcement is the separate S2 change.
 *   (e) Anything else (no anchor, no read-back, below cutoff, revocation call
 *       failed, claim write unconfirmed) is INCOMPLETE (exit 3).
 * The local clock is never compared with anything.
 */
export const REVOCATION_SKEW_MARGIN_SECONDS = 2;

/** (c) The cross-service clock assumption every observed cutoff depends on. Printed and recorded verbatim. */
export const REVOCATION_CLOCK_ASSUMPTION =
  `ASSUMPTION (unchecked by this tool): the Firestore and Firebase Auth server clocks differ by less than the ${REVOCATION_SKEW_MARGIN_SECONDS} s margin. Google publishes no bound on that skew (unbounded), so an observed cutoff is an observation under this assumption, not proof that sessions were revoked.`;

/** (d) What the revocation does NOT do for current admin privileges. Printed and recorded verbatim. */
export const CURRENT_PRIVILEGE_ENFORCEMENT_NOTE =
  "Current admin privileges are NOT cut off by this: SYSTEM_ADMIN bearer guards verify ID tokens without checkRevoked, so an already-issued ID token keeps admin: true until it expires (up to about 1 hour) regardless of revocation. Session-cookie paths (verifySessionCookie with revocation checking) do reject sessions started before tokensValidAfterTime. Enforcement against current privileges awaits S2 (live admin authorization in route guards).";

/** (a)+(b)+(c) in one line: the success summary for a revoke. */
export const REVOCATION_OBSERVED_SUMMARY =
  `revocation acknowledged; cutoff observed at/after server-anchored cutoff (assumes Firestore/Auth clock skew < ${REVOCATION_SKEW_MARGIN_SECONDS} s, unbounded)`;

/** A server timestamp (Firestore `Timestamp` shape: whole seconds + nanoseconds). */
export type ServerTime = { seconds: number; nanoseconds: number };

function isServerTime(t: unknown): t is ServerTime {
  if (t === null || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return Number.isSafeInteger(o.seconds) && (o.seconds as number) > 0
    && Number.isInteger(o.nanoseconds) && (o.nanoseconds as number) >= 0 && (o.nanoseconds as number) < 1e9;
}

function serverTimeAfter(a: ServerTime, b: ServerTime): boolean {
  return a.seconds > b.seconds || (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds);
}

export function serverTimeIso(t: ServerTime): string {
  return new Date(t.seconds * 1000 + Math.floor(t.nanoseconds / 1e6)).toISOString();
}

/**
 * Accepts the anchor only when it is a well-formed server time strictly later
 * than the attempt row's commit time (both Firestore commit times, one clock).
 *
 * Precise property: this rejects any returned time at or before the attempt
 * row's commit. It does NOT detect a stale time later than that — e.g. the
 * previous update time of a users/{uid} write by someone else that landed
 * after the attempt row (Firestore reports a no-op write with the document's
 * PREVIOUS update time). The real protection against a stale anchor is the
 * role write itself: it always sets `updatedAt: serverTimestamp()`, so it
 * always changes the document and its writeTime is its own commit time
 * (pinned by the CLI spec). This check is a backstop for the narrower case.
 */
export function checkRevocationAnchor(
  anchor: unknown,
  attemptCommitTime: unknown,
): { ok: true; anchor: ServerTime } | { ok: false; detail: string } {
  if (!isServerTime(anchor)) return { ok: false, detail: "the role write returned no usable server commit time" };
  if (!isServerTime(attemptCommitTime)) return { ok: false, detail: "the attempt row returned no usable server commit time to check the anchor against" };
  if (!serverTimeAfter(anchor, attemptCommitTime)) {
    return { ok: false, detail: "the role write's commit time is not later than the attempt row's (stale or no-op write time)" };
  }
  return { ok: true, anchor };
}

/** Whole-second cutoff (Unix seconds) that `tokensValidAfterTime` must reach. */
export function revocationCutoffSeconds(anchor: ServerTime): number {
  return anchor.seconds + 1 + REVOCATION_SKEW_MARGIN_SECONDS;
}

/**
 * Compares the server's read-back `tokensValidAfterTime` with the
 * server-anchored cutoff. Never consults the local clock. `ok` means the
 * cutoff was OBSERVED — not that revocation is proven (see
 * REVOCATION_CLOCK_ASSUMPTION).
 */
export function observeRevocationCutoff(
  afterTokensValidAfterTime: unknown,
  cutoffSeconds: number,
): { ok: true; validSinceSeconds: number } | { ok: false; detail: string; validSinceSeconds: number | null } {
  if (typeof afterTokensValidAfterTime !== "string") {
    return { ok: false, detail: "the read-back Auth record has no tokensValidAfterTime", validSinceSeconds: null };
  }
  const ms = Date.parse(afterTokensValidAfterTime);
  if (!Number.isFinite(ms)) {
    return { ok: false, detail: "the read-back tokensValidAfterTime is not a date", validSinceSeconds: null };
  }
  const validSinceSeconds = Math.floor(ms / 1000);
  if (!Number.isSafeInteger(cutoffSeconds) || cutoffSeconds <= 0) {
    return { ok: false, detail: "no valid server-anchored cutoff", validSinceSeconds };
  }
  if (validSinceSeconds < cutoffSeconds) {
    return {
      ok: false,
      validSinceSeconds,
      detail: `tokensValidAfterTime ${new Date(validSinceSeconds * 1000).toISOString()} is earlier than the server-anchored cutoff ${new Date(cutoffSeconds * 1000).toISOString()}: sessions started while the admin claim was present may still be valid. revokeRefreshTokens uses the operator's local clock; it is probably behind server time — sync it (NTP) and re-run`,
    };
  }
  return { ok: true, validSinceSeconds };
}

/**
 * Recorded in the result file and the outcome audit row of every revoke.
 * The five things a reader must keep apart are separate fields:
 * (a) revocationApiAcknowledged, (b) cutoffObserved (+ the times),
 * (c) clockAlignmentAssumption, (d) currentPrivilegeEnforcement,
 * (e) detail (why the run is incomplete, when it is).
 */
export type SessionRevocationEvidence = {
  /** How this run handled the claim: confirmed write, write that threw (unconfirmed), or skipped (already absent). */
  claimWrite: "confirmed" | "unconfirmed" | "skipped_already_absent";
  /** (a) revokeRefreshTokens returned without error. An acknowledgment, nothing more. */
  revocationApiAcknowledged: boolean;
  anchorSource: "firestore-commit-time:users/{uid}.role";
  anchorServerTime: string | null;
  marginSeconds: number;
  cutoff: string | null;
  tokensValidAfterTimeBefore: string | null;
  tokensValidAfterTimeAfter: string | null;
  /** Read-back validSince minus the anchor, in seconds (positive = ahead of server time). */
  validSinceMinusAnchorSeconds: number | null;
  /** (b) read-back tokensValidAfterTime >= the server-anchored cutoff. An observation, not proof. */
  cutoffObserved: boolean;
  /** (c) always REVOCATION_CLOCK_ASSUMPTION. */
  clockAlignmentAssumption: string;
  /** (d) always CURRENT_PRIVILEGE_ENFORCEMENT_NOTE. */
  currentPrivilegeEnforcement: string;
  /** (e) why the cutoff was not observed / the run is incomplete; null when observed. */
  detail: string | null;
};

// ---------------------------------------------------------------------------
// Audit record (matches lib/admin/auditLog.ts#AuditLogEntry)

/**
 * actionType separates an ATTEMPT from a COMPLETED privilege change, so a row
 * listed on its own (the admin user-details page shows actionType) can never
 * be read as "admin was granted/revoked" unless the claim read-back matched:
 *   - SYSTEM_ADMIN_CLAIM_ATTEMPT   every attempt row (written BEFORE any change)
 *   - GRANT_/REVOKE_SYSTEM_ADMIN_CLAIM   outcome row, claim change read back as
 *                                  planned (revoke: also revocation acknowledged
 *                                  and cutoff observed, under the clock assumption)
 *   - REVOKE_SYSTEM_ADMIN_SESSIONS outcome row, claim was already absent; this
 *                                  run only revoked sessions (acknowledged,
 *                                  cutoff observed, under the clock assumption)
 *   - SYSTEM_ADMIN_CLAIM_INCOMPLETE outcome row, anything else
 */
export type ClaimAuditActionType =
  | "SYSTEM_ADMIN_CLAIM_ATTEMPT"
  | "GRANT_SYSTEM_ADMIN_CLAIM"
  | "REVOKE_SYSTEM_ADMIN_CLAIM"
  | "REVOKE_SYSTEM_ADMIN_SESSIONS"
  | "SYSTEM_ADMIN_CLAIM_INCOMPLETE";
export type AuthorizationMode = "operator-id-token" | "first-admin-bootstrap";
export type AuditPhase = "attempt" | "outcome";
/** Completed outcomes (exit 0) and incomplete ones (exit 3). */
export type CompletedOutcome = "applied" | "claim_already_absent_sessions_revoked";
export type AuditOutcome = CompletedOutcome | PostWriteFailure;
/** Whether a post-write read actually returned data ("failed" = threw; nothing is known). */
export type ReadOutcome = "read" | "failed";
export type ReadBackStatus = { customClaims: ReadOutcome; usersDocRole: ReadOutcome };
/** How the claim is handled by this run: written, or (revoke re-run) already absent and NOT rewritten. */
export type ClaimWritePlan = "write" | "skip_already_absent";

// Compile-time: every claim action type is a declared AdminActionType.
type ClaimActionTypesAreAdminActionTypes = ClaimAuditActionType extends AdminActionType ? true : never;
const claimActionTypesAreAdminActionTypes: ClaimActionTypesAreAdminActionTypes = true;
void claimActionTypesAreAdminActionTypes;

export function isCompletedOutcome(o: AuditOutcome): o is CompletedOutcome {
  return o === "applied" || o === "claim_already_absent_sessions_revoked";
}

export function claimAuditActionType(phase: AuditPhase, operation: ClaimOperation, outcome?: AuditOutcome): ClaimAuditActionType {
  if (phase === "attempt") return "SYSTEM_ADMIN_CLAIM_ATTEMPT";
  if (outcome === "applied") return operation === "grant" ? "GRANT_SYSTEM_ADMIN_CLAIM" : "REVOKE_SYSTEM_ADMIN_CLAIM";
  if (outcome === "claim_already_absent_sessions_revoked" && operation === "revoke") return "REVOKE_SYSTEM_ADMIN_SESSIONS";
  return "SYSTEM_ADMIN_CLAIM_INCOMPLETE";
}

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
  /** Every failure recorded by the run, in order (not only the first). */
  outcomeDetails?: readonly string[];
  /** Revoke outcome rows: the session-revocation evidence. */
  sessionRevocationEvidence?: SessionRevocationEvidence | null;
  /**
   * Outcome rows only: whether each `after` field was actually read back.
   * Missing (or any "failed") => `afterSemantics: "unknown"`; fail closed.
   */
  readBack?: ReadBackStatus;
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
  /** Attempt: the intended claims. Outcome: the read-back claims, or null when they could not be read. */
  afterClaims: Claims | null;
  usersDocRoleBefore: string | null;
  usersDocRoleAfter: string | null;
  claimWrite: ClaimWritePlan;
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
    requestedOperation: input.operation,
    claimWrite: input.claimWrite,
    // Revoke ALWAYS revokes refresh tokens (owner policy); grant never does.
    sessionRevocation: input.operation === "revoke" ? "required" : "not_applicable",
    gitSha: input.gitSha,
    confirmClaim: input.confirmClaim,
  };
  // The attempt row's `after` is the INTENDED state, never evidence that it
  // was reached; only an outcome row with completed === true is. An outcome
  // row whose read-back did not fully succeed NEVER presents a snapshot: the
  // unread fields are null, afterSemantics is "unknown", and it can never be
  // a completed outcome.
  const readBack: ReadBackStatus | undefined = input.phase === "outcome"
    ? {
      customClaims: input.readBack?.customClaims === "read" && input.afterClaims !== null ? "read" : "failed",
      usersDocRole: input.readBack?.usersDocRole === "read" ? "read" : "failed",
    }
    : undefined;
  const fullyRead = readBack !== undefined && readBack.customClaims === "read" && readBack.usersDocRole === "read";
  let outcome: AuditOutcome | undefined = input.phase === "outcome" ? (input.outcome ?? "verification_failed") : undefined;
  if (outcome !== undefined && !fullyRead && isCompletedOutcome(outcome)) outcome = "verification_failed";
  // A revoke is only ever recorded as completed when the revocation call was
  // acknowledged AND the cutoff was observed (an observation under the clock
  // assumption — never described as proof).
  if (
    outcome !== undefined && input.operation === "revoke" && isCompletedOutcome(outcome)
    && (input.sessionRevocationEvidence?.cutoffObserved !== true || input.sessionRevocationEvidence?.revocationApiAcknowledged !== true)
  ) {
    outcome = "sessions_revoke_unverified";
  }
  if (input.phase === "outcome" && input.operation === "revoke") {
    metadata.sessionRevocationEvidence = input.sessionRevocationEvidence ?? null;
  }
  metadata.completed = outcome !== undefined && isCompletedOutcome(outcome);
  metadata.afterSemantics = input.phase === "attempt" ? "intended-not-applied" : fullyRead ? "read-back" : "unknown";
  if (readBack !== undefined) metadata.readBack = readBack;
  if (outcome !== undefined) {
    metadata.outcome = outcome;
    const details = (input.outcomeDetails ?? []).filter((d) => typeof d === "string" && d !== "");
    if (details.length > 0) {
      metadata.outcomeDetail = details.join("; ");
      metadata.outcomeDetails = [...details];
    }
  }
  const afterClaims: Claims | null = readBack !== undefined && readBack.customClaims !== "read" ? null : input.afterClaims;
  const afterRole: string | null = readBack !== undefined && readBack.usersDocRole !== "read" ? null : input.usersDocRoleAfter;
  const record: {
    adminUid: string;
    adminEmail?: string;
    targetUid: string;
    targetEmail?: string;
    actionType: ClaimAuditActionType;
    before: { customClaims: Claims; usersDocRole: string | null };
    after: { customClaims: Claims | null; usersDocRole: string | null };
    createdAt: TS;
    requestId: string;
    metadata: Record<string, unknown>;
  } = {
    adminUid: input.adminUid,
    targetUid: input.targetUid,
    actionType: claimAuditActionType(input.phase, input.operation, outcome),
    before: { customClaims: input.beforeClaims, usersDocRole: input.usersDocRoleBefore },
    after: { customClaims: afterClaims, usersDocRole: afterRole },
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
