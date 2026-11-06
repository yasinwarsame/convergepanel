/**
 * CLASSIFICATION: MINTS-AUTHORITY (operator tool: grants or revokes the
 * Firebase `admin` custom claim, i.e. SYSTEM_ADMIN).
 *
 * SAFE-PROBE:PROHIBITION — this tool changes SYSTEM_ADMIN authority. It is
 * never a secret-liveness probe and must not be used to check whether an old
 * bootstrap secret still works: it does not use that secret at all. To verify
 * a rotation use `scripts/probe-admin-secret.mjs`, which cannot mint anything.
 *
 * This is the only supported out-of-band ("Option 1") path for the admin claim.
 * It replaces the retired scripts/setAdmin.ts, scripts/set-admin-claim.js,
 * scripts/set-admin-simple.js and scripts/set-admin-by-uid.js.
 * Runbook: docs/operations/system-admin-claim-script.md.
 *
 * USAGE (dry run is the default; nothing is written without --execute):
 *
 *   npm run admin:set-system-admin-claim -- \
 *     --confirm-project=<projectId> \
 *     --credentials=<service-account key file, mode 0600> \
 *     --target-uid=<uid> \
 *     --operation=grant|revoke \
 *     [--allow-claim-reduction]             # REQUIRED with revoke (revoke ALWAYS revokes refresh tokens)
 *     [--operator-id-token-file=<file>]     # SYSTEM_ADMIN ID token, mode 0600; required for --execute
 *     [--bootstrap-first-admin]             # instead of a token, only while zero admins exist
 *     [--execute --confirm-claim=<exact string printed by the dry run>]
 *     [--result-file=<path to a NEW *.json file outside every git checkout>]
 *
 * EXIT CODES: 0 completed — claims read back as planned and, on revoke, the
 *   revocation acknowledged with the cutoff observed (an observation under an
 *   unbounded clock-alignment assumption, NOT proof of revocation; already-issued
 *   ID tokens keep admin: true on SYSTEM_ADMIN bearer routes until they expire)
 *   — or a grant already in place;
 * 2 refused or dry run — no Firebase write call was issued;
 * 3 a write call was issued (possibly only the attempt audit row) and the
 *   operation is incomplete — re-running the same command is safe;
 * 1 the result file could not be written after an otherwise-successful run.
 *
 * CREDENTIALS. Only the key file named by --credentials is used. This tool
 * never loads .env.local and never reads FIREBASE_* / GOOGLE_* credential
 * variables; it initialises its own named Firebase app from that file.
 * Custody of that key file is the real security boundary — anyone holding it
 * can bypass every check in this file (see lib/admin/systemAdminClaimSafety.ts).
 *
 * PROJECT BINDING is by construction, not by a network check: the key's
 * project_id must equal --confirm-project, and the app is initialised with
 * that explicit projectId (no ambient project discovery). runCli's comparison
 * of the factory's projectId with --confirm-project is a local consistency
 * assertion over the factory; it makes no call to Google and cannot detect
 * anything the key's project_id did not already determine.
 *
 * CREDENTIAL SEAM. `loadOperatorCredential` below is the single place that
 * turns operator input into a credential. PR #294 (merged, 8a6ea65) added the
 * operator production grant (scripts/lib/operatorProductionAccess.ts); this
 * tool has NOT adopted it yet — a pending follow-up. Adopting it replaces this
 * function (and makes the grant this file's first import); the executor, the
 * audit schema and the confirmation format are unchanged by that swap.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

import {
  type ClaimAuthPort,
  type ClaimStorePort,
  type RunResult,
  RERUN_IS_SAFE,
  runSystemAdminClaim,
} from "../../lib/admin/systemAdminClaimExecution";
import {
  AUDIT_COLLECTION,
  type ParsedClaimArgs,
  type Refusal,
  type ServiceAccountEvidence,
  type DirStat,
  checkIdTokenShape,
  checkResultDirStat,
  checkResultPath,
  checkRuntimeEnvironment,
  checkSecretFileMode,
  generateRequestId,
  parseSetSystemAdminClaimArgs,
  refuse,
  validateServiceAccountKey,
} from "../../lib/admin/systemAdminClaimSafety";

// ---------------------------------------------------------------------------
// Injectable boundaries (real implementations at the bottom of the file)

/** One open of a secret file: lstat for symlinks, then open(O_NOFOLLOW) + fstat + read through that descriptor. */
export type SecretFileRead = { isSymlink: boolean; isFile: boolean; mode: number; body: string | null };

/** The exclusively-created result file, written through the descriptor kept from the create (never reopened by path). */
export type ResultFileHandle = { write: (contents: string) => void; close: () => void };

/**
 * Filesystem identity of an existing path (stat, symlinks FOLLOWED):
 * `{ id: "<dev>:<ino>" }`. "absent" for ENOENT/ENOTDIR; "error" for anything
 * else. Two spellings of one directory (case variants, symlinks, macOS
 * firmlinks such as /System/Volumes/Data/Users vs /Users) share one identity
 * even when no string canonicaliser agrees. Only directories that ARE a
 * protected root are compared: an alias (bind mount, nullfs) of a
 * SUBDIRECTORY of a worktree is not recognised (documented residual).
 */
export type IdentityResult = { id: string } | "absent" | "error";

/** A validated result-file location: what the post-create re-check compares against. */
export type ResultLocation = {
  /** The file path to create: the canonical directory + the requested basename. */
  file: string;
  /** realpath.native of the parent directory at validation time. */
  dir: string;
  /** Filesystem identity of that directory at validation time. */
  dirId: string;
  /** Filesystem identities of the repository root and every git worktree root. */
  protectedIds: ReadonlySet<string>;
};

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** null when the path does not exist or cannot be opened. */
  readSecretFile: (p: string) => SecretFileRead | null;
  /** Filesystem-canonical path (realpath.native: symlinks resolved, on-disk case) of an EXISTING path; null otherwise. */
  realpathDir: (p: string) => string | null;
  /**
   * Roots of every git worktree of the repository at repoRoot, from
   * `git worktree list --porcelain -z` run with a sanitized environment
   * (gitEnv). null — refused, never treated as "none" — when git fails, the
   * output is not exactly the documented record format, or ANY worktree is
   * reported prunable (moved or deleted: the list no longer says where it is).
   */
  gitWorktreeRoots: () => string[] | null;
  /** Filesystem identity (dev:ino, symlinks followed) of `p`. */
  statIdentity: (p: string) => IdentityResult;
  /** True when paths under `canonicalDir` compare case-insensitively (always true on darwin/win32). */
  caseInsensitivePaths: (canonicalDir: string) => boolean;
  /** What is at `p` WITHOUT following a final symlink. */
  lstatKind: (p: string) => "absent" | "symlink" | "file" | "other" | "error";
  /**
   * Create the result file exclusively (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600)
   * before any Firebase call and keep the fd. Throws (removing the file only
   * when it is provably its own) unless, AFTER the create, the fd's file is
   * the entry at `loc.file`, the parent directory still has identity
   * `loc.dirId` and canonicalises to `loc.dir`, no ancestor of the
   * re-canonicalised directory has a protected identity, and no ancestor
   * contains a `.git` entry. The returned `write` repeats those checks
   * immediately before writing and throws (writing nothing) if they fail.
   */
  createResultFile: (loc: ResultLocation) => ResultFileHandle;
  /** Create (0700) or lstat the default result directory; returns its lstat for checkResultDirStat. */
  prepareDefaultResultDir: () => { dir: string; stat: DirStat | null };
  currentUid: () => number | null;
  git: () => { sha: string | null; dirty: boolean | null };
  nowMs: () => number;
  randomPart: () => string;
  /** A timer wait (see ExecutionDeps.sleepMs). */
  sleepMs: (ms: number) => Promise<void>;
};

export type FirebaseHandle = {
  projectId: string;
  auth: ClaimAuthPort;
  store: ClaimStorePort;
  timestampNow: () => unknown;
  dispose: () => Promise<void>;
};

export type FirebaseFactory = (input: {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  appName: string;
}) => FirebaseHandle;

export type CliOptions = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  repoRoot: string;
  io: CliIo;
  firebase: FirebaseFactory;
};

// ---------------------------------------------------------------------------
// Credential loading — the credential seam (PR #294 grant adoption is a pending follow-up)

type LoadedCredential = { evidence: ServiceAccountEvidence; privateKey: string };

/**
 * Turns `--credentials` into a validated service-account credential. Refuses a
 * missing or unsafe file, unparseable JSON (without echoing the parser error,
 * whose message can contain a fragment of the key), a non-service-account
 * key, or a project_id that differs from --confirm-project.
 */
export function loadOperatorCredential(args: ParsedClaimArgs, io: CliIo): { ok: true; credential: LoadedCredential } | Refusal {
  const file = path.resolve(args.credentialsPath);
  const read = io.readSecretFile(file);
  if (!read) return refuse("credentials_file_unreadable", "Refusing: the --credentials file does not exist or cannot be read.");
  const unsafe = checkSecretFileMode(read, "credentials_file_unsafe", "the --credentials file");
  if (unsafe) return unsafe;
  if (read.body === null) return refuse("credentials_file_unreadable", "Refusing: the --credentials file could not be read.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.body);
  } catch {
    return refuse("credentials_invalid", "Refusing: the --credentials file is not valid JSON.");
  }
  const v = validateServiceAccountKey(parsed, args.confirmProject);
  if (!v.ok) return v;
  return { ok: true, credential: { evidence: v.evidence, privateKey: v.privateKey } };
}

function makeOperatorTokenReader(io: CliIo) {
  return async (p: string): Promise<{ ok: true; token: string } | Refusal> => {
    const file = path.resolve(p);
    const read = io.readSecretFile(file);
    if (!read) return refuse("operator_token_invalid", "Refusing: the operator token file does not exist or cannot be read.");
    const unsafe = checkSecretFileMode(read, "operator_token_file_unsafe", "the operator token file");
    if (unsafe) return unsafe;
    if (read.body === null) return refuse("operator_token_invalid", "Refusing: the operator token file could not be read.");
    const token = read.body.trim();
    const shape = checkIdTokenShape(token);
    if (shape) return shape;
    return { ok: true, token };
  };
}

// ---------------------------------------------------------------------------
// Result-file location (filesystem-grounded, fail closed)

const INSIDE_REPO_MESSAGE = "Refusing: the result file must be outside every git worktree of this repository (it contains UIDs).";
const INSIDE_CHECKOUT_MESSAGE =
  "Refusing: the result file's directory or one of its ancestors contains a `.git` entry, i.e. it lies inside a git checkout (of this or any repository). The result file contains UIDs; put it outside every checkout.";
const WORKTREE_STATE_HINT =
  "Run `git worktree list` in the repository: a worktree that was moved must be re-registered (`git worktree repair <new path>`), one that was deleted must be removed (`git worktree prune`). Then re-run.";

/**
 * Environment for every git child process. ALL inherited `GIT_*` variables
 * are dropped (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_CEILING_DIRECTORIES, GIT_CONFIG_COUNT/KEY_n/VALUE_n,
 * GIT_CONFIG_PARAMETERS, ...): any of them can make `git -C <repoRoot>`
 * describe a different repository or a different index, and the worktree
 * enumeration would then protect the wrong directories. System and global
 * config are not read (only the repository's own config); optional locks are
 * off so `git status` never rewrites the index.
 */
export function gitEnv(hostEnv: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const out = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v === undefined || /^GIT_/i.test(k)) continue;
    out[k] = v;
  }
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_CONFIG_GLOBAL = os.devNull;
  out.GIT_OPTIONAL_LOCKS = "0";
  return out;
}

const WORKTREE_ATTRS: Record<string, "value" | "none" | "optional"> = {
  HEAD: "value",
  branch: "value",
  detached: "none",
  bare: "none",
  locked: "optional",
};

/**
 * Strict parser for `git worktree list --porcelain -z`: attributes are
 * NUL-terminated and every record ends with an extra NUL, so a worktree path
 * may contain a newline. Returns null — never a partial list — on anything
 * but exactly that format: empty output, a missing terminator, a record not
 * starting with one absolute `worktree <path>`, an unknown or repeated
 * attribute, or a `prunable` attribute (a moved or deleted worktree: git no
 * longer knows where it is, so the protected set would be incomplete).
 */
export function parseWorktreeListPorcelainZ(out: string): string[] | null {
  if (!out.endsWith("\0\0")) return null;
  const tokens = out.split("\0");
  tokens.pop(); // the empty string after the output's final NUL; the "" before it closes the last record
  const roots: string[] = [];
  let seen: Set<string> | null = null;
  for (const t of tokens) {
    if (t === "") {
      if (seen === null) return null; // empty record
      seen = null;
      continue;
    }
    if (seen === null) {
      if (!t.startsWith("worktree ")) return null;
      const p = t.slice("worktree ".length);
      if (p === "" || !path.isAbsolute(p)) return null;
      roots.push(p);
      seen = new Set(["worktree"]);
      continue;
    }
    const sp = t.indexOf(" ");
    const key = sp === -1 ? t : t.slice(0, sp);
    const shape = Object.prototype.hasOwnProperty.call(WORKTREE_ATTRS, key) ? WORKTREE_ATTRS[key] : undefined;
    if (shape === undefined || seen.has(key)) return null; // includes "prunable" and a second "worktree"
    if (shape === "value" && (sp === -1 || sp === t.length - 1)) return null;
    if (shape === "none" && sp !== -1) return null;
    seen.add(key);
  }
  if (seen !== null) return null; // last record not terminated
  return roots.length > 0 ? roots : null;
}

/**
 * Checkout layer: refuses when `canonicalDir` or ANY ancestor contains a
 * `.git` entry (directory, gitfile, symlink — anything). This needs no
 * enumeration at all, so it also covers a linked worktree git has lost track
 * of (moved with `mv`) and a separate clone of the repository. Fails closed:
 * a `.git` path that cannot be inspected is a refusal.
 */
export function checkNoGitAncestor(canonicalDir: string, lstatKind: CliIo["lstatKind"]): Refusal | null {
  let cur = canonicalDir;
  for (;;) {
    const k = lstatKind(path.join(cur, ".git"));
    if (k === "error") {
      return refuse("result_path_invalid", "Refusing: whether the result file's directory lies inside a git checkout could not be established.");
    }
    if (k !== "absent") return refuse("result_path_inside_repo", INSIDE_CHECKOUT_MESSAGE);
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Identity layer of the location check: walks `canonicalDir` and EVERY
 * ancestor up to the filesystem root and refuses if any of them has the
 * filesystem identity (dev:ino) of a protected root. Containment is decided by
 * the filesystem, not by spelling, so an alternate path to a protected ROOT
 * (macOS firmlink /System/Volumes/Data/..., a bind mount of the root itself, a
 * case variant the canonicaliser left alone) is still recognised as inside. An
 * alias of a SUBDIRECTORY of a root is not (documented residual). Fails
 * closed: an ancestor whose identity cannot be established is a refusal.
 */
export function checkAncestorIdentities(
  canonicalDir: string,
  protectedIds: ReadonlySet<string>,
  statIdentity: (p: string) => IdentityResult,
): { ok: true; dirId: string } | Refusal {
  if (!path.isAbsolute(canonicalDir)) {
    return refuse("result_path_invalid", "Refusing: the result file's directory could not be canonicalised.");
  }
  let dirId: string | null = null;
  let cur = canonicalDir;
  for (;;) {
    const s = statIdentity(cur);
    if (s === "absent" || s === "error") {
      return refuse("result_path_invalid", "Refusing: the filesystem identity of the result file's directory or one of its ancestors could not be established.");
    }
    if (protectedIds.has(s.id)) return refuse("result_path_inside_repo", INSIDE_REPO_MESSAGE);
    if (dirId === null) dirId = s.id;
    const parent = path.dirname(cur);
    if (parent === cur) return { ok: true, dirId };
    cur = parent;
  }
}

/**
 * Three layers, all must pass. (1) Strings: the parent directory and every
 * protected root are canonicalised through the filesystem (realpath.native,
 * never lexically) and compared case-folded on a case-insensitive volume.
 * (2) Identity: no ancestor-or-self of the canonical directory may have the
 * dev:ino of the repository root or of ANY git worktree root
 * (checkAncestorIdentities). (3) Checkout: no ancestor-or-self may contain a
 * `.git` entry (checkNoGitAncestor).
 *
 * Ambiguous repository state is a refusal, never "fewer protected roots": a
 * worktree list that cannot be obtained or parsed, is empty, reports a
 * prunable worktree, does not include the repository root itself (git was
 * pointed at another repository), or names a worktree whose directory is
 * absent or cannot be identified. The target must not exist yet (no file, no
 * symlink); the exclusive O_NOFOLLOW create and its post-create re-check then
 * close the remaining race.
 */
export function checkResultLocation(
  resultFile: string,
  repoRoot: string,
  io: Pick<CliIo, "realpathDir" | "gitWorktreeRoots" | "caseInsensitivePaths" | "lstatKind" | "statIdentity">,
): ({ ok: true } & ResultLocation) | Refusal {
  const dir = io.realpathDir(path.dirname(resultFile));
  if (dir === null) {
    return refuse("result_path_invalid", "Refusing: the result file's directory does not exist or could not be canonicalised.");
  }
  const repoCanonical = io.realpathDir(repoRoot);
  if (repoCanonical === null) {
    return refuse("result_path_invalid", "Refusing: the repository root could not be canonicalised.");
  }
  const worktrees = io.gitWorktreeRoots();
  if (worktrees === null || worktrees.length === 0) {
    // Never "zero worktrees": an enumeration failure would silently drop every linked worktree from the protected set.
    return refuse(
      "result_path_invalid",
      `Refusing: the git worktrees of this repository could not be listed unambiguously (git failed, its output was not in the expected format, or a worktree is prunable), so the result file cannot be proven to lie outside them. ${WORKTREE_STATE_HINT}`,
    );
  }
  const roots = new Set<string>([repoCanonical, path.resolve(repoRoot)]);
  const protectedIds = new Set<string>();
  const repoId = io.statIdentity(repoCanonical);
  if (repoId === "absent" || repoId === "error") {
    return refuse("result_path_invalid", "Refusing: the filesystem identity of the repository root could not be established.");
  }
  protectedIds.add(repoId.id);
  let repoListed = false;
  for (const w of worktrees) {
    roots.add(path.resolve(w));
    const c = io.realpathDir(w);
    if (c !== null) roots.add(c);
    const id = io.statIdentity(w);
    // A listed worktree whose directory is gone is NOT "nothing to protect":
    // a worktree moved with `mv` is still listed at its old path, and its
    // checkout now lives somewhere the list does not say. Fail closed.
    if (id === "absent") {
      return refuse("result_path_invalid", `Refusing: a git worktree of this repository is listed at a path that no longer exists (moved or deleted). ${WORKTREE_STATE_HINT}`);
    }
    if (id === "error") {
      return refuse("result_path_invalid", "Refusing: the filesystem identity of a git worktree of this repository could not be established.");
    }
    if (id.id === repoId.id) repoListed = true;
    protectedIds.add(id.id);
  }
  if (!repoListed) {
    // git always lists the worktree it was asked about: a list without it describes another repository.
    return refuse("result_path_invalid", "Refusing: the git worktree list does not include this repository's own root, so it describes some other repository.");
  }
  const file = path.join(dir, path.basename(resultFile));
  const caseInsensitive = io.caseInsensitivePaths(dir) || io.caseInsensitivePaths(repoCanonical);
  const r = checkResultPath({ resolvedFile: file, resolvedDir: dir, protectedRoots: [...roots], caseInsensitive });
  if (r) return r;
  const byIdentity = checkAncestorIdentities(dir, protectedIds, io.statIdentity);
  if (!byIdentity.ok) return byIdentity;
  const inCheckout = checkNoGitAncestor(dir, io.lstatKind);
  if (inCheckout) return inCheckout;
  const kind = io.lstatKind(file);
  if (kind !== "absent") {
    return refuse(
      "result_path_invalid",
      kind === "symlink"
        ? "Refusing: a symbolic link already exists at the result file path."
        : kind === "error"
          ? "Refusing: the result file path could not be inspected."
          : "Refusing: something already exists at the result file path; the result file is never overwritten.",
    );
  }
  return { ok: true, file, dir, dirId: byIdentity.dirId, protectedIds };
}

// ---------------------------------------------------------------------------
// CLI

export async function runCli(opts: CliOptions): Promise<number> {
  const { io } = opts;

  // 1. Runtime: before reading any argument or file.
  const runtime = checkRuntimeEnvironment(opts.env);
  if (runtime) {
    io.stderr(`[${runtime.code}] ${runtime.message}`);
    return 2;
  }

  // 2. Strict argv.
  const parsed = parseSetSystemAdminClaimArgs(opts.argv);
  if (!parsed.ok) {
    io.stderr(`[${parsed.code}] ${parsed.message}`);
    return 2;
  }
  const args = parsed.args;

  // 3. Result file: validated and created before any credential is read.
  const requestId = generateRequestId(io.nowMs(), io.randomPart());
  let resultFile: string;
  if (args.resultFile !== null) {
    resultFile = path.resolve(args.resultFile);
  } else {
    const prepared = io.prepareDefaultResultDir();
    const dirRefusal = checkResultDirStat(prepared.stat, io.currentUid());
    if (dirRefusal) {
      io.stderr(`[${dirRefusal.code}] ${dirRefusal.message}`);
      return 2;
    }
    resultFile = path.join(prepared.dir, `system-admin-claim-${requestId}.json`);
  }
  const pathCheck = checkResultLocation(resultFile, opts.repoRoot, io);
  if (!pathCheck.ok) {
    io.stderr(`[${pathCheck.code}] ${pathCheck.message}`);
    return 2;
  }
  resultFile = pathCheck.file;
  let resultHandle: ResultFileHandle;
  try {
    resultHandle = io.createResultFile(pathCheck);
  } catch {
    io.stderr("[result_path_invalid] Refusing: could not create the result file exclusively (it may already exist, or its directory changed).");
    return 2;
  }

  const startedAt = new Date(io.nowMs()).toISOString();
  const git = io.git();
  let credentialSummary: { source: string; projectId: string; clientEmailMasked: string } | null = null;
  let run: RunResult | null = null;
  let early: Refusal | null = null;
  let firebase: FirebaseHandle | null = null;
  let unexpected: string | null = null;
  // Set BEFORE any Firebase write call is issued, so an unexpected throw can
  // be classified honestly: no write attempted => exit 2, otherwise exit 3.
  let writeAttempted = false;
  const markWrite = () => {
    writeAttempted = true;
  };

  try {
    // 4. Credential.
    const loaded = loadOperatorCredential(args, io);
    if (!loaded.ok) {
      early = loaded;
    } else {
      const { evidence } = loaded.credential;
      credentialSummary = { source: evidence.source, projectId: evidence.projectId, clientEmailMasked: evidence.clientEmailMasked };

      // 5. Firebase, from that credential only.
      firebase = opts.firebase({
        projectId: evidence.projectId,
        clientEmail: evidence.clientEmail,
        privateKey: loaded.credential.privateKey,
        appName: `system-admin-claim-${requestId}`,
      });
      // Local consistency assertion (see "PROJECT BINDING" above): not a network check.
      if (firebase.projectId !== args.confirmProject) {
        early = refuse("project_confirmation_mismatch", "Refusing: the initialised Firebase app's project does not equal --confirm-project.");
      } else {
        // 6. Execute (or dry run).
        run = await runSystemAdminClaim(
          { args, projectId: firebase.projectId, requestId, credential: evidence },
          {
            auth: trackAuthWrites(firebase.auth, markWrite),
            store: trackStoreWrites(firebase.store, markWrite),
            timestampNow: firebase.timestampNow,
            sleepMs: io.sleepMs,
            readOperatorToken: makeOperatorTokenReader(io),
            git,
            log: io.stdout,
          },
        );
      }
    }
  } catch (e) {
    // Only the error's name is recorded: messages from the SDK or the JSON
    // parser can carry request or file fragments.
    unexpected = e instanceof Error ? e.name : "unknown";
  } finally {
    if (firebase) await firebase.dispose().catch(() => undefined);
  }

  // An unexpected throw after a write attempt is exit 3 (never 0); before any write it is a plain refusal (2).
  const exitCode = unexpected !== null ? (writeAttempted ? 3 : 2) : run ? run.exitCode : 2;
  const report = {
    schema: "convergepanel.system-admin-claim-result/v1",
    phase: run && (run.status === "applied" || run.status === "claim_already_absent_sessions_revoked" || run.status === "incomplete")
      ? "executed"
      : run?.status === "dry_run" ? "dry-run" : "not-executed",
    status: unexpected !== null ? "unexpected_error" : run ? run.status : "refused",
    code: unexpected !== null ? `unexpected_error:${unexpected}` : run ? run.code : early?.code ?? null,
    message: unexpected !== null
      ? writeAttempted
        ? `INCOMPLETE: unexpected error after a Firebase write call was issued. The write may or may not have happened; read the target's claims. ${RERUN_IS_SAFE}`
        : "Unexpected error before any Firebase write. Nothing was written."
      : run ? run.message : early?.message ?? null,
    writeAttempted,
    exitCode,
    requestId,
    startedAt,
    finishedAt: new Date(io.nowMs()).toISOString(),
    confirmProject: args.confirmProject,
    credential: credentialSummary,
    git,
    run,
  };
  if (unexpected !== null) io.stderr(`[unexpected_error] ${report.message}`);
  else if (!run && early) io.stderr(`[${early.code}] ${early.message}`);
  else if (run && run.exitCode !== 0) io.stderr(`[${run.code}] ${run.message}`);

  try {
    resultHandle.write(`${JSON.stringify(report, null, 2)}\n`);
    resultHandle.close();
    io.stdout(`Result file: ${resultFile}`);
  } catch {
    try {
      resultHandle.close();
    } catch {
      // already closed or unusable
    }
    io.stderr(`RESULT FILE NOT WRITTEN (${resultFile}). Request ${requestId}.`);
    return exitCode === 0 ? 1 : exitCode;
  }
  return exitCode;
}

function trackAuthWrites(auth: ClaimAuthPort, mark: () => void): ClaimAuthPort {
  return {
    getUser: (uid) => auth.getUser(uid),
    verifyIdToken: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked),
    listUsers: (max, pageToken) => auth.listUsers(max, pageToken),
    writeCustomClaims: (uid, claims) => {
      mark();
      return auth.writeCustomClaims(uid, claims);
    },
    revokeRefreshTokens: (uid) => {
      mark();
      return auth.revokeRefreshTokens(uid);
    },
  };
}

function trackStoreWrites(store: ClaimStorePort, mark: () => void): ClaimStorePort {
  return {
    readUsersDocRole: (uid) => store.readUsersDocRole(uid),
    writeUsersDocRole: (uid, role) => {
      mark();
      return store.writeUsersDocRole(uid, role);
    },
    createAuditRow: (id, record) => {
      mark();
      return store.createAuditRow(id, record);
    },
  };
}

// ---------------------------------------------------------------------------
// Real implementations

export const realFirebaseFactory: FirebaseFactory = ({ projectId, clientEmail, privateKey, appName }) => {
  const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId }, appName);
  const auth = getAuth(app);
  const db = getFirestore(app);
  return {
    projectId: app.options.projectId ?? "",
    auth: {
      getUser: (uid) => auth.getUser(uid),
      verifyIdToken: (token, checkRevoked) => auth.verifyIdToken(token, checkRevoked),
      listUsers: (max, pageToken) => auth.listUsers(max, pageToken),
      writeCustomClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
      revokeRefreshTokens: (uid) => auth.revokeRefreshTokens(uid),
    },
    store: {
      readUsersDocRole: async (uid) => {
        const snap = await db.collection("users").doc(uid).get();
        const role = snap.exists ? snap.get("role") : null;
        return typeof role === "string" ? role : null;
      },
      // Both resolve with the SERVER commit time (WriteResult.writeTime). The
      // role write always changes the document (updatedAt is a server
      // timestamp), so its writeTime is this commit's time, never the
      // document's previous update time (which Firestore reports for a no-op).
      writeUsersDocRole: async (uid, role) => {
        const r = await db.collection("users").doc(uid).set({ role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { seconds: r.writeTime.seconds, nanoseconds: r.writeTime.nanoseconds };
      },
      createAuditRow: async (auditRowId, record) => {
        const r = await db.collection(AUDIT_COLLECTION).doc(auditRowId).create(record);
        return { seconds: r.writeTime.seconds, nanoseconds: r.writeTime.nanoseconds };
      },
    },
    timestampNow: () => Timestamp.now(),
    dispose: () => deleteApp(app),
  };
};

/** The fs surface realIo uses; injectable so tests can simulate races (e.g. lstat vs fstat disagreeing). */
export type FsLayer = Pick<
  typeof fs,
  | "lstatSync" | "statSync" | "openSync" | "fstatSync" | "readFileSync" | "closeSync" | "realpathSync"
  | "ftruncateSync" | "writeSync" | "fsyncSync" | "mkdirSync" | "unlinkSync" | "constants"
>;

export function realIo(repoRoot: string, fsx: FsLayer = fs): CliIo {
  const realpathNative = (p: string): string | null => {
    try {
      // .native: the OS realpath(3) — resolves symlinks AND restores on-disk
      // case on case-insensitive volumes; the JS realpathSync keeps input case.
      return fsx.realpathSync.native(p);
    } catch {
      return null;
    }
  };
  const identityOf = (st: { dev: bigint; ino: bigint }) => `${st.dev}:${st.ino}`;
  const classify = (e: unknown): "absent" | "error" => {
    const code = (e as { code?: unknown })?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  };
  const statIdentity = (p: string): IdentityResult => {
    try {
      return { id: identityOf(fsx.statSync(p, { bigint: true })) };
    } catch (e) {
      return classify(e);
    }
  };
  const statIdentityNoFollow = (p: string): IdentityResult => {
    try {
      return { id: identityOf(fsx.lstatSync(p, { bigint: true })) };
    } catch (e) {
      return classify(e);
    }
  };
  const lstatKind: CliIo["lstatKind"] = (p) => {
    try {
      const l = fsx.lstatSync(p);
      return l.isSymbolicLink() ? "symlink" : l.isFile() ? "file" : "other";
    } catch (e) {
      return (e as { code?: unknown })?.code === "ENOENT" ? "absent" : "error";
    }
  };
  /**
   * Throws unless the entry at `loc.file` is (by lstat, not followed) the
   * inode `ownId`, its parent still has the checked identity and canonical
   * path, and no ancestor of that directory is a protected root or contains
   * a `.git` entry. Run after the create AND again right before the write.
   */
  const verifyLanded = (loc: ResultLocation, ownId: string) => {
    const atPath = statIdentityNoFollow(loc.file);
    if (atPath === "absent" || atPath === "error" || atPath.id !== ownId) {
      throw new Error("the created file is not the entry at the result path");
    }
    const parent = statIdentity(path.dirname(loc.file));
    if (parent === "absent" || parent === "error" || parent.id !== loc.dirId) {
      throw new Error("the result file's directory is not the checked directory");
    }
    const canonical = realpathNative(path.dirname(loc.file));
    if (canonical === null || canonical !== loc.dir) {
      throw new Error("the result file's directory no longer canonicalises to the checked one");
    }
    if (!checkAncestorIdentities(canonical, loc.protectedIds, statIdentity).ok) {
      throw new Error("the result file's directory now lies inside a protected root");
    }
    if (checkNoGitAncestor(canonical, lstatKind) !== null) {
      throw new Error("the result file's directory now lies inside a git checkout");
    }
  };
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readSecretFile: (p) => {
      let l: fs.Stats;
      try {
        l = fsx.lstatSync(p);
      } catch {
        return null;
      }
      if (l.isSymbolicLink()) return { isSymlink: true, isFile: false, mode: l.mode, body: null };
      // A FIFO, socket or device is refused WITHOUT opening it: open() on a
      // FIFO blocks until a writer appears, and a device can be unbounded.
      if (!l.isFile()) return { isSymlink: false, isFile: false, mode: l.mode, body: null };
      let fd: number;
      try {
        // O_NOFOLLOW: a symlink swapped in after the lstat still fails here.
        // O_NONBLOCK: a FIFO swapped in after the lstat cannot block the open;
        // the fstat below then refuses it. No effect on a regular file.
        fd = fsx.openSync(p, fsx.constants.O_RDONLY | fsx.constants.O_NOFOLLOW | fsx.constants.O_NONBLOCK);
      } catch {
        return null;
      }
      try {
        const st = fsx.fstatSync(fd);
        // Only a regular file is read (a FIFO/device could block or be unbounded).
        const body = st.isFile() ? fsx.readFileSync(fd, "utf8") : null;
        return { isSymlink: false, isFile: st.isFile(), mode: st.mode, body };
      } finally {
        fsx.closeSync(fd);
      }
    },
    realpathDir: (p) => realpathNative(p),
    gitWorktreeRoots: () => {
      try {
        const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8", env: gitEnv(process.env) });
        return parseWorktreeListPorcelainZ(out);
      } catch {
        return null;
      }
    },
    caseInsensitivePaths: (canonicalDir) => {
      // APFS/HFS+ and NTFS default to case-insensitive: fold unconditionally there.
      if (process.platform === "darwin" || process.platform === "win32") return true;
      const swapped = canonicalDir.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
      if (swapped === canonicalDir) return false;
      try {
        const a = fsx.statSync(canonicalDir);
        const b = fsx.statSync(swapped);
        return a.dev === b.dev && a.ino === b.ino;
      } catch {
        return false;
      }
    },
    lstatKind,
    statIdentity: (p) => statIdentity(p),
    createResultFile: (loc) => {
      // O_CREAT|O_EXCL refuses an existing file or symlink; O_NOFOLLOW also
      // refuses a final-component symlink planted after the location check.
      // The fd is kept so the final write cannot be redirected by a path swap.
      const c = fsx.constants;
      const p = loc.file;
      const fd = fsx.openSync(p, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      let ownId: string | null = null;
      try {
        const st = fsx.fstatSync(fd, { bigint: true });
        if (!st.isFile()) throw new Error("result file is not a regular file");
        ownId = identityOf(st);
        // Re-verify AFTER the create, by identity: a parent directory swapped
        // (for a symlink, or for another directory) between the check and the
        // create would have put the file somewhere else.
        verifyLanded(loc, ownId);
      } catch (e) {
        try {
          fsx.closeSync(fd);
        } catch {
          // ignore
        }
        // Remove the file only when the entry at the path is, right now, the
        // very inode this fd created — never anyone else's file. A file whose
        // directory was moved away cannot be reached by path and is left
        // (empty, 0600) where it is.
        if (ownId !== null) {
          const now = statIdentityNoFollow(p);
          if (now !== "absent" && now !== "error" && now.id === ownId) {
            try {
              fsx.unlinkSync(p);
            } catch {
              // ignore
            }
          }
        }
        throw e;
      }
      const landedId = ownId;
      return {
        write: (contents) => {
          // The directory may have been moved (e.g. INTO a checkout) while the
          // run was in progress: re-check where the file is now and write
          // nothing if it is no longer where it was validated. The remaining
          // window is this check -> the writeSync below (documented residual).
          verifyLanded(loc, landedId);
          fsx.ftruncateSync(fd, 0);
          fsx.writeSync(fd, contents, 0, "utf8");
          fsx.fsyncSync(fd);
        },
        close: () => fsx.closeSync(fd),
      };
    },
    prepareDefaultResultDir: () => {
      const dir = path.join(os.tmpdir(), "convergepanel-operator");
      try {
        fsx.mkdirSync(dir, { mode: 0o700 });
      } catch {
        // already exists (or cannot be created) — inspected below either way
      }
      try {
        const l = fsx.lstatSync(dir);
        return { dir, stat: { isSymlink: l.isSymbolicLink(), isDirectory: l.isDirectory(), uid: l.uid, mode: l.mode } };
      } catch {
        return { dir, stat: null };
      }
    },
    currentUid: () => (typeof process.getuid === "function" ? process.getuid() : null),
    git: () => {
      try {
        const env = gitEnv(process.env);
        const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8", env }).trim();
        const status = execFileSync("git", ["-C", repoRoot, "status", "--porcelain", "--", "scripts/admin", "lib/admin"], { encoding: "utf8", env });
        return { sha, dirty: status.trim() !== "" };
      } catch {
        return { sha: null, dirty: null };
      }
    },
    nowMs: () => Date.now(),
    randomPart: () => randomBytes(6).toString("hex"),
    sleepMs: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, "..", "..");
  runCli({ argv: process.argv.slice(2), env: process.env, repoRoot, io: realIo(repoRoot), firebase: realFirebaseFactory })
    .then((code) => process.exit(code))
    .catch(() => {
      process.stderr.write("Unexpected failure. See the result file, if one was created.\n");
      process.exit(1);
    });
}
