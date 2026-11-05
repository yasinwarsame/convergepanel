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
 *     [--result-file=<path to a NEW *.json file outside every git worktree of this repo>]
 *
 * EXIT CODES: 0 completed and verified (or a grant already in place);
 * 2 refused or dry run — no Firebase write call was issued;
 * 3 a write call was issued (possibly only the attempt audit row) and the
 *   operation is incomplete or unverified — re-running the same command is safe;
 * 1 the result file could not be written after an otherwise-successful run.
 *
 * CREDENTIALS. Only the key file named by --credentials is used. This tool
 * never loads .env.local and never reads FIREBASE_* / GOOGLE_* credential
 * variables; it initialises its own named Firebase app from that file.
 * Custody of that key file is the real security boundary — anyone holding it
 * can bypass every check in this file (see lib/admin/systemAdminClaimSafety.ts).
 *
 * SEAM FOR PR #294. `loadOperatorCredential` below is the single place that
 * turns operator input into a credential. When the operator production grant
 * (scripts/lib/operatorProductionAccess.ts) merges, it replaces this function
 * (and becomes this file's first import); the executor, the audit schema and
 * the confirmation format are unchanged by that swap.
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
 * firmlinks such as /System/Volumes/Data/Users vs /Users, bind mounts) share
 * one identity even when no string canonicaliser agrees.
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
  /** Roots of every git worktree of the repository at repoRoot; null when git cannot list them (refused, never treated as "none"). */
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
   * `loc.dirId` and canonicalises to `loc.dir`, and no ancestor of the
   * re-canonicalised directory has a protected identity.
   */
  createResultFile: (loc: ResultLocation) => ResultFileHandle;
  /** Create (0700) or lstat the default result directory; returns its lstat for checkResultDirStat. */
  prepareDefaultResultDir: () => { dir: string; stat: DirStat | null };
  currentUid: () => number | null;
  git: () => { sha: string | null; dirty: boolean | null };
  nowMs: () => number;
  randomPart: () => string;
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
// Credential loading — the PR #294 seam

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

/**
 * Identity layer of the location check: walks `canonicalDir` and EVERY
 * ancestor up to the filesystem root and refuses if any of them has the
 * filesystem identity (dev:ino) of a protected root. Containment is decided by
 * the filesystem, not by spelling, so an alternate path to the same directory
 * (macOS firmlink /System/Volumes/Data/..., a bind mount, a case variant the
 * canonicaliser left alone) is still recognised as inside. Fails closed: an
 * ancestor whose identity cannot be established is a refusal.
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
 * Two layers, both must pass. (1) Strings: the parent directory and every
 * protected root are canonicalised through the filesystem (realpath.native,
 * never lexically) and compared case-folded on a case-insensitive volume.
 * (2) Identity: no ancestor-or-self of the canonical directory may have the
 * dev:ino of the repository root or of ANY git worktree root
 * (checkAncestorIdentities). A worktree list that cannot be obtained, or is
 * empty (git always lists the main worktree), is a refusal. The target must not
 * exist yet (no file, no symlink); the exclusive O_NOFOLLOW create and its
 * post-create re-check then close the remaining race.
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
    return refuse("result_path_invalid", "Refusing: the git worktrees of this repository could not be listed, so the result file cannot be proven to lie outside them.");
  }
  const roots = new Set<string>([repoCanonical, path.resolve(repoRoot)]);
  const protectedIds = new Set<string>();
  const repoId = io.statIdentity(repoCanonical);
  if (repoId === "absent" || repoId === "error") {
    return refuse("result_path_invalid", "Refusing: the filesystem identity of the repository root could not be established.");
  }
  protectedIds.add(repoId.id);
  for (const w of worktrees) {
    roots.add(path.resolve(w));
    const c = io.realpathDir(w);
    if (c !== null) roots.add(c);
    const id = io.statIdentity(w);
    // A listed worktree whose directory is gone (git reports it "prunable")
    // contains nothing; any other failure to identify it fails closed.
    if (id === "error") {
      return refuse("result_path_invalid", "Refusing: the filesystem identity of a git worktree of this repository could not be established.");
    }
    if (id !== "absent") protectedIds.add(id.id);
  }
  const file = path.join(dir, path.basename(resultFile));
  const caseInsensitive = io.caseInsensitivePaths(dir) || io.caseInsensitivePaths(repoCanonical);
  const r = checkResultPath({ resolvedFile: file, resolvedDir: dir, protectedRoots: [...roots], caseInsensitive });
  if (r) return r;
  const byIdentity = checkAncestorIdentities(dir, protectedIds, io.statIdentity);
  if (!byIdentity.ok) return byIdentity;
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
      writeUsersDocRole: async (uid, role) => {
        await db.collection("users").doc(uid).set({ role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      },
      createAuditRow: async (auditRowId, record) => {
        await db.collection(AUDIT_COLLECTION).doc(auditRowId).create(record);
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
        const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
        return out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
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
    lstatKind: (p) => {
      try {
        const l = fsx.lstatSync(p);
        return l.isSymbolicLink() ? "symlink" : l.isFile() ? "file" : "other";
      } catch (e) {
        return (e as { code?: unknown })?.code === "ENOENT" ? "absent" : "error";
      }
    },
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
        const atPath = statIdentityNoFollow(p);
        if (atPath === "absent" || atPath === "error" || atPath.id !== ownId) {
          throw new Error("the created file is not the entry at the result path");
        }
        const parent = statIdentity(path.dirname(p));
        if (parent === "absent" || parent === "error" || parent.id !== loc.dirId) {
          throw new Error("the result file's directory is not the checked directory");
        }
        const canonical = realpathNative(path.dirname(p));
        if (canonical === null || canonical !== loc.dir) {
          throw new Error("the result file's directory no longer canonicalises to the checked one");
        }
        if (!checkAncestorIdentities(canonical, loc.protectedIds, statIdentity).ok) {
          throw new Error("the result file's directory now lies inside a protected root");
        }
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
      return {
        write: (contents) => {
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
        const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const status = execFileSync("git", ["-C", repoRoot, "status", "--porcelain", "--", "scripts/admin", "lib/admin"], { encoding: "utf8" });
        return { sha, dirty: status.trim() !== "" };
      } catch {
        return { sha: null, dirty: null };
      }
    },
    nowMs: () => Date.now(),
    randomPart: () => randomBytes(6).toString("hex"),
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
