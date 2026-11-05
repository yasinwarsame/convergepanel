/**
 * Wiring tests for scripts/admin/set-system-admin-claim.ts: the real `runCli`
 * with an in-memory filesystem and a fake Firebase factory (no network, no
 * real project), plus static checks over the tracked scripts.
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkResultLocation,
  loadOperatorCredential,
  realIo,
  runCli,
  type CliIo,
  type FirebaseFactory,
  type FirebaseHandle,
  type FsLayer,
} from "../set-system-admin-claim";
import { REFUSAL_CODES, checkResultDirStat, expectedConfirmation, parseSetSystemAdminClaimArgs } from "../../../lib/admin/systemAdminClaimSafety";
import type { UserRecordLike } from "../../../lib/admin/systemAdminClaimSafety";

const readOnly = require("../../check-admin-claims.js");

// The underlying CommonJS fs object (the `import * as fs` binding is a getter
// wrapper that cannot be spied on); both the script and check-admin-claims.js
// resolve openSync through it at call time.
const rawFs: typeof fs = jest.requireActual("node:fs");

const REPO = path.resolve(__dirname, "..", "..", "..");
const PROJECT = "cp-rehearsal-1";
const TARGET = "TargetUid0000000000000000001";
const OPERATOR = "OperatorUid00000000000000001";
const FAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIAL-MUST-NEVER-APPEAR\n-----END PRIVATE KEY-----\n";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvcCJ9.SIGNATURE-MUST-NEVER-APPEAR";
const KEY = { type: "service_account", project_id: PROJECT, client_email: "firebase-adminsdk-x@cp-rehearsal-1.iam.gserviceaccount.com", private_key: FAKE_PRIVATE_KEY };

type Env = {
  files: Map<string, { mode: number; body: string; symlink?: boolean }>;
  out: string[];
  err: string[];
  results: Map<string, string>;
  created: string[];
  factoryCalls: number;
  writes: string[];
  users: Map<string, UserRecordLike>;
  role: string | null;
};

function makeEnv(): Env {
  return {
    files: new Map([
      ["/keys/sa.json", { mode: 0o100600, body: JSON.stringify(KEY) }],
      ["/keys/token", { mode: 0o100600, body: `${TOKEN}\n` }],
    ]),
    out: [],
    err: [],
    results: new Map(),
    created: [],
    factoryCalls: 0,
    writes: [],
    users: new Map<string, UserRecordLike>([
      [TARGET, { uid: TARGET, email: "t@example.com", disabled: false, customClaims: { admin: false, keep: 1 } }],
      [OPERATOR, { uid: OPERATOR, email: "op@example.com", disabled: false, customClaims: { admin: true } }],
    ]),
    role: "user",
  };
}

function fakeIo(e: Env, over: Partial<CliIo> = {}): CliIo {
  return {
    stdout: (l) => e.out.push(l),
    stderr: (l) => e.err.push(l),
    readSecretFile: (p) => {
      const f = e.files.get(p);
      if (!f) return null;
      if (f.symlink) return { isSymlink: true, isFile: false, mode: 0o120777, body: null };
      return { isSymlink: false, isFile: true, mode: f.mode, body: f.body };
    },
    realpathDir: (p) => (p.startsWith("/nonexistent") ? null : p),
    gitWorktreeRoots: () => [REPO],
    caseInsensitivePaths: () => false,
    lstatKind: (p) => (e.results.has(p) ? "file" : "absent"),
    createResultFile: (p) => {
      if (e.results.has(p)) throw new Error("EEXIST");
      e.created.push(p);
      e.results.set(p, "");
      return { write: (c) => { e.results.set(p, c); }, close: () => undefined };
    },
    prepareDefaultResultDir: () => ({ dir: "/tmp/convergepanel-operator", stat: { isSymlink: false, isDirectory: true, uid: 501, mode: 0o40700 } }),
    currentUid: () => 501,
    git: () => ({ sha: "deadbeef", dirty: false }),
    nowMs: () => Date.parse("2026-11-05T10:00:00Z"),
    randomPart: () => "abc123",
    ...over,
  };
}

function fakeFactory(e: Env, projectOverride?: string, throwOn?: string): FirebaseFactory {
  let tva = 0;
  return (input) => {
    e.factoryCalls++;
    expect(input.privateKey).toBe(FAKE_PRIVATE_KEY);
    const h: FirebaseHandle = {
      projectId: projectOverride ?? input.projectId,
      auth: {
        getUser: async (uid) => {
          const u = e.users.get(uid);
          if (!u) throw Object.assign(new Error("nf"), { code: "auth/user-not-found" });
          return JSON.parse(JSON.stringify(u));
        },
        verifyIdToken: async (t) => {
          if (t !== TOKEN) throw Object.assign(new Error("bad"), { code: "auth/argument-error" });
          return { uid: OPERATOR, admin: true };
        },
        listUsers: async () => ({ users: [...e.users.values()] }),
        writeCustomClaims: async (uid, claims) => {
          if (throwOn === "claims") throw new TypeError("boom");
          e.writes.push(`claims:${uid}`);
          e.users.get(uid)!.customClaims = claims;
        },
        revokeRefreshTokens: async (uid) => {
          if (throwOn === "revoke") throw new Error("revoke down");
          e.writes.push(`revoke:${uid}`);
          e.users.get(uid)!.tokensValidAfterTime = new Date(Date.parse("2026-11-05T10:00:00Z") + ++tva * 1000).toUTCString();
        },
      },
      store: {
        readUsersDocRole: async () => e.role,
        writeUsersDocRole: async (uid, role) => {
          e.writes.push(`role:${uid}`);
          e.role = role;
        },
        createAuditRow: async (id, rec) => {
          if (throwOn === "attempt" && id.endsWith(":attempt")) throw new Error("audit down");
          e.writes.push(`audit:${id}:${JSON.stringify(rec)}`);
        },
      },
      timestampNow: () => "TS",
      dispose: async () => undefined,
    };
    return h;
  };
}

const BASE = [`--confirm-project=${PROJECT}`, "--credentials=/keys/sa.json", `--target-uid=${TARGET}`, "--operation=grant"];
const CONFIRM = expectedConfirmation({ operation: "grant", projectId: PROJECT, targetUid: TARGET });
const RESULT = "/tmp/convergepanel-operator/system-admin-claim-req_1793872800000_abc123.json";

const safeParse = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return { unparsed: t };
  }
};

async function run(argv: string[], e = makeEnv(), opts: { env?: Record<string, string>; io?: Partial<CliIo>; project?: string; throwOn?: string } = {}) {
  const code = await runCli({
    argv,
    env: opts.env ?? { NODE_ENV: "development" },
    repoRoot: REPO,
    io: fakeIo(e, opts.io),
    firebase: fakeFactory(e, opts.project, opts.throwOn),
  });
  const result = e.results.get(RESULT);
  return { code, e, result: result ? safeParse(result) : null, all: JSON.stringify({ out: e.out, err: e.err, results: [...e.results.values()], writes: e.writes }) };
}

describe("runCli — refusals before any credential or Firebase use", () => {
  it.each([["VERCEL", "1"], ["VERCEL_ENV", "production"], ["NEXT_RUNTIME", "nodejs"], ["NODE_ENV", "production"]])(
    "%s=%s refuses runtime_unsafe before reading any file",
    async (k, v) => {
      const e = makeEnv();
      const statSpy = jest.fn(() => null);
      const { code } = await run(BASE, e, { env: { [k]: v }, io: { statFile: statSpy } });
      expect(code).toBe(2);
      expect(e.err.join("\n")).toContain("[runtime_unsafe]");
      expect(statSpy).not.toHaveBeenCalled();
      expect(e.factoryCalls).toBe(0);
      expect(e.created).toEqual([]);
    },
  );
  it("argv refusal: no file created, factory never called", async () => {
    const { code, e } = await run([...BASE, TARGET]);
    expect(code).toBe(2);
    expect(e.err.join()).toContain("[positional_arg]");
    expect([e.factoryCalls, e.created.length]).toEqual([0, 0]);
  });
  it("result path inside the repo is refused before credentials are read", async () => {
    const { code, e } = await run([...BASE, `--result-file=${path.join(REPO, "out.json")}`]);
    expect(code).toBe(2);
    expect(e.err.join()).toContain("[result_path_inside_repo]");
    expect([e.factoryCalls, e.created.length]).toEqual([0, 0]);
  });
  it("result directory that does not exist is refused", async () => {
    const { code, e } = await run([...BASE, "--result-file=/nonexistent/dir/r.json"]);
    expect(code).toBe(2);
    expect(e.err.join()).toContain("[result_path_invalid]");
  });
  it("an existing result file is never overwritten (exclusive create)", async () => {
    const e = makeEnv();
    e.results.set(RESULT, "PREVIOUS");
    const { code } = await run(BASE, e);
    expect(code).toBe(2);
    expect(e.results.get(RESULT)).toBe("PREVIOUS");
    expect(e.factoryCalls).toBe(0);
  });

  it.each<[string, (e: Env) => void]>([
    ["credentials_file_unreadable", (e) => e.files.delete("/keys/sa.json")],
    ["credentials_file_unsafe", (e) => { e.files.get("/keys/sa.json")!.mode = 0o100644; }],
    ["credentials_invalid", (e) => { e.files.get("/keys/sa.json")!.body = `{"private_key": "${FAKE_PRIVATE_KEY.replace(/\n/g, "\\n")}", oops`; }],
    // A parser error message quotes the first bytes of the input; a key file
    // that is not JSON must not have its contents echoed through that message.
    ["credentials_invalid", (e) => { e.files.get("/keys/sa.json")!.body = "FAKEKEYMATERIAL-MUST-NEVER-APPEAR not json"; }],
    ["credentials_invalid", (e) => { e.files.get("/keys/sa.json")!.body = JSON.stringify({ ...KEY, type: "authorized_user" }); }],
    ["project_confirmation_mismatch", (e) => { e.files.get("/keys/sa.json")!.body = JSON.stringify({ ...KEY, project_id: "convergepanel" }); }],
  ])("%s: refused, factory never called, result file records the code, no key material anywhere", async (code, mutate) => {
    const e = makeEnv();
    mutate(e);
    const r = await run(BASE, e);
    expect(r.code).toBe(2);
    expect(e.factoryCalls).toBe(0);
    expect(r.result).toMatchObject({ status: "refused", code, exitCode: 2 });
    // "FAKEKEYMAT" is the 10-character prefix a JSON.parse message would quote.
    expect(r.all).not.toContain("FAKEKEYMAT");
  });

  it("CONTROL: the unmutated environment reaches Firebase (dry run => exit 2)", async () => {
    const r = await run(BASE);
    expect(r.code).toBe(2);
    expect(r.result).toMatchObject({ status: "dry_run", writeAttempted: false });
    expect(r.e.factoryCalls).toBe(1);
  });

  it("the initialised app's project must equal --confirm-project", async () => {
    const r = await run(BASE, makeEnv(), { project: "convergepanel" });
    expect(r.code).toBe(2);
    expect(r.result).toMatchObject({ code: "project_confirmation_mismatch" });
    expect(r.e.writes).toEqual([]);
  });

  it("operator token file with group/other permission bits is refused", async () => {
    const e = makeEnv();
    e.files.get("/keys/token")!.mode = 0o100644;
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], e);
    expect(r.code).toBe(2);
    expect(r.result.run).toMatchObject({ code: "operator_token_file_unsafe" });
    expect(e.writes).toEqual([]);
  });
});

describe("runCli — symlinked secrets and the default result directory", () => {
  it("a symlinked --credentials file is refused with credentials_file_symlink", async () => {
    const e = makeEnv();
    e.files.get("/keys/sa.json")!.symlink = true;
    const r = await run(BASE, e);
    expect(r.code).toBe(2);
    expect(r.result).toMatchObject({ code: "credentials_file_symlink" });
    expect(e.factoryCalls).toBe(0);
  });
  it("a symlinked operator token file is refused", async () => {
    const e = makeEnv();
    e.files.get("/keys/token")!.symlink = true;
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], e);
    expect(r.result.run).toMatchObject({ code: "operator_token_file_unsafe" });
    expect(e.writes).toEqual([]);
  });
  it.each<[string, { isSymlink: boolean; isDirectory: boolean; uid: number; mode: number } | null, number | null]>([
    ["symlink", { isSymlink: true, isDirectory: false, uid: 501, mode: 0o120777 }, 501],
    ["not a directory", { isSymlink: false, isDirectory: false, uid: 501, mode: 0o100700 }, 501],
    ["owned by another uid", { isSymlink: false, isDirectory: true, uid: 0, mode: 0o40700 }, 501],
    ["mode 0755", { isSymlink: false, isDirectory: true, uid: 501, mode: 0o40755 }, 501],
    ["mode 0711", { isSymlink: false, isDirectory: true, uid: 501, mode: 0o40711 }, 501],
    ["uninspectable", null, 501],
    ["no current uid", { isSymlink: false, isDirectory: true, uid: 501, mode: 0o40700 }, null],
  ])("default result dir %s => result_dir_unsafe, nothing created, factory never called", async (_l, stat, uid) => {
    const e = makeEnv();
    const r = await run(BASE, e, { io: { prepareDefaultResultDir: () => ({ dir: "/tmp/convergepanel-operator", stat }), currentUid: () => uid } });
    expect(r.code).toBe(2);
    expect(e.err.join()).toContain("[result_dir_unsafe]");
    expect([e.created.length, e.factoryCalls]).toEqual([0, 0]);
  });
});

describe("runCli — dry run and execute end to end (fake Firebase)", () => {
  it("dry run: exit 2, ZERO Firebase writes, result file phase dry-run with the confirmation string", async () => {
    const r = await run([...BASE, "--operator-id-token-file=/keys/token"]);
    expect(r.code).toBe(2);
    expect(r.e.writes).toEqual([]);
    expect(r.result).toMatchObject({ phase: "dry-run", status: "dry_run", exitCode: 2, writeAttempted: false, confirmProject: PROJECT });
    expect(r.result.run.expectedConfirmation).toBe(CONFIRM);
    expect(r.result.credential).toEqual({ source: "explicit-key-file", projectId: PROJECT, clientEmailMasked: "fire…@…" });
    expect(r.e.out).toContain(`Result file: ${RESULT}`);
  });

  it("execute: applies, two audit rows, claims preserved, and NO key or token anywhere in output/result/audit", async () => {
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`]);
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ phase: "executed", status: "applied" });
    expect(r.e.users.get(TARGET)!.customClaims).toEqual({ admin: true, keep: 1 });
    expect(r.e.writes.filter((w) => w.startsWith("audit:")).map((w) => w.split(":").slice(0, 4).join(":"))).toEqual([
      "audit:system-admin-claim:req_1793872800000_abc123:attempt",
      "audit:system-admin-claim:req_1793872800000_abc123:outcome",
    ]);
    expect(r.all).not.toContain("FAKEKEYMATERIAL");
    expect(r.all).not.toContain("PRIVATE KEY");
    expect(r.all).not.toContain("SIGNATURE-MUST-NEVER-APPEAR");
    expect(r.all).not.toContain("private_key");
  });

  it("an unexpected throw BEFORE any Firebase write is exit 2 and says nothing was written", async () => {
    const e = makeEnv();
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], e, {
      io: { stdout: (l) => { if (l.startsWith("Authorization")) throw new RangeError("secret-ish message"); e.out.push(l); } },
    });
    expect(r.code).toBe(2);
    expect(e.writes).toEqual([]);
    expect(r.result).toMatchObject({ status: "unexpected_error", code: "unexpected_error:RangeError", writeAttempted: false });
    expect(r.result.message).toMatch(/before any Firebase write/);
    expect(r.all).not.toContain("secret-ish message");
  });

  it("an unexpected throw AFTER a write was attempted is exit 3 (never 0 or 2)", async () => {
    const e = makeEnv();
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], e, {
      io: { stdout: (l) => { if (l.startsWith("Applied")) throw new RangeError("late"); e.out.push(l); } },
    });
    expect(e.writes.some((w) => w.startsWith("claims:"))).toBe(true);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ status: "unexpected_error", writeAttempted: true });
    expect(r.result.message).toMatch(/Re-running the same command is safe/);
  });

  it("attempt audit row create throwing => exit 3 (outcome unknown), writeAttempted true, never 2", async () => {
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], makeEnv(), { throwOn: "attempt" });
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ phase: "executed", status: "incomplete", code: "audit_attempt_failed", exitCode: 3, writeAttempted: true });
    expect(r.e.writes).toEqual([]);
    expect(r.e.err.join("\n")).toMatch(/Re-running the same command is safe/);
  });

  describe("revoke (sessions always revoked)", () => {
    const REVOKE_CONFIRM = expectedConfirmation({ operation: "revoke", projectId: PROJECT, targetUid: TARGET });
    const REVOKE = [
      `--confirm-project=${PROJECT}`, "--credentials=/keys/sa.json", `--target-uid=${TARGET}`, "--operation=revoke", "--allow-claim-reduction",
      "--operator-id-token-file=/keys/token",
    ];
    const adminTarget = () => {
      const e = makeEnv();
      e.users.get(TARGET)!.customClaims = { admin: true, keep: 1 };
      e.users.get(TARGET)!.tokensValidAfterTime = "Thu, 05 Nov 2026 09:00:00 GMT";
      e.users.set("OtherAdmin", { uid: "OtherAdmin", disabled: false, customClaims: { admin: true } });
      e.role = "admin";
      return e;
    };
    it("the retired --revoke-sessions flag is refused before any file or Firebase use", async () => {
      const e = adminTarget();
      const r = await run([...REVOKE, "--revoke-sessions=no"], e);
      expect(r.code).toBe(2);
      expect(e.err.join()).toContain("[unknown_flag]");
      expect([e.factoryCalls, e.created.length]).toEqual([0, 0]);
    });
    it("execute: claim removed, others kept, refresh tokens revoked, exit 0", async () => {
      const e = adminTarget();
      const r = await run([...REVOKE, "--execute", `--confirm-claim=${REVOKE_CONFIRM}`], e);
      expect(r.code).toBe(0);
      expect(r.result).toMatchObject({ status: "applied", exitCode: 0, run: { sessionRevocation: "required", outcome: "applied" } });
      expect(e.users.get(TARGET)!.customClaims).toEqual({ keep: 1 });
      expect(e.writes).toContain(`revoke:${TARGET}`);
    });
    it("sessions failure => exit 3 INCOMPLETE; the SAME command re-run completes sessions without a claim write, exit 0", async () => {
      const e = adminTarget();
      const argv = [...REVOKE, "--execute", `--confirm-claim=${REVOKE_CONFIRM}`];
      const r1 = await runCli({ argv, env: { NODE_ENV: "development" }, repoRoot: REPO, io: fakeIo(e), firebase: fakeFactory(e, undefined, "revoke") });
      expect(r1).toBe(3);
      expect(JSON.parse(e.results.get(RESULT)!)).toMatchObject({ status: "incomplete", code: "sessions_revoke_failed", writeAttempted: true });
      const claimWritesBefore = e.writes.filter((w) => w.startsWith("claims:")).length;
      const r2 = await runCli({
        argv, env: { NODE_ENV: "development" }, repoRoot: REPO,
        io: fakeIo(e, { randomPart: () => "retry1" }), firebase: fakeFactory(e),
      });
      expect(r2).toBe(0);
      const res2 = JSON.parse(e.results.get(RESULT.replace("abc123", "retry1"))!);
      expect(res2).toMatchObject({ phase: "executed", status: "claim_already_absent_sessions_revoked", exitCode: 0, run: { claimWrite: "skip_already_absent" } });
      expect(e.writes.filter((w) => w.startsWith("claims:")).length).toBe(claimWritesBefore);
      expect(e.writes).toContain(`revoke:${TARGET}`);
      expect(e.users.get(TARGET)!.customClaims).toEqual({ keep: 1 });
    });
  });
});

describe("realIo — files on disk (temp dirs only)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sac-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("result file: exclusive 0600 create, written through the kept fd (a path swap after create is not followed)", () => {
    const io = realIo(REPO);
    const p = path.join(dir, "r.json");
    const h = io.createResultFile(p, fs.realpathSync.native(dir));
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(() => io.createResultFile(p, fs.realpathSync.native(dir))).toThrow();
    // Swap the path for a decoy after the create; the fd still points at the original inode.
    const moved = path.join(dir, "moved.json");
    fs.renameSync(p, moved);
    fs.writeFileSync(p, "DECOY");
    h.write("{\"a\":1}\n");
    h.close();
    expect(fs.readFileSync(moved, "utf8")).toBe("{\"a\":1}\n");
    expect(fs.readFileSync(p, "utf8")).toBe("DECOY");
  });

  it("result file: an existing symlink at the path is refused by the exclusive create", () => {
    const target = path.join(dir, "target.json");
    fs.writeFileSync(target, "ORIGINAL");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(target, link);
    expect(() => realIo(REPO).createResultFile(link, fs.realpathSync.native(dir))).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL");
  });

  it("secret reads: regular file is read through one fd; a symlink is reported, not followed", () => {
    const io = realIo(REPO);
    const real = path.join(dir, "k.json");
    fs.writeFileSync(real, "BODY", { mode: 0o600 });
    expect(io.readSecretFile(real)).toEqual({ isSymlink: false, isFile: true, mode: fs.statSync(real).mode, body: "BODY" });
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link);
    expect(io.readSecretFile(link)).toMatchObject({ isSymlink: true, body: null });
    expect(io.readSecretFile(path.join(dir, "missing"))).toBeNull();
    expect(io.readSecretFile(dir)).toMatchObject({ isSymlink: false, isFile: false, body: null });
  });

  it("secret reads: a FIFO is refused WITHOUT being opened (open() on a FIFO would block)", () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const openSpy = jest.spyOn(rawFs, "openSync");
    try {
      expect(realIo(REPO).readSecretFile(fifo)).toMatchObject({ isSymlink: false, isFile: false, body: null });
      expect(openSpy.mock.calls.filter(([p]) => p === fifo)).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("secret reads: the single open uses O_NOFOLLOW | O_NONBLOCK (a FIFO swapped in after lstat cannot block)", () => {
    const real = path.join(dir, "k.json");
    fs.writeFileSync(real, "BODY", { mode: 0o600 });
    const openSpy = jest.spyOn(rawFs, "openSync");
    try {
      realIo(REPO).readSecretFile(real);
      const flags = openSpy.mock.calls.filter(([p]) => p === real).map(([, f]) => f as number);
      expect(flags).toHaveLength(1);
      expect(flags[0] & fs.constants.O_NONBLOCK).toBe(fs.constants.O_NONBLOCK);
      expect(flags[0] & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("the default result directory is outside the repo, owned by us, mode 0700, and passes checkResultDirStat", () => {
    const io = realIo(REPO);
    const { dir: d, stat } = io.prepareDefaultResultDir();
    expect(path.relative(REPO, d).startsWith("..")).toBe(true);
    expect(checkResultDirStat(stat, io.currentUid())).toBeNull();
  });
});

describe("M-2: result-file location is filesystem-grounded (real temp dirs; never the real repo)", () => {
  // A stand-in "repository" with mixed case under os.tmpdir(): nothing here
  // can ever create a file inside the real worktree, even under a mutant.
  let base: string;
  let repo: string;
  let outside: string;
  let otherWt: string;
  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sac-m2-")));
    repo = path.join(base, "RepoRoot");
    outside = path.join(base, "Outside");
    otherWt = path.join(base, "OtherWorktree");
    for (const d of [repo, outside, otherWt]) fs.mkdirSync(d);
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const IS_CI_VOLUME = process.platform === "darwin" || process.platform === "win32";
  const swapCase = (p: string) => p.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

  async function runReal(resultFile: string, over: Partial<CliIo> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let factoryCalls = 0;
    const io: CliIo = {
      ...realIo(repo),
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      gitWorktreeRoots: () => [repo, otherWt],
      git: () => ({ sha: null, dirty: null }),
      nowMs: () => Date.parse("2026-11-05T10:00:00Z"),
      randomPart: () => "m2",
      ...over,
    };
    const code = await runCli({
      argv: [...BASE, `--result-file=${resultFile}`],
      env: { NODE_ENV: "development" },
      repoRoot: repo,
      io,
      firebase: () => {
        factoryCalls++;
        throw new Error("never reached: /keys/sa.json does not exist on disk");
      },
    });
    return { code, out, err: err.join("\n"), factoryCalls };
  }
  const repoIsEmpty = () => expect(fs.readdirSync(repo)).toEqual([]);

  it("CONTROL: a legitimate path outside the repo is accepted: created 0600 and written (the run then refuses the missing key)", async () => {
    const target = path.join(outside, "ok.json");
    const r = await runReal(target);
    expect(r.code).toBe(2);
    expect(r.err).toContain("[credentials_file_unreadable]");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toMatchObject({ status: "refused", code: "credentials_file_unreadable" });
    expect(r.out).toContain(`Result file: ${target}`);
    repoIsEmpty();
  });

  it("CONTROL: on a case-insensitive volume a case variant of an OUTSIDE path is accepted and reported in on-disk case", async () => {
    if (!IS_CI_VOLUME) return;
    const r = await runReal(path.join(swapCase(outside), "ok2.json"));
    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(outside, "ok2.json"))).toBe(true);
    expect(r.out).toContain(`Result file: ${path.join(outside, "ok2.json")}`);
  });

  it.each<[string, (b: { repo: string; outside: string; base: string }) => string]>([
    ["lowercase variant", ({ repo: rp }) => path.join(rp.toLowerCase(), "out.json")],
    ["uppercase variant", ({ repo: rp }) => path.join(rp.toUpperCase(), "out.json")],
    ["swapped-case variant", ({ repo: rp }) => path.join(swapCase(rp), "out.json")],
  ])("%s of the repo path is refused (never written inside the repo)", async (_l, make) => {
    const r = await runReal(make({ repo, outside, base }));
    expect(r.code).toBe(2);
    // On a case-sensitive volume the variant directory does not exist at all.
    expect(r.err).toContain(IS_CI_VOLUME ? "[result_path_inside_repo]" : "[result_path_invalid]");
    expect(r.factoryCalls).toBe(0);
    repoIsEmpty();
  });

  it.each<[string, (b: { repo: string; outside: string; base: string }) => string]>([
    ["plain path inside", ({ repo: rp }) => path.join(rp, "out.json")],
    [".. traversal from outside", ({ outside: o }) => `${o}/../RepoRoot/out.json`],
    ["duplicate separators", ({ repo: rp }) => `${rp}//sub/..//out.json`],
    ["trailing slash", ({ repo: rp }) => `${rp}/out.json/`],
    ["dot segments", ({ repo: rp }) => `${rp}/./out.json`],
  ])("%s => result_path_inside_repo", async (_l, make) => {
    const r = await runReal(make({ repo, outside, base }));
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_inside_repo]");
    repoIsEmpty();
  });

  it("a symlinked directory OUTSIDE that points INTO the repo is refused (canonical, not lexical)", async () => {
    const link = path.join(outside, "link-to-repo");
    fs.symlinkSync(repo, link);
    const r = await runReal(path.join(link, "out.json"));
    expect(r.err).toContain("[result_path_inside_repo]");
    repoIsEmpty();
  });

  it("a path inside ANOTHER git worktree of the repo is refused", async () => {
    const r = await runReal(path.join(otherWt, "out.json"));
    expect(r.err).toContain("[result_path_inside_repo]");
    expect(fs.readdirSync(otherWt)).toEqual([]);
  });

  it("the repo reached through a symlinked parent: protected roots are canonicalised too", async () => {
    const repoLink = path.join(outside, "repo-alias");
    fs.symlinkSync(repo, repoLink);
    const out: string[] = [];
    const err: string[] = [];
    const io = { ...realIo(repoLink), stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), gitWorktreeRoots: () => null };
    const code = await runCli({ argv: [...BASE, `--result-file=${path.join(repo, "out.json")}`], env: { NODE_ENV: "development" }, repoRoot: repoLink, io, firebase: () => { throw new Error("x"); } });
    expect(code).toBe(2);
    expect(err.join()).toContain("[result_path_inside_repo]");
    repoIsEmpty();
  });

  it("a repo root that cannot be canonicalised fails closed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const missing = path.join(base, "no-such-repo");
    const io = { ...realIo(missing), stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), gitWorktreeRoots: () => null };
    const code = await runCli({ argv: [...BASE, `--result-file=${path.join(outside, "x.json")}`], env: { NODE_ENV: "development" }, repoRoot: missing, io, firebase: () => { throw new Error("x"); } });
    expect(code).toBe(2);
    expect(err.join()).toContain("[result_path_invalid]");
    expect(fs.existsSync(path.join(outside, "x.json"))).toBe(false);
  });

  it("a nonexistent parent directory is refused (nothing created)", async () => {
    const r = await runReal(path.join(outside, "missing", "out.json"));
    expect(r.err).toContain("[result_path_invalid]");
    expect(fs.existsSync(path.join(outside, "missing"))).toBe(false);
  });

  it("an existing regular file at the target is refused and left untouched", async () => {
    const target = path.join(outside, "exists.json");
    fs.writeFileSync(target, "PREVIOUS");
    const r = await runReal(target);
    expect(r.err).toContain("[result_path_invalid]");
    expect(r.err).toMatch(/already exists/);
    expect(fs.readFileSync(target, "utf8")).toBe("PREVIOUS");
  });

  it("a symlink at the target (live or dangling) is refused; its referent is untouched / never created", async () => {
    const real = path.join(outside, "real.json");
    fs.writeFileSync(real, "ORIGINAL");
    fs.symlinkSync(real, path.join(outside, "live.json"));
    const intoRepo = path.join(repo, "planted.json");
    fs.symlinkSync(intoRepo, path.join(outside, "dangling.json"));
    for (const name of ["live.json", "dangling.json"]) {
      const r = await runReal(path.join(outside, name));
      expect(r.err).toContain("[result_path_invalid]");
      expect(r.err).toMatch(/symbolic link/);
    }
    expect(fs.readFileSync(real, "utf8")).toBe("ORIGINAL");
    repoIsEmpty();
  });

  it("a symlink planted AFTER the location check is not followed by the create (O_NOFOLLOW|O_EXCL)", async () => {
    const intoRepo = path.join(repo, "planted.json");
    const target = path.join(outside, "race.json");
    const r = await runReal(target, {
      lstatKind: (p) => {
        const k = realIo(repo).lstatKind(p);
        if (p === target) fs.symlinkSync(intoRepo, target); // race: plant right after the check
        return k;
      },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("[result_path_invalid]");
    expect(fs.existsSync(intoRepo)).toBe(false);
    repoIsEmpty();
  });

  it("realIo.realpathDir is realpath.NATIVE: a case variant comes back in on-disk case", () => {
    if (!IS_CI_VOLUME) return;
    expect(realIo(repo).realpathDir(repo.toLowerCase())).toBe(repo);
    expect(realIo(repo).realpathDir(repo.toUpperCase())).toBe(repo);
  });

  it("realIo.caseInsensitivePaths folds on darwin/win32", () => {
    if (!IS_CI_VOLUME) return;
    expect(realIo(repo).caseInsensitivePaths(repo)).toBe(true);
  });

  it("realIo.caseInsensitivePaths off darwin/win32: a filesystem probe (same inode under swapped case) decides", () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const same = { ...rawFs, statSync: (() => ({ dev: 1, ino: 7 })) as unknown as FsLayer["statSync"] } as FsLayer;
      let n = 0;
      const different = { ...rawFs, statSync: (() => ({ dev: 1, ino: ++n })) as unknown as FsLayer["statSync"] } as FsLayer;
      const missing = { ...rawFs, statSync: (() => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }) as unknown as FsLayer["statSync"] } as FsLayer;
      expect(realIo(repo, same).caseInsensitivePaths("/Some/Dir")).toBe(true);
      expect(realIo(repo, different).caseInsensitivePaths("/Some/Dir")).toBe(false);
      expect(realIo(repo, missing).caseInsensitivePaths("/Some/Dir")).toBe(false);
      expect(realIo(repo, same).caseInsensitivePaths("/1/2")).toBe(false); // no letters: nothing to fold
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
    }
  });

  it("checkResultLocation folds case when the volume is case-insensitive even if canonicalisation kept the input case", () => {
    const io = {
      realpathDir: (p: string) => p, // a canonicaliser that does NOT restore case
      gitWorktreeRoots: () => [],
      caseInsensitivePaths: () => true,
      lstatKind: () => "absent" as const,
    };
    expect(checkResultLocation("/users/op/apps/cp/out.json", "/Users/op/Apps/CP", io)).toMatchObject({ ok: false, code: "result_path_inside_repo" });
    expect(checkResultLocation("/Users/op/Apps/CP-other/out.json", "/Users/op/Apps/CP", io)).toMatchObject({ ok: true });
  });

  it("realIo.lstatKind: absent / file / symlink / other", () => {
    const io = realIo(repo);
    const f = path.join(outside, "f.json");
    fs.writeFileSync(f, "x");
    fs.symlinkSync(f, path.join(outside, "l.json"));
    expect([io.lstatKind(path.join(outside, "none.json")), io.lstatKind(f), io.lstatKind(path.join(outside, "l.json")), io.lstatKind(outside)])
      .toEqual(["absent", "file", "symlink", "other"]);
  });

  it("createResultFile opens with O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600", () => {
    const p = path.join(outside, "flags.json");
    const openSpy = jest.spyOn(rawFs, "openSync");
    try {
      realIo(repo).createResultFile(p, outside).close();
      const calls = openSpy.mock.calls.filter(([q]) => q === p);
      expect(calls).toHaveLength(1);
      const [, flags, mode] = calls[0] as [string, number, number];
      const c = fs.constants;
      expect(typeof flags).toBe("number");
      expect(flags & (c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW)).toBe(c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW);
      expect(mode).toBe(0o600);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("createResultFile refuses a dangling symlink at the path (never creates its referent)", () => {
    const referent = path.join(repo, "via-link.json");
    const link = path.join(outside, "dl.json");
    fs.symlinkSync(referent, link);
    expect(() => realIo(repo).createResultFile(link, outside)).toThrow();
    expect(fs.existsSync(referent)).toBe(false);
  });

  it("createResultFile: a parent directory that no longer canonicalises to the checked one => throws and removes its own empty file", () => {
    const p = path.join(outside, "moved.json");
    expect(() => realIo(repo).createResultFile(p, path.join(base, "SomewhereElse"))).toThrow();
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe("M-3: exit code 1 and the post-open fstat gate", () => {
  it("result-file write failure after an otherwise exit-0 run => exit 1 (never 0)", async () => {
    const e = makeEnv();
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], e, {
      io: { createResultFile: () => ({ write: () => { throw new Error("ENOSPC"); }, close: () => undefined }) },
    });
    expect(e.users.get(TARGET)!.customClaims).toEqual({ admin: true, keep: 1 }); // the run itself completed
    expect(r.code).toBe(1);
    expect(e.err.join("\n")).toContain("RESULT FILE NOT WRITTEN");
  });
  it("result-file write failure keeps a non-zero run's own code (3 stays 3, 2 stays 2)", async () => {
    const failing = { createResultFile: () => ({ write: () => { throw new Error("EIO"); }, close: () => undefined }) };
    const r3 = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`], makeEnv(), { io: failing, throwOn: "attempt" });
    expect(r3.code).toBe(3);
    const r2 = await run(BASE, makeEnv(), { io: failing });
    expect(r2.code).toBe(2);
  });
  it("CONTROL: the same run with a working result file exits 0", async () => {
    const r = await run([...BASE, "--operator-id-token-file=/keys/token", "--execute", `--confirm-claim=${CONFIRM}`]);
    expect(r.code).toBe(0);
  });

  // lstat says "regular file", but by the time it is opened the path is a FIFO/device (a swap).
  const swappedFs = (fstatIsFile: boolean) => {
    const readFileSync = jest.fn(() => JSON.stringify(KEY));
    const closeSync = jest.fn();
    const layer = {
      ...rawFs,
      constants: rawFs.constants,
      lstatSync: (() => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o100600 })) as unknown as FsLayer["lstatSync"],
      openSync: (() => 4242) as unknown as FsLayer["openSync"],
      fstatSync: (() => ({ isFile: () => fstatIsFile, mode: fstatIsFile ? 0o100600 : 0o010600 })) as unknown as FsLayer["fstatSync"],
      readFileSync: readFileSync as unknown as FsLayer["readFileSync"],
      closeSync: closeSync as unknown as FsLayer["closeSync"],
    } as FsLayer;
    return { layer, readFileSync, closeSync };
  };
  it("secret read: lstat=regular but fstat=FIFO => NOT read, isFile false, fd closed", () => {
    const { layer, readFileSync, closeSync } = swappedFs(false);
    expect(realIo(REPO, layer).readSecretFile("/keys/sa.json")).toEqual({ isSymlink: false, isFile: false, mode: 0o010600, body: null });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledWith(4242);
  });
  it("loadOperatorCredential over that swapped file refuses credentials_file_unsafe", () => {
    const { layer } = swappedFs(false);
    const parsed = parseSetSystemAdminClaimArgs(BASE);
    if (!parsed.ok) throw new Error("fixture");
    expect(loadOperatorCredential(parsed.args, realIo(REPO, layer))).toMatchObject({ ok: false, code: "credentials_file_unsafe" });
  });
  it("CONTROL: lstat=regular and fstat=regular => read through the fd", () => {
    const { layer, readFileSync } = swappedFs(true);
    expect(realIo(REPO, layer).readSecretFile("/keys/sa.json")).toMatchObject({ isFile: true, body: JSON.stringify(KEY) });
    expect(readFileSync).toHaveBeenCalledWith(4242, "utf8");
  });
});

describe("read-only loadKey (real temp files)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sac-ro-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("CONTROL: a 0600 regular key file loads", () => {
    const k = path.join(dir, "k.json");
    fs.writeFileSync(k, JSON.stringify(KEY), { mode: 0o600 });
    expect(readOnly.loadKey(k, PROJECT)).toMatchObject({ ok: true });
  });
  it("refuses a symlinked key file with credentials_file_symlink, and a 0644 file with credentials_file_unsafe", () => {
    const k = path.join(dir, "k.json");
    fs.writeFileSync(k, JSON.stringify(KEY), { mode: 0o600 });
    const link = path.join(dir, "link.json");
    fs.symlinkSync(k, link);
    expect(readOnly.loadKey(link, PROJECT)).toMatchObject({ ok: false, code: "credentials_file_symlink" });
    fs.chmodSync(k, 0o644);
    expect(readOnly.loadKey(k, PROJECT)).toMatchObject({ ok: false, code: "credentials_file_unsafe" });
  });
  it("refuses a FIFO key path with credentials_file_unsafe without opening it", () => {
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const openSpy = jest.spyOn(rawFs, "openSync");
    try {
      expect(readOnly.loadKey(fifo, PROJECT)).toMatchObject({ ok: false, code: "credentials_file_unsafe" });
      expect(openSpy.mock.calls.filter(([p]) => p === fifo)).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });
  it("runAsCli: an unexpected rejection prints a generic line and exits 1 (no message, no stack)", async () => {
    const lines: string[] = [];
    let exitCode: number | undefined;
    // NODE_ENV is fine; force main() to throw by passing an argv whose iteration throws.
    const hostile = { [Symbol.iterator]: () => { throw new Error("RAW-INTERNAL-MESSAGE"); } };
    await readOnly.runAsCli(hostile, {}, (c: number) => { exitCode = c; }, (l: string) => lines.push(l));
    expect(exitCode).toBe(1);
    expect(lines).toEqual(["Unexpected failure. Nothing was written (this tool is read-only)."]);
  });
});

// ---------------------------------------------------------------------------
// Static wiring over tracked files

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const TRACKED = execSync("git ls-files", { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
const SCRIPT_SOURCES = TRACKED.filter((f) => f.startsWith("scripts/") && /\.(js|cjs|mjs|ts)$/.test(f) && !f.includes("__tests__"));
const SCRIPT = "scripts/admin/set-system-admin-claim.ts";
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

describe("static wiring", () => {
  it("ANCHOR: the scan sees the new script and the read-only scripts", () => {
    expect(SCRIPT_SOURCES).toEqual(expect.arrayContaining([SCRIPT, "scripts/check-admin-claims.js", "scripts/verify-admin-claims.js"]));
  });

  it("the four retired minting scripts are gone", () => {
    for (const f of ["scripts/setAdmin.ts", "scripts/set-admin-claim.js", "scripts/set-admin-simple.js", "scripts/set-admin-by-uid.js"]) {
      expect({ f, tracked: TRACKED.includes(f), exists: fs.existsSync(path.join(REPO, f)) }).toEqual({ f, tracked: false, exists: false });
    }
  });

  it("setCustomUserClaims( is called in scripts/** ONLY by the hardened tool, and never in lib/admin/**", () => {
    const callers = TRACKED.filter((f) => (f.startsWith("scripts/") || f.startsWith("lib/admin/")) && !f.includes("__tests__") && /\.(js|cjs|mjs|ts)$/.test(f))
      .filter((f) => /setCustomUserClaims\s*\(/.test(stripComments(read(f))));
    expect(callers).toEqual([SCRIPT]);
  });

  it("the hardened script and the read-only scripts never load .env.local, dotenv, env credentials, or the app's Firebase singleton", () => {
    for (const f of [SCRIPT, "scripts/check-admin-claims.js", "scripts/verify-admin-claims.js", "lib/admin/systemAdminClaimSafety.ts", "lib/admin/systemAdminClaimExecution.ts"]) {
      const code = stripComments(read(f));
      expect({ f, dotenv: /dotenv/.test(code) }).toEqual({ f, dotenv: false });
      expect({ f, envLocal: code.includes(".env.local") }).toEqual({ f, envLocal: false });
      expect({ f, envCreds: /process\.env\.(FIREBASE|GOOGLE|NEXT_PUBLIC)/.test(code) }).toEqual({ f, envCreds: false });
      expect({ f, appAdmin: /lib\/firebase\/admin/.test(code) }).toEqual({ f, appAdmin: false });
      expect({ f, applicationDefault: /applicationDefault/.test(code) }).toEqual({ f, applicationDefault: false });
    }
  });

  it("no tracked script carries a hard-coded user email or a Firebase-UID-shaped literal", () => {
    const UID_LIKE = /\b(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{28}\b/;
    const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|io|net|org|dev|co)\b/;
    const offenders = SCRIPT_SOURCES.filter((f) => UID_LIKE.test(read(f)) || EMAIL.test(read(f)));
    expect(offenders).toEqual([]);
    // the detector is not vacuous
    expect(UID_LIKE.test('const ADMIN_UID = "Ab3defghijklmnopqrstuvwxyz12";')).toBe(true);
    expect(EMAIL.test("const email = 'someone@example.com'")).toBe(true);
  });

  it("the hardened script classifies itself as authority-minting and not a liveness probe", () => {
    const src = read(SCRIPT);
    expect(src).toContain("MINTS-AUTHORITY");
    expect(src.replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ")).toMatch(/never a secret-liveness probe/);
  });

  it("AdminActionType includes both claim action types (type-only extension)", () => {
    const src = read("lib/admin/auditLog.ts");
    expect(src).toContain('"GRANT_SYSTEM_ADMIN_CLAIM"');
    expect(src).toContain('"REVOKE_SYSTEM_ADMIN_CLAIM"');
  });

  it("the npm script runs the hardened tool", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["admin:set-system-admin-claim"]).toContain(SCRIPT);
  });

  it("every refusal code is exercised by name in at least one spec", () => {
    const specs = [
      "lib/admin/__tests__/systemAdminClaimSafety.spec.ts",
      "lib/admin/__tests__/systemAdminClaimExecution.spec.ts",
      "scripts/admin/__tests__/setSystemAdminClaimCli.spec.ts",
    ].map((f) => fs.readFileSync(path.join(REPO, f), "utf8")).join("\n");
    const missing = REFUSAL_CODES.filter((c) => !specs.includes(`"${c}"`));
    expect(missing).toEqual([]);
  });
});

describe("read-only claim scripts", () => {
  const ok = [`--confirm-project=${PROJECT}`, "--credentials=/k.json", `--uid=${TARGET}`];
  it("CONTROL: all three flags parse", () => {
    expect(readOnly.parseReadOnlyArgs(ok)).toMatchObject({ ok: true, uid: TARGET, confirmProject: PROJECT });
  });
  it.each<[string, string[]]>([
    ["flag_missing", []],
    ["flag_missing", ok.slice(0, 2)],
    ["positional_arg", [TARGET]],
    ["unknown_flag", [...ok, "--execute"]],
    ["duplicate_flag", [...ok, `--uid=${TARGET}`]],
    ["flag_value_missing", [ok[0], ok[1], "--uid="]],
    ["target_uid_invalid", [ok[0], ok[1], "--uid=a@b.c"]],
  ])("refuses %s", (code, argv) => {
    expect(readOnly.parseReadOnlyArgs(argv)).toMatchObject({ ok: false, code });
  });
  it("refuses Vercel / production runtimes", () => {
    expect(readOnly.runtimeRefusal({ VERCEL_ENV: "preview" })).toMatch(/Refusing/);
    expect(readOnly.runtimeRefusal({ NODE_ENV: "production" })).toMatch(/Refusing/);
    expect(readOnly.runtimeRefusal({ NODE_ENV: "development" })).toBeNull();
  });
  it("neither read-only script writes claims or Firestore", () => {
    for (const f of ["scripts/check-admin-claims.js", "scripts/verify-admin-claims.js"]) {
      const code = stripComments(read(f));
      expect(code).not.toMatch(/setCustomUserClaims|revokeRefreshTokens|\.set\(|\.update\(|\.create\(|\.add\(|\.delete\(/);
    }
  });
  it("verify-admin-claims.js delegates to the same implementation", () => {
    expect(read("scripts/verify-admin-claims.js")).toContain('require("./check-admin-claims.js")');
  });
});
