/**
 * TEAM-VERIFICATION-PARITY-R1 — GET /api/governance/audit.
 *
 * Drilldown (?runId=&collection=verifications|videoVerifications): a
 * Workspace-bound parent is concealed exactly like a missing run for every
 * caller, before legacy visibility, both event queries and email enrichment.
 *
 * Global list: `admin_audit_logs` rows have no Workspace scope, and a legacy
 * review of a Team artifact wrote a DISPLAYABLE row. Such rows are removed by
 * one batched, field-masked parent classification; Personal and research
 * events are untouched.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
const mockedRunOwnerVisible = jest.fn((v: string[] | null, o: string) => v === null || v.includes(o));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => mockedRunOwnerVisible(v, o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({ validateRunWorkspaceAssociation: jest.fn(async () => ({ classification: "legacy" })) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const parents = new Map<string, Record<string, unknown>>();
let auditRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const calls = { runScopedAuditQuery: 0, governanceEventsQuery: 0, usersGetAll: 0 };
const mockedGetAll = jest.fn();

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      const snap = () => ({ docs: auditRows.map((r) => ({ id: r.id, data: () => r.data })) });
      return {
        where: (_f: string, _op: string, runId: string) => ({
          limit: () => ({ select: () => ({ get: async () => { calls.runScopedAuditQuery++; return { docs: auditRows.filter((r) => r.data.runId === runId).map((r) => ({ id: r.id, data: () => r.data })) }; } }) }),
        }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }),
        limit: () => ({ select: () => ({ get: async () => snap() }) }),
      };
    }
    return {
      doc: (id: string) => ({
        __path: `${name}/${id}`,
        get: async () => {
          const data = parents.get(`${name}/${id}`);
          return { exists: !!data, data: () => data };
        },
        collection: () => ({
          orderBy: () => ({ limit: () => ({ get: async () => { calls.governanceEventsQuery++; return { docs: [] }; } }) }),
          get: async () => { calls.governanceEventsQuery++; return { docs: [] }; },
        }),
      }),
    };
  },
  getAll: (...args: any[]) => mockedGetAll(...args),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";

const CREATOR = "creator-uid";
const VIEWER = "legacy-reviewer";
const CONCEALED = { status: 404, body: { ok: false, error: { code: "not_found", message: "Run not found." } } };

function realGetAll(...args: any[]) {
  const last = args[args.length - 1];
  const refs = last && typeof last === "object" && "fieldMask" in last ? args.slice(0, -1) : args;
  return Promise.resolve(
    refs.map((ref: any) => {
      if (ref.__path.startsWith("users/")) {
        calls.usersGetAll++;
        return { exists: true, data: () => ({ email: "owner@example.com" }) };
      }
      const full = parents.get(ref.__path);
      if (!full) return { exists: false, data: () => undefined };
      const masked: Record<string, unknown> = {};
      const mask: string[] | undefined = last && typeof last === "object" && "fieldMask" in last ? last.fieldMask : undefined;
      for (const [k, v] of Object.entries(full)) if (!mask || mask.includes(k)) masked[k] = v;
      return { exists: true, data: () => masked };
    })
  );
}

function asViewer(uid: string, visibleUserIds: string[] | null) {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid, email: `${uid}@example.com` });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds });
}
async function get(qs: string) {
  const res = await GET(new NextRequest(`http://localhost/api/governance/audit${qs}`));
  return { status: res.status, body: await res.json() };
}
function event(id: string, collection: string, runId: string, extra: Record<string, unknown> = {}) {
  return { id, data: { action: "approved", byUid: VIEWER, byEmail: "r@example.com", at: `2026-09-10T00:00:${id.slice(-2)}.000Z`, collection, runId, runOwnerUid: CREATOR, question: `question ${runId}`, ...extra } };
}

beforeEach(() => {
  jest.clearAllMocks();
  parents.clear();
  auditRows = [];
  calls.runScopedAuditQuery = 0;
  calls.governanceEventsQuery = 0;
  calls.usersGetAll = 0;
  mockedGetAll.mockImplementation(realGetAll);
});

describe.each(["verifications", "videoVerifications"])("drilldown — %s", (collection) => {
  const callers: Array<[string, string, string[] | null]> = [
    ["the artifact creator", CREATOR, [CREATOR]],
    ["an assigned legacy reviewer", VIEWER, [CREATOR]],
    ["a global governance admin", "gov-admin", null],
  ];

  it.each(callers)("%s -> concealed 404, no visibility decision, no event query, no email enrichment", async (_l, uid, visible) => {
    parents.set(`${collection}/team-1`, { userId: CREATOR, workspaceId: "ws-1", projectId: null });
    auditRows = [event("e01", collection, "team-1", { byUid: uid })];
    asViewer(uid, visible);
    expect(await get(`?runId=team-1&collection=${collection}`)).toEqual(CONCEALED);
    expect(mockedRunOwnerVisible).not.toHaveBeenCalled();
    expect(calls.runScopedAuditQuery).toBe(0);
    expect(calls.governanceEventsQuery).toBe(0);
    expect(mockedGetAll).not.toHaveBeenCalled();
  });

  it("concealed response is identical to a missing run, and workspaceId:null is concealed too", async () => {
    parents.set(`${collection}/team-null`, { userId: CREATOR, workspaceId: null });
    asViewer(VIEWER, [CREATOR]);
    const a = await get(`?runId=team-null&collection=${collection}`);
    asViewer(VIEWER, [CREATOR]);
    const b = await get(`?runId=missing&collection=${collection}`);
    expect(a).toEqual(CONCEALED);
    expect(b).toEqual(CONCEALED);
  });

  it("Personal drilldown is unchanged: events returned for the viewer's own decisions", async () => {
    parents.set(`${collection}/personal-1`, { userId: CREATOR });
    auditRows = [event("e02", collection, "personal-1")];
    asViewer(VIEWER, [CREATOR]);
    const r = await get(`?runId=personal-1&collection=${collection}`);
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e02"]);
    expect(mockedRunOwnerVisible).toHaveBeenCalledTimes(1);
  });

  it("Personal non-visible reviewer still gets the legacy 403", async () => {
    parents.set(`${collection}/personal-1`, { userId: CREATOR });
    asViewer("stranger", ["someone-else"]);
    const r = await get(`?runId=personal-1&collection=${collection}`);
    expect(r.status).toBe(403);
  });
});

describe("global audit list", () => {
  it("Team Claim and Team Video review events are hidden; Personal and research events remain in order", async () => {
    parents.set("verifications/team-claim", { workspaceId: "ws-1", projectId: null, claim: "Team claim text" });
    parents.set("videoVerifications/team-video", { workspaceId: "ws-1", projectId: "proj-1" });
    parents.set("verifications/personal-claim", { claim: "Personal claim", projectId: "proj-personal" });
    parents.set("videoVerifications/personal-video", {});
    auditRows = [
      event("e06", "verifications", "team-claim"),
      event("e05", "runs", "research-run"),
      event("e04", "videoVerifications", "team-video"),
      event("e03", "verifications", "personal-claim"),
      event("e02", "videoVerifications", "personal-video"),
    ];
    asViewer(VIEWER, [CREATOR]);
    const r = await get("?limit=20");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e05", "e03", "e02"]);
    expect(JSON.stringify(r.body)).not.toContain("team-claim");
    expect(JSON.stringify(r.body)).not.toContain("team-video");
  });

  it("classification is ONE batched, field-masked parent read — never per event, never for research runs", async () => {
    auditRows = [];
    for (let i = 10; i < 40; i++) {
      parents.set(`verifications/claim-${i}`, i % 2 === 0 ? { workspaceId: "ws-1" } : {});
      auditRows.push(event(`e${i}`, "verifications", `claim-${i}`));
      auditRows.push(event(`r${i}`, "runs", `run-${i}`, { at: `2026-09-09T00:00:${i}.000Z` }));
    }
    asViewer(VIEWER, [CREATOR]);
    const r = await get("?limit=50");
    expect(r.status).toBe(200);
    const parentCalls = mockedGetAll.mock.calls.filter((c) => c.some((a: any) => a && a.__path && !a.__path.startsWith("users/")));
    expect(parentCalls).toHaveLength(1);
    const refs = parentCalls[0].filter((a: any) => a && a.__path);
    expect(refs).toHaveLength(30);
    expect(refs.every((ref: any) => ref.__path.startsWith("verifications/"))).toBe(true);
    expect(parentCalls[0][parentCalls[0].length - 1]).toEqual({ fieldMask: ["workspaceId"] });
    const ids: string[] = r.body.events.map((e: any) => e.id);
    expect(ids.some((id) => id.startsWith("e") && Number(id.slice(1)) % 2 === 0)).toBe(false);
    expect(ids.filter((id) => id.startsWith("e"))).toHaveLength(15);
  });

  it("no verification events -> zero parent reads", async () => {
    auditRows = [event("e05", "runs", "research-run"), { id: "p01", data: { action: "policy_updated", byUid: VIEWER, at: "2026-09-10T00:00:01.000Z" } }];
    asViewer(VIEWER, [CREATOR]);
    const r = await get("");
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e05", "p01"]);
    const parentCalls = mockedGetAll.mock.calls.filter((c) => c.some((a: any) => a && a.__path && !a.__path.startsWith("users/")));
    expect(parentCalls).toHaveLength(0);
  });

  it("a deleted parent carries no Workspace evidence and its historical Personal row is kept", async () => {
    auditRows = [event("e07", "verifications", "deleted-claim")];
    asViewer(VIEWER, [CREATOR]);
    const r = await get("");
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e07"]);
  });

  it("workspaceId:null parent is Workspace-bound and hidden", async () => {
    parents.set("verifications/null-ws", { workspaceId: null });
    auditRows = [event("e08", "verifications", "null-ws")];
    asViewer(VIEWER, [CREATOR]);
    expect((await get("")).body.events).toEqual([]);
  });

  it("runType=claim filter still works and still excludes Team rows", async () => {
    parents.set("verifications/team-claim", { workspaceId: "ws-1" });
    parents.set("verifications/personal-claim", {});
    auditRows = [event("e09", "verifications", "team-claim", { runType: "claim" }), event("e08", "verifications", "personal-claim", { runType: "claim" }), event("e07", "runs", "run-1", { runType: "research" })];
    asViewer(VIEWER, [CREATOR]);
    expect((await get("?runType=claim")).body.events.map((e: any) => e.id)).toEqual(["e08"]);
  });

  it("a parent classification read failure fails closed (500), never an unclassified list", async () => {
    auditRows = [event("e09", "verifications", "team-claim")];
    mockedGetAll.mockImplementationOnce(async () => { throw new Error("firestore down"); });
    asViewer(VIEWER, [CREATOR]);
    const r = await get("");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("team-claim");
  });
});
