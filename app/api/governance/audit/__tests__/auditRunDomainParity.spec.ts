/**
 * Roadmap 4.3a (D1) — Governance audit LIST and per-run DRILLDOWN agree on the
 * legacy-governance authority domain for run-backed events.
 *
 * Stop condition (owner, fixed):
 *   For every displayed Governance audit event whose parent is a run, list
 *   visibility and drilldown accessibility agree. A Team-bound Research event
 *   is absent from the list exactly where its drilldown is concealed as 404;
 *   legacy and personal-bound Research events remain listable and drillable.
 *   Missing, malformed, or unclassifiable parents never cause an inaccessible
 *   event to be advertised.
 *
 * The REAL `validateRunWorkspaceAssociation` runs on both sides (only the
 * Workspace document lookup behind it is faked: a run's own Personal Workspace
 * resolves; nothing else exists). Every event family that writes
 * `collection: "runs"` is covered, and an event with NO `collection` field is
 * held to exactly the same outcome as `collection: "runs"` — the dashboard's
 * trail drills into `runs` when the field is absent.
 */

jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: VIEWER, email: "viewer@test-invented.example", emailVerified: true }),
}));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  // The viewer may see OWNER's runs: any concealment observed below comes from
  // the Workspace domain rule, not from owner visibility.
  resolveGovernanceVisibleUserIdsCached: async () => ({ ok: true, visibleUserIds: [OWNER], isSupportAdmin: false, queueScope: "assigners" }),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => v === null || v.includes(o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
const resolverCalls: string[] = [];
jest.mock("@/lib/workspaces/workspaceResolver", () => {
  const { getPersonalWorkspaceId } = jest.requireActual("@/lib/workspaces/personalWorkspaceId");
  return {
    resolveWorkspaceContextForResource: async (args: { workspaceId: string; legacyOwnerUserId: string }) => {
      resolverCalls.push(`${args.legacyOwnerUserId}::${args.workspaceId}`);
      const personal = getPersonalWorkspaceId(args.legacyOwnerUserId);
      if (personal.ok && personal.workspaceId === args.workspaceId) {
        return { kind: "resolved", context: { mode: "workspace", workspaceId: args.workspaceId, workspaceType: "personal", ownerUserId: args.legacyOwnerUserId } };
      }
      return { kind: "not_found" };
    },
  };
});
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const docs = new Map<string, Record<string, unknown>>();
let auditRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const getAllCalls: Array<{ paths: string[]; fieldMask?: string[] }> = [];

function snap(path: string, mask?: string[]) {
  const full = docs.get(path);
  if (!full) return { exists: false, data: () => undefined };
  const masked = mask ? Object.fromEntries(Object.entries(full).filter(([k]) => mask.includes(k))) : { ...full };
  return { exists: true, data: () => masked };
}
const rowsDocs = (rows: typeof auditRows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => r.data })) });

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      return {
        where: (_f: string, _op: string, runId: string) => ({
          limit: () => ({ select: () => ({ get: async () => rowsDocs(auditRows.filter((r) => r.data.runId === runId)) }) }),
        }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => rowsDocs(auditRows) }) }) }),
        limit: () => ({ select: () => ({ get: async () => rowsDocs(auditRows) }) }),
      };
    }
    return {
      doc: (id: string) => ({
        __path: `${name}/${id}`,
        get: async () => snap(`${name}/${id}`),
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
    getAllCalls.push({ paths: refs.map((r: any) => r.__path), fieldMask: mask });
    return refs.map((r: any) => snap(r.__path, mask));
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

const VIEWER = "viewer-uid";
const OWNER = "owner-uid";
const personalWs = (() => {
  const r = getPersonalWorkspaceId(OWNER);
  if (!r.ok) throw new Error("fixture");
  return r.workspaceId;
})();

/** Every event family written with `collection: "runs"` (lib/governance/auditLog.ts writers + the legacy review route). */
const RUN_EVENT_FAMILIES = [
  "approved",
  "adaptive_human_review_decided",
  "adaptive_human_review_reviewer_assigned",
  "adaptive_human_review_reviewer_reassigned",
  "adaptive_human_review_reviewer_unassigned",
  "adaptive_review_panel_finalized",
  "adaptive_review_panel_owner_overridden",
  "adaptive_export_generated",
  "adaptive_export_generation_failed",
  "adaptive_export_regenerated",
] as const;

/**
 * `drill` is the drilldown status the route produces today. Parity is
 * "listed ⇔ drilldown 200". A parent with no owner is refused by the
 * drilldown's owner-visibility check (403) before the Workspace rule; it is
 * still inaccessible, so it is still unlisted.
 */
type Parent = { label: string; data: Record<string, unknown> | null; listed: boolean; drill: number };
const PARENTS: Parent[] = [
  { label: "legacy run (no workspaceId)", data: { userId: OWNER }, listed: true, drill: 200 },
  { label: "personal-bound run", data: { userId: OWNER, workspaceId: personalWs }, listed: true, drill: 200 },
  { label: "Team-bound run", data: { userId: OWNER, workspaceId: "ws-team-1" }, listed: false, drill: 404 },
  { label: "malformed workspaceId (null)", data: { userId: OWNER, workspaceId: null }, listed: false, drill: 404 },
  { label: "malformed workspaceId (empty)", data: { userId: OWNER, workspaceId: "" }, listed: false, drill: 404 },
  { label: "no owner, with a workspaceId", data: { workspaceId: "ws-team-1" }, listed: false, drill: 403 },
  { label: "missing parent", data: null, listed: false, drill: 404 },
];
const SHAPES = [
  { label: 'collection: "runs"', collection: "runs" as string | undefined },
  { label: "no collection field", collection: undefined },
];

function auditEvent(id: string, action: string, runId: string, collection: string | undefined) {
  return {
    id,
    data: {
      action,
      byUid: VIEWER,
      byEmail: "viewer@test-invented.example",
      at: "2026-10-07T12:00:00.000Z",
      runId,
      ...(collection !== undefined ? { collection } : {}),
      prevStatus: "pending",
      nextStatus: "approved",
    },
  };
}

async function listIds(): Promise<string[]> {
  const res = await GET(new NextRequest("http://localhost/api/governance/audit?limit=50"));
  expect(res.status).toBe(200);
  return ((await res.json()).events as Array<{ id: string }>).map((e) => e.id);
}
/** The dashboard trail: `collection` falls back to "runs" when the event has none. */
async function drilldownStatus(runId: string, collection: string | undefined): Promise<number> {
  const res = await GET(new NextRequest(`http://localhost/api/governance/audit?runId=${runId}&collection=${collection ?? "runs"}`));
  return res.status;
}

beforeEach(() => {
  docs.clear();
  auditRows = [];
  getAllCalls.length = 0;
  resolverCalls.length = 0;
});

describe.each(RUN_EVENT_FAMILIES)("%s", (action) => {
  describe.each(PARENTS)("$label", (parent) => {
    it.each(SHAPES)("$label: listed exactly when the drilldown is accessible", async (shape) => {
      if (parent.data) docs.set("runs/run-x", parent.data);
      auditRows = [auditEvent("ev-1", action, "run-x", shape.collection)];

      const listed = (await listIds()).includes("ev-1");
      const status = await drilldownStatus("run-x", shape.collection);

      expect(listed).toBe(parent.listed);
      expect(status).toBe(parent.drill);
      expect(listed).toBe(status === 200);
    });
  });
});

describe("no-collection events are classified exactly like collection: \"runs\"", () => {
  it("the same parent gives the same list outcome for both shapes, across every parent kind", async () => {
    for (const parent of PARENTS) {
      docs.clear();
      if (parent.data) docs.set("runs/run-x", parent.data);
      // Distinct statuses so the route's duplicate-row filter keeps both.
      const without = auditEvent("ev-without", "adaptive_human_review_decided", "run-x", undefined);
      without.data.nextStatus = "changes_requested";
      auditRows = [auditEvent("ev-with", "adaptive_human_review_decided", "run-x", "runs"), without];
      const ids = await listIds();
      expect([ids.includes("ev-with"), ids.includes("ev-without")]).toEqual([parent.listed, parent.listed]);
    }
  });
});

describe("other parents and shapes", () => {
  it("policy rows are kept and read no parent", async () => {
    auditRows = [{ id: "pol-1", data: { action: "policy_updated", byUid: VIEWER, at: "2026-10-07T12:00:00.000Z", runId: "policy", collection: "runs", policyVersion: 3 } }];
    expect(await listIds()).toEqual(["pol-1"]);
    expect(getAllCalls.flatMap((c) => c.paths)).toEqual([]);
  });

  it("an unknown collection value is unclassifiable and suppressed", async () => {
    docs.set("runs/run-x", { userId: OWNER });
    auditRows = [auditEvent("ev-1", "adaptive_human_review_decided", "run-x", "teamRuns")];
    expect(await listIds()).toEqual([]);
  });

  it("a run event with no usable runId is suppressed", async () => {
    auditRows = [auditEvent("ev-1", "adaptive_human_review_decided", "   ", "runs")];
    expect(await listIds()).toEqual([]);
  });

  it("Claims/Videos keep their existing containment", async () => {
    docs.set("verifications/c-personal", {});
    docs.set("verifications/c-team", { workspaceId: "ws-team-1" });
    auditRows = [
      { id: "c1", data: { action: "approved", byUid: VIEWER, at: "2026-10-07T12:00:02.000Z", runId: "c-personal", collection: "verifications" } },
      { id: "c2", data: { action: "approved", byUid: VIEWER, at: "2026-10-07T12:00:01.000Z", runId: "c-team", collection: "verifications" } },
    ];
    expect(await listIds()).toEqual(["c1"]);
  });
});

describe("read shape", () => {
  it("run parents are read in ONE field-masked batch, owner classification reuses it, and the validator resolves each distinct binding once", async () => {
    for (let i = 0; i < 12; i++) {
      docs.set(`runs/run-${i}`, i % 3 === 0 ? { userId: OWNER, workspaceId: "ws-team-1" } : i % 3 === 1 ? { userId: OWNER, workspaceId: personalWs } : { userId: OWNER });
    }
    auditRows = Array.from({ length: 12 }, (_, i) =>
      auditEvent(`ev-${String(i).padStart(2, "0")}`, "adaptive_human_review_decided", `run-${i}`, i % 2 ? "runs" : undefined)
    );
    const ids = await listIds();
    expect(ids).toHaveLength(8);
    const runCalls = getAllCalls.filter((c) => c.paths.some((p) => p.startsWith("runs/")));
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].paths).toHaveLength(12);
    expect(runCalls[0].fieldMask).toEqual(["userId", "workspaceId"]);
    // Two distinct non-legacy bindings (Team, Personal); legacy needs no lookup.
    // The Team id fails the deterministic-id check before any lookup.
    expect(resolverCalls).toEqual([`${OWNER}::${personalWs}`]);
  });
});
