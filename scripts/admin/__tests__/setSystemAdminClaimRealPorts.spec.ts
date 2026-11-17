/**
 * Behavioural tests of the REAL port wiring (`realFirebaseFactory`) over a
 * recording firebase-admin SDK double. No network, no real project.
 *
 * The source-text pin in setSystemAdminClaimCli.spec.ts ("no updateUser, no
 * enable path") can be evaded by rewording, e.g. `(auth as any)["update" +
 * "User"]`. These tests do not read source: the SDK Auth object handed to the
 * real factory is a Proxy that records EVERY member the wiring touches, and
 * the full grant / revoke / failed-claim-write / re-run flows are driven
 * through the real ports. Any member outside the allow-list (updateUser,
 * importUsers, deleteUser, ...) fails the test however it was spelled.
 */

jest.mock("firebase-admin/app", () => ({
  initializeApp: jest.fn((options: unknown, name: string) => ({ options, name })),
  cert: jest.fn(() => ({ __cert: true })),
  deleteApp: jest.fn(async () => undefined),
}));
jest.mock("firebase-admin/auth", () => ({ getAuth: jest.fn() }));
jest.mock("firebase-admin/firestore", () => ({
  getFirestore: jest.fn(),
  FieldValue: { serverTimestamp: () => ({ __serverTimestamp: true }) },
  Timestamp: { now: () => "TS" },
}));

import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

import { realFirebaseFactory } from "../set-system-admin-claim";
import { runSystemAdminClaim, type ExecutionDeps } from "../../../lib/admin/systemAdminClaimExecution";
import { expectedConfirmation, parseSetSystemAdminClaimArgs, type ParsedClaimArgs } from "../../../lib/admin/systemAdminClaimSafety";

const PROJECT = "cp-rehearsal-1";
const TARGET = "TargetUid0000000000000000001";
const OPERATOR = "OperatorUid00000000000000001";
const OTHER_ADMIN = "OtherAdmin000000000000000001";
const TOKEN = "header.payload.signature-FAKE";

/** The ONLY SDK Auth members the tool may touch. */
const ALLOWED_AUTH_MEMBERS = ["getUser", "listUsers", "revokeRefreshTokens", "setCustomUserClaims", "verifyIdToken"];

type SdkUser = { uid: string; email?: string; disabled: boolean; customClaims?: Record<string, unknown>; tokensValidAfterTime?: string };

type Backend = {
  serverMs: number;
  users: Map<string, SdkUser>;
  docs: Map<string, Record<string, unknown>>;
  touched: string[];
  docWrites: { path: string; op: string; data: unknown }[];
  failClaims: boolean;
};

function backend(): Backend {
  return {
    serverMs: Date.parse("2026-11-05T10:00:00.400Z"),
    users: new Map([
      [TARGET, { uid: TARGET, email: "t@example.com", disabled: false, customClaims: { admin: true, plan: "pro" } }],
      [OPERATOR, { uid: OPERATOR, email: "op@example.com", disabled: false, customClaims: { admin: true } }],
      [OTHER_ADMIN, { uid: OTHER_ADMIN, disabled: false, customClaims: { admin: true } }],
    ]),
    docs: new Map([[`users/${TARGET}`, { role: "admin" }]]),
    touched: [],
    docWrites: [],
    failClaims: false,
  };
}

const writeTime = (b: Backend) => {
  b.serverMs += 30;
  return { seconds: Math.floor(b.serverMs / 1000), nanoseconds: (b.serverMs % 1000) * 1e6 };
};

/** A firebase-admin Auth double behind a Proxy that records every member access. */
function recordingSdkAuth(b: Backend): unknown {
  const impl: Record<string, unknown> = {
    getUser: async (uid: string) => {
      b.serverMs += 30;
      const u = b.users.get(uid);
      if (!u) throw Object.assign(new Error("nf"), { code: "auth/user-not-found" });
      return JSON.parse(JSON.stringify(u));
    },
    listUsers: async () => ({ users: [...b.users.values()].map((u) => JSON.parse(JSON.stringify(u))) }),
    verifyIdToken: async (token: string, checkRevoked: boolean) => {
      if (token !== TOKEN || checkRevoked !== true) throw Object.assign(new Error("bad"), { code: "auth/argument-error" });
      return { uid: OPERATOR, admin: true };
    },
    setCustomUserClaims: async (uid: string, claims: Record<string, unknown>) => {
      b.serverMs += 30;
      b.users.get(uid)!.customClaims = JSON.parse(JSON.stringify(claims));
      if (b.failClaims) throw Object.assign(new Error("DEADLINE_EXCEEDED"), { code: "auth/internal-error" });
    },
    revokeRefreshTokens: async (uid: string) => {
      b.serverMs += 30;
      // firebase-admin 12.7.0: validSince = floor(local now / 1000); here local == server clock.
      b.users.get(uid)!.tokensValidAfterTime = new Date(Math.floor(b.serverMs / 1000) * 1000).toUTCString();
    },
    // Present on the real SDK object; touching them must fail the test.
    updateUser: async (uid: string, props: { disabled?: boolean }) => {
      if (props && typeof props.disabled === "boolean") b.users.get(uid)!.disabled = props.disabled;
    },
    deleteUser: async () => undefined,
    importUsers: async () => undefined,
  };
  return new Proxy(impl, {
    get(target, prop) {
      b.touched.push(String(prop));
      return (target as Record<string | symbol, unknown>)[prop];
    },
  });
}

function fakeDb(b: Backend): unknown {
  return {
    collection: (name: string) => ({
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          get: async () => {
            const d = b.docs.get(path);
            return { exists: d !== undefined, get: (f: string) => d?.[f] };
          },
          set: async (data: Record<string, unknown>, opts: unknown) => {
            b.docWrites.push({ path, op: "set", data: { data, opts } });
            b.docs.set(path, { ...(b.docs.get(path) ?? {}), ...data });
            return { writeTime: writeTime(b) };
          },
          create: async (data: Record<string, unknown>) => {
            if (b.docs.has(path)) throw new Error("ALREADY_EXISTS");
            b.docWrites.push({ path, op: "create", data });
            b.docs.set(path, data);
            return { writeTime: writeTime(b) };
          },
        };
      },
    }),
  };
}

function handle(b: Backend) {
  (getAuth as jest.Mock).mockReturnValue(recordingSdkAuth(b));
  (getFirestore as jest.Mock).mockReturnValue(fakeDb(b));
  return realFirebaseFactory({ projectId: PROJECT, clientEmail: "sa@x.iam.gserviceaccount.com", privateKey: "k", appName: "test" });
}

function args(op: "grant" | "revoke"): ParsedClaimArgs {
  const confirm = expectedConfirmation({ operation: op, projectId: PROJECT, targetUid: TARGET });
  const argv = [
    `--confirm-project=${PROJECT}`, "--credentials=/k.json", `--target-uid=${TARGET}`, `--operation=${op}`,
    "--operator-id-token-file=/t", "--execute", `--confirm-claim=${confirm}`,
  ];
  if (op === "revoke") argv.push("--allow-claim-reduction");
  const r = parseSetSystemAdminClaimArgs(argv);
  if (!r.ok) throw new Error(r.code);
  return r.args;
}

function runReal(b: Backend, op: "grant" | "revoke", requestId: string) {
  const h = handle(b);
  const deps: ExecutionDeps<unknown> = {
    auth: h.auth,
    store: h.store,
    timestampNow: h.timestampNow,
    // Local == server clock in this double (the clock the SDK double stamps validSince from).
    nowMs: () => b.serverMs,
    sleepMs: async (ms) => { b.serverMs += ms; },
    readOperatorToken: async () => ({ ok: true, token: TOKEN }),
    git: { sha: "abc", dirty: false },
    log: () => undefined,
  };
  return runSystemAdminClaim(
    { args: args(op), projectId: h.projectId, requestId, credential: { source: "explicit-key-file", clientEmailMasked: "sa…@…" } },
    deps,
  );
}

const outside = (b: Backend) => [...new Set(b.touched)].filter((m) => !ALLOWED_AUTH_MEMBERS.includes(m));

describe("real port wiring (realFirebaseFactory) over a recording SDK double", () => {
  it("the real Auth port exposes exactly the five port methods (no enable / updateUser path)", () => {
    const h = handle(backend());
    expect(Object.keys(h.auth).sort()).toEqual(["getUser", "listUsers", "revokeRefreshTokens", "verifyIdToken", "writeCustomClaims"]);
  });

  it("every port method maps to its allow-listed SDK member and touches nothing else", async () => {
    const b = backend();
    const h = handle(b);
    await h.auth.getUser(TARGET);
    await h.auth.listUsers(1000);
    await h.auth.verifyIdToken(TOKEN, true);
    await h.auth.writeCustomClaims(TARGET, { plan: "pro" });
    await h.auth.revokeRefreshTokens(TARGET);
    expect([...new Set(b.touched)].sort()).toEqual(ALLOWED_AUTH_MEMBERS);
    expect(b.users.get(TARGET)!.disabled).toBe(false);
  });

  it.each<[string, (b: Backend) => void, (b: Backend) => Promise<unknown>]>([
    ["grant", (b) => { b.users.get(TARGET)!.customClaims = { plan: "pro" }; }, (b) => runReal(b, "grant", "req_1_grant")],
    ["revoke", () => undefined, (b) => runReal(b, "revoke", "req_1_revoke")],
    ["revoke on a DISABLED target", (b) => { b.users.get(TARGET)!.disabled = true; }, (b) => runReal(b, "revoke", "req_1_disabled")],
    ["revoke whose claim write throws, then the same-command re-run", (b) => { b.failClaims = true; }, async (b) => {
      await runReal(b, "revoke", "req_1_throw");
      b.failClaims = false;
      return runReal(b, "revoke", "req_2_rerun");
    }],
  ])("%s through the real ports: only allow-listed SDK Auth members are ever touched; `disabled` is never changed", async (_name, setup, flow) => {
    const b = backend();
    setup(b);
    const disabledBefore = [...b.users.values()].map((u) => [u.uid, u.disabled]);
    await flow(b);
    expect(b.touched.length).toBeGreaterThan(0);
    expect(outside(b)).toEqual([]);
    expect(b.touched).not.toContain("updateUser");
    expect([...b.users.values()].map((u) => [u.uid, u.disabled])).toEqual(disabledBefore);
  });

  it("revoke through the real ports: claim removed, revocation acknowledged, cutoff observed, exit 0; the role write carries a server timestamp", async () => {
    const b = backend();
    const r = await runReal(b, "revoke", "req_1_ok");
    expect([r.status, r.exitCode]).toEqual(["applied", 0]);
    expect(b.users.get(TARGET)!.customClaims).toEqual({ plan: "pro" });
    expect(r.sessionRevocationObservations).toMatchObject({ claimWrite: "confirmed", revocationApiAcknowledged: true, cutoffObserved: true });
    const roleWrite = b.docWrites.find((w) => w.path === `users/${TARGET}`)!;
    expect(roleWrite.data).toEqual({ data: { role: "user", updatedAt: { __serverTimestamp: true } }, opts: { merge: true } });
  });

  it("revoke whose real setCustomUserClaims throws after applying: revokeRefreshTokens is still reached through the real port; run INCOMPLETE (exit 3)", async () => {
    const b = backend();
    b.failClaims = true;
    const r = await runReal(b, "revoke", "req_1_throw");
    expect([r.status, r.exitCode, r.code]).toEqual(["incomplete", 3, "mint_failed"]);
    expect(b.touched).toContain("revokeRefreshTokens");
    expect(b.users.get(TARGET)!.tokensValidAfterTime).toBeDefined();
    expect(r.sessionRevocationObservations).toMatchObject({ claimWrite: "unconfirmed", revocationApiAcknowledged: true, cutoffObserved: false });
  });

  it("CONTROL: the recorder does catch a computed-name call to a forbidden member", async () => {
    const b = backend();
    const sdk = recordingSdkAuth(b) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await sdk["update" + "User"](TARGET, { disabled: false });
    expect(outside(b)).toEqual(["updateUser"]);
  });
});
