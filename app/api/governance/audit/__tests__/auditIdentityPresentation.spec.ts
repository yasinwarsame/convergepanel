/**
 * Roadmap 4.1 (C2 + C3) — GET /api/governance/audit run-owner identity.
 *
 * Every response event carries at most ONE run-owner identity:
 * `runOwnerIsViewer: true`, or a real `runOwnerEmail` address, or neither
 * (rendered "Not available"). `runOwnerUid` never leaves the route; no uid is
 * ever sent in the `runOwnerEmail` field; and the "never recorded" and
 * "withheld" cases produce byte-identical owner fields.
 *
 * The fake honours Firestore field masks and real document paths, so a
 * classification that forgets to read `workspaceId` sees no workspace and
 * the boundary tests fail.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => v === null || v.includes(o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: jest.fn(async () => ({ classification: "legacy" })),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const docs = new Map<string, Record<string, unknown>>();
let auditRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let failRunsGetAll = false;
const getAllPaths: string[][] = [];

function rowsAsDocs(rows: typeof auditRows) {
  return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      return {
        where: (_f: string, _op: string, runId: string) => ({
          limit: () => ({ select: () => ({ get: async () => rowsAsDocs(auditRows.filter((r) => r.data.runId === runId)) }) }),
        }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => rowsAsDocs(auditRows) }) }) }),
        limit: () => ({ select: () => ({ get: async () => rowsAsDocs(auditRows) }) }),
      };
    }
    return {
      doc: (id: string) => ({
        __path: `${name}/${id}`,
        get: async () => {
          const data = docs.get(`${name}/${id}`);
          return { exists: !!data, data: () => data };
        },
        collection: () => ({
          orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
          get: async () => ({ docs: [] }),
        }),
      }),
    };
  },
  getAll: async (...args: any[]) => {
    const last = args[args.length - 1];
    const hasOpts = last && typeof last === "object" && !("__path" in last);
    const refs = hasOpts ? args.slice(0, -1) : args;
    const mask: string[] | undefined = hasOpts ? last.fieldMask : undefined;
    getAllPaths.push(refs.map((r: any) => r.__path));
    if (failRunsGetAll && refs.some((r: any) => r.__path.startsWith("runs/"))) throw new Error("UNAVAILABLE");
    return refs.map((ref: any) => {
      const full = docs.get(ref.__path);
      if (!full) return { exists: false, data: () => undefined };
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(full)) if (!mask || mask.includes(k)) masked[k] = v;
      return { exists: true, data: () => masked };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";

const VIEWER = "uid-SENTINEL-VIEWER-91c2";
const OWNER = "uid-SENTINEL-OWNER-7f3a";
const OWNER_EMAIL = "owner.person@example.com";

function asViewer(visibleUserIds: string[] | null) {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid: VIEWER, email: "viewer@example.com", emailVerified: true });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds });
}

/** An adaptive row: `byUid` only, no recorded owner (lib/governance/auditLog.ts writers). */
function adaptiveRow(id: string, runId: string, action = "adaptive_human_review_decided") {
  return { id, data: { action, byUid: VIEWER, at: `2026-10-01T00:00:${id.slice(-2)}.000Z`, runId, collection: "runs", prevStatus: "pending", nextStatus: "approved" } };
}

async function list(visible: string[] | null = [VIEWER, OWNER]) {
  asViewer(visible);
  const res = await GET(new NextRequest("http://localhost/api/governance/audit?limit=50"));
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; events: Array<Record<string, unknown>> };
}

function ownerFields(ev: Record<string, unknown>) {
  return { runOwnerEmail: ev.runOwnerEmail, runOwnerIsViewer: ev.runOwnerIsViewer, hasUid: "runOwnerUid" in ev };
}

const WITHHELD = { runOwnerEmail: undefined, runOwnerIsViewer: undefined, hasUid: false };

/** Refined stop condition: no uid in any display field; another person's uid nowhere at all. */
function expectNoUidExposure(body: unknown) {
  expect(JSON.stringify(body)).not.toContain(OWNER);
  for (const ev of (body as { events: Array<Record<string, unknown>> }).events) {
    expect("runOwnerUid" in ev).toBe(false);
    for (const field of ["runOwnerEmail", "byEmail"]) {
      const v = ev[field];
      if (v !== undefined) expect(String(v)).toContain("@");
    }
  }
}

beforeEach(() => {
  docs.clear();
  auditRows = [];
  failRunsGetAll = false;
  getAllPaths.length = 0;
  docs.set(`users/${OWNER}`, { email: OWNER_EMAIL });
});

describe("adaptive rows (no recorded owner) — C2 owner release rule", () => {
  it("owner is the viewer -> runOwnerIsViewer, even on a workspace-bound run", async () => {
    docs.set("runs/r-own", { userId: VIEWER, workspaceId: "ws-personal" });
    auditRows = [adaptiveRow("e01", "r-own")];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: undefined, runOwnerIsViewer: true, hasUid: false });
    expectNoUidExposure(body);
  });

  it("personal run, owner in the visible set -> the owner's real email", async () => {
    docs.set("runs/r-vis", { userId: OWNER });
    auditRows = [adaptiveRow("e01", "r-vis")];
    const body = await list([VIEWER, OWNER]);
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: OWNER_EMAIL, runOwnerIsViewer: undefined, hasUid: false });
    expectNoUidExposure(body);
  });

  it("owner outside the visible set -> withheld, and the profile is never read", async () => {
    docs.set("runs/r-invis", { userId: OWNER });
    auditRows = [adaptiveRow("e01", "r-invis")];
    const body = await list([VIEWER]);
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expect(JSON.stringify(body)).not.toContain(OWNER_EMAIL);
    expect(getAllPaths.flat()).not.toContain(`users/${OWNER}`);
    expectNoUidExposure(body);
  });

  it.each([
    ["a string workspaceId", "ws-team-1"],
    ["workspaceId: null", null],
  ])("workspace-bound run (%s), owner visible -> withheld", async (_l, workspaceId) => {
    docs.set("runs/r-ws", { userId: OWNER, workspaceId });
    auditRows = [adaptiveRow("e01", "r-ws")];
    const body = await list([VIEWER, OWNER]);
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expect(JSON.stringify(body)).not.toContain(OWNER_EMAIL);
    expectNoUidExposure(body);
  });

  it("workspace-bound run stays withheld for a global governance admin (visibleUserIds null)", async () => {
    docs.set("runs/r-ws", { userId: OWNER, workspaceId: "ws-team-1" });
    auditRows = [adaptiveRow("e01", "r-ws")];
    const body = await list(null);
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expectNoUidExposure(body);
  });

  it.each([
    ["missing parent", () => undefined],
    ["parent with no userId", () => docs.set("runs/r-x", { question: "q" })],
    ["parent with a non-string userId", () => docs.set("runs/r-x", { userId: 42 })],
    ["owner visible but profile has no email", () => {
      docs.set("runs/r-x", { userId: OWNER });
      docs.set(`users/${OWNER}`, { name: "Owner" });
    }],
  ])("%s -> withheld", async (_l, setup) => {
    setup();
    auditRows = [adaptiveRow("e01", "r-x")];
    const body = await list([VIEWER, OWNER]);
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expectNoUidExposure(body);
  });

  it("parent read failure -> withheld, page still answers 200", async () => {
    docs.set("runs/r-x", { userId: OWNER });
    failRunsGetAll = true;
    auditRows = [adaptiveRow("e01", "r-x")];
    const body = await list([VIEWER, OWNER]);
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expectNoUidExposure(body);
  });

  it("'not recorded' and 'not visible' are indistinguishable", async () => {
    docs.set("runs/r-invis", { userId: OWNER });
    docs.set("runs/r-ws", { userId: OWNER, workspaceId: "ws-team-1" });
    auditRows = [adaptiveRow("e01", "r-invis"), adaptiveRow("e02", "r-ws"), adaptiveRow("e03", "r-missing")];
    const body = await list([VIEWER]);
    const shapes = body.events.map((ev) => {
      const { id: _id, at: _at, runId: _runId, ...rest } = ev;
      return rest;
    });
    expect(shapes).toHaveLength(3);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });

  it("parents and profiles are each read in one batched retrieval, not per event", async () => {
    for (let i = 0; i < 5; i++) docs.set(`runs/r-${i}`, { userId: OWNER });
    auditRows = [0, 1, 2, 3, 4].map((i) => adaptiveRow(`e0${i}`, `r-${i}`));
    await list([VIEWER, OWNER]);
    const runCalls = getAllPaths.filter((p) => p.some((x) => x.startsWith("runs/")));
    const userCalls = getAllPaths.filter((p) => p.some((x) => x.startsWith("users/")));
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toHaveLength(5);
    expect(userCalls).toEqual([[`users/${OWNER}`]]);
  });
});

describe("legacy rows (owner recorded at write time) — C3 output hygiene", () => {
  function legacyRow(id: string, extra: Record<string, unknown>) {
    return {
      id,
      data: { action: "approved", byUid: VIEWER, byEmail: "viewer@example.com", at: `2026-10-01T00:00:${id.slice(-2)}.000Z`, runId: "r-legacy", collection: "runs", ...extra },
    };
  }

  it("recorded real email is kept; runOwnerUid is stripped", async () => {
    auditRows = [legacyRow("e01", { runOwnerUid: OWNER, runOwnerEmail: "recorded@example.com" })];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: "recorded@example.com", runOwnerIsViewer: undefined, hasUid: false });
    expectNoUidExposure(body);
  });

  it("uid recorded in the runOwnerEmail field -> replaced by the profile email", async () => {
    auditRows = [legacyRow("e01", { runOwnerUid: OWNER, runOwnerEmail: OWNER })];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: OWNER_EMAIL, runOwnerIsViewer: undefined, hasUid: false });
    expectNoUidExposure(body);
  });

  it("uid recorded in the runOwnerEmail field and no profile email -> withheld, never the uid", async () => {
    docs.set(`users/${OWNER}`, {});
    auditRows = [legacyRow("e01", { runOwnerUid: OWNER, runOwnerEmail: OWNER })];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expectNoUidExposure(body);
  });

  it("recorded owner is the viewer -> runOwnerIsViewer", async () => {
    auditRows = [legacyRow("e01", { runOwnerUid: VIEWER, runOwnerEmail: "" })];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: undefined, runOwnerIsViewer: true, hasUid: false });
  });

  it("policy rows are never classified against a parent", async () => {
    auditRows = [{ id: "e01", data: { action: "policy_updated", byUid: VIEWER, byEmail: "viewer@example.com", at: "2026-10-01T00:00:01.000Z", runId: "policy", collection: "runs" } }];
    const body = await list();
    expect(ownerFields(body.events[0])).toEqual(WITHHELD);
    expect(getAllPaths.flat()).not.toContain("runs/policy");
  });
});

describe("per-run drilldown uses the same presentation", () => {
  it("adaptive row in a drilldown: owner released by the same rule, no uid exposure", async () => {
    docs.set("runs/r-vis", { userId: OWNER });
    auditRows = [adaptiveRow("e01", "r-vis")];
    asViewer([VIEWER, OWNER]);
    const res = await GET(new NextRequest("http://localhost/api/governance/audit?runId=r-vis&collection=runs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ownerFields(body.events[0])).toEqual({ runOwnerEmail: OWNER_EMAIL, runOwnerIsViewer: undefined, hasUid: false });
    expectNoUidExposure(body);
  });
});
