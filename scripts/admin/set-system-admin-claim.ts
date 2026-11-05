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
 *     [--result-file=<absolute path outside the repo, *.json>]
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

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** null when the path does not exist or cannot be opened. */
  readSecretFile: (p: string) => SecretFileRead | null;
  realpathDir: (p: string) => string | null;
  /** Create the result file exclusively (O_CREAT|O_EXCL, mode 0600) before any Firebase call; keep the fd. */
  createResultFile: (p: string) => ResultFileHandle;
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
  const resultDir = io.realpathDir(path.dirname(resultFile));
  const repoRoot = io.realpathDir(opts.repoRoot) ?? opts.repoRoot;
  const pathRefusal = resultDir === null
    ? refuse("result_path_invalid", "Refusing: the result file's directory does not exist.")
    : checkResultPath({ resolvedFile: path.join(resultDir, path.basename(resultFile)), resolvedDir: resultDir, repoRoot });
  if (pathRefusal) {
    io.stderr(`[${pathRefusal.code}] ${pathRefusal.message}`);
    return 2;
  }
  let resultHandle: ResultFileHandle;
  try {
    resultHandle = io.createResultFile(resultFile);
  } catch {
    io.stderr("[result_path_invalid] Refusing: could not create the result file exclusively (it may already exist).");
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

export function realIo(repoRoot: string): CliIo {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    readSecretFile: (p) => {
      let l: fs.Stats;
      try {
        l = fs.lstatSync(p);
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
        fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch {
        return null;
      }
      try {
        const st = fs.fstatSync(fd);
        // Only a regular file is read (a FIFO/device could block or be unbounded).
        const body = st.isFile() ? fs.readFileSync(fd, "utf8") : null;
        return { isSymlink: false, isFile: st.isFile(), mode: st.mode, body };
      } finally {
        fs.closeSync(fd);
      }
    },
    realpathDir: (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    },
    createResultFile: (p) => {
      // O_CREAT|O_EXCL ("wx") refuses an existing file or symlink; the fd is
      // kept so the final write cannot be redirected by a path swap.
      const fd = fs.openSync(p, "wx", 0o600);
      return {
        write: (contents) => {
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, contents, 0, "utf8");
          fs.fsyncSync(fd);
        },
        close: () => fs.closeSync(fd),
      };
    },
    prepareDefaultResultDir: () => {
      const dir = path.join(os.tmpdir(), "convergepanel-operator");
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch {
        // already exists (or cannot be created) — inspected below either way
      }
      try {
        const l = fs.lstatSync(dir);
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
