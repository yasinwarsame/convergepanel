/**
 * Governance audit trail access (owner decision 2026-11-04, acceptance finding F-ACC-1).
 *
 * Defect: in the /governance Audit tab, a row for the viewer's own action on the viewer's OWN run was listed (and marked
 * `runOwnerIsViewer`), but its trail answered 403 "You don't have access to this run's audit events.", because the
 * drilldown checked the run owner against the reviewer scope (`visibleUserIds`), which for a full-plan reviewer is the
 * CURRENT assigners only and never the viewer.
 *
 * Contract after the fix (lib/governance/governanceTrailAccess.ts):
 *   - the run's authoritative owner may open its trail, which still shows only the viewer's own actions;
 *   - a reviewer the owner CURRENTLY assigns may open it (unchanged);
 *   - a former reviewer and an unrelated user stay refused (403);
 *   - the reviewer scope itself is NOT expanded;
 *   - the list marks each row `trailAvailable` by the same rule; the UI offers the trail control only when it is true.
 *
 * The REAL `runOwnerVisibleInGovernance` is used; only identity, the scope resolver and Firestore are mocked.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => {
  const actual = jest.requireActual("@/lib/governance/governanceVisibleUserIds");
  return {
    ...actual,
    resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  };
});
/** Team-bound runs (a `workspaceId` other than the owner's Personal binding) are classified invalid, as in Production. */
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: jest.fn(async (data: Record<string, unknown>) =>
    data && data.workspaceId === "team-ws" ? { classification: "invalid", reason: "team_bound" } : { classification: "legacy" }
  ),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const parents = new Map<string, Record<string, unknown>>();
let auditRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const governanceEventsByRun = new Map<string, Array<{ id: string; data: Record<string, unknown> }>>();
/** Every Firestore method the route may call is a READ. Any write method is absent, so an attempted write would throw. */
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      const snap = () => ({ docs: auditRows.map((r) => ({ id: r.id, data: () => r.data })) });
      return {
        where: (_f: string, _op: string, runId: string) => ({
          limit: () => ({ select: () => ({ get: async () => ({ docs: auditRows.filter((r) => r.data.runId === runId).map((r) => ({ id: r.id, data: () => r.data })) }) }) }),
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
        collection: () => {
          const docs = () => (governanceEventsByRun.get(`${name}/${id}`) ?? []).map((r) => ({ id: r.id, data: () => r.data }));
          return { orderBy: () => ({ limit: () => ({ get: async () => ({ docs: docs() }) }) }), get: async () => ({ docs: docs() }) };
        },
      }),
    };
  },
  getAll: async (...args: any[]) => {
    const last = args[args.length - 1];
    const hasOpts = last && typeof last === "object" && "fieldMask" in last;
    const refs = hasOpts ? args.slice(0, -1) : args;
    const mask: string[] | undefined = hasOpts ? last.fieldMask : undefined;
    return refs.map((ref: any) => {
      if (ref.__path.startsWith("users/")) return { exists: true, data: () => ({ email: `${ref.__path.slice(6)}@example.com` }) };
      const full = parents.get(ref.__path);
      if (!full) return { exists: false, data: () => undefined };
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(full)) if (!mask || mask.includes(k)) masked[k] = v;
      return { exists: true, data: () => masked };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";
import { governanceTrailAccessible } from "@/lib/governance/governanceTrailAccess";
import { runOwnerVisibleInGovernance } from "@/lib/governance/governanceVisibleUserIds";

const ME = "viewer-me";
const ASSIGNER = "assigner-current";
const FORMER = "assigner-former";
const STRANGER = "unrelated-owner";
const OTHER_REVIEWER = "other-reviewer";
/** Production contract for a full-plan reviewer: the CURRENT assigners only, never the viewer. */
const MY_SCOPE = [ASSIGNER];
const FORBIDDEN = { ok: false, error: { code: "forbidden", message: "You don't have access to this run's audit events." } };
const CONCEALED = { ok: false, error: { code: "not_found", message: "Run not found." } };

function asViewer(uid: string, visibleUserIds: string[] | null) {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid, email: `${uid}@example.com` });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds });
}
async function get(qs: string) {
  const res = await GET(new NextRequest(`http://localhost/api/governance/audit${qs}`));
  return { status: res.status, body: await res.json() };
}
function row(id: string, runId: string, extra: Record<string, unknown> = {}) {
  return { id, data: { action: "approved", byUid: ME, at: `2026-11-03T21:00:${id.slice(-2)}.000Z`, collection: "runs", runId, question: `question ${runId}`, ...extra } };
}
const trail = (runId: string, collection = "runs") => get(`?runId=${runId}&collection=${collection}`);

beforeEach(() => {
  jest.clearAllMocks();
  parents.clear();
  governanceEventsByRun.clear();
  parents.set("runs/own-run", { userId: ME });
  parents.set("runs/assigned-run", { userId: ASSIGNER });
  parents.set("runs/former-run", { userId: FORMER });
  parents.set("runs/stranger-run", { userId: STRANGER });
  auditRows = [];
});

describe("T1 — the run's owner opens their own trail", () => {
  it("200, and the trail holds only the viewer's own actions on that run", async () => {
    auditRows = [row("e01", "own-run"), row("e02", "own-run", { byUid: OTHER_REVIEWER }), row("e03", "assigned-run")];
    asViewer(ME, MY_SCOPE);
    const r = await trail("own-run");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e01"]);
    expect(r.body.events[0].runOwnerIsViewer).toBe(true);
  });

  it("the same holds for the viewer's own Personal claim verification", async () => {
    parents.set("verifications/own-claim", { userId: ME });
    auditRows = [row("e04", "own-claim", { collection: "verifications" })];
    asViewer(ME, MY_SCOPE);
    const r = await trail("own-claim", "verifications");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e04"]);
  });

  it("ownership is the PARENT's userId: a row that RECORDS the viewer as owner does not open someone else's run", async () => {
    auditRows = [row("e05", "former-run", { runOwnerUid: ME })];
    asViewer(ME, MY_SCOPE);
    expect(await trail("former-run")).toEqual({ status: 403, body: FORBIDDEN });
  });
});

describe("T2 — a reviewer the owner currently assigns (unchanged)", () => {
  it("200 with the viewer's own actions", async () => {
    auditRows = [row("e06", "assigned-run")];
    asViewer(ME, MY_SCOPE);
    const r = await trail("assigned-run");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => e.id)).toEqual(["e06"]);
  });

  it("a support admin (global scope) still opens any trail", async () => {
    auditRows = [row("e07", "stranger-run")];
    asViewer(ME, null);
    expect((await trail("stranger-run")).status).toBe(200);
  });
});

describe("T3/T4 — a former reviewer and an unrelated user stay refused", () => {
  it("former reviewer: 403, even though the viewer acted on the run", async () => {
    auditRows = [row("e08", "former-run")];
    asViewer(ME, MY_SCOPE);
    expect(await trail("former-run")).toEqual({ status: 403, body: FORBIDDEN });
  });

  it("unrelated authenticated user: 403", async () => {
    asViewer(ME, MY_SCOPE);
    expect(await trail("stranger-run")).toEqual({ status: 403, body: FORBIDDEN });
  });

  it("a run with no recorded owner is not treated as the viewer's", async () => {
    parents.set("runs/ownerless-run", { question: "x" });
    asViewer(ME, MY_SCOPE);
    expect(await trail("ownerless-run")).toEqual({ status: 403, body: FORBIDDEN });
  });
});

describe("T5 — signed out", () => {
  it("401 before any owner or scope evaluation", async () => {
    mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: false });
    expect((await trail("own-run")).status).toBe(401);
    expect(mockedResolveVisibleUserIds).not.toHaveBeenCalled();
  });
});

describe("T6 — workspace isolation is unchanged for the owner", () => {
  it("the viewer's own Team-bound run: 404 concealed, not opened", async () => {
    parents.set("runs/own-team-run", { userId: ME, workspaceId: "team-ws" });
    auditRows = [row("e09", "own-team-run")];
    asViewer(ME, MY_SCOPE);
    expect(await trail("own-team-run")).toEqual({ status: 404, body: CONCEALED });
  });

  it("the viewer's own Workspace-bound claim: 404 concealed", async () => {
    parents.set("verifications/own-team-claim", { userId: ME, workspaceId: "team-ws" });
    asViewer(ME, MY_SCOPE);
    expect(await trail("own-team-claim", "verifications")).toEqual({ status: 404, body: CONCEALED });
  });

  it("a missing run: 404", async () => {
    asViewer(ME, MY_SCOPE);
    expect(await trail("no-such-run")).toEqual({ status: 404, body: CONCEALED });
  });
});

describe("T7 — the list marks trail availability by the same rule", () => {
  beforeEach(() => {
    parents.set("verifications/own-claim", { userId: ME });
    parents.set("runs/own-team-run", { userId: ME, workspaceId: "team-ws" });
    auditRows = [
      row("e11", "own-run"),
      row("e12", "assigned-run"),
      row("e13", "former-run"),
      row("e14", "own-claim", { collection: "verifications" }),
      row("e15", "own-team-run"),
      { id: "e16", data: { action: "policy_updated", byUid: ME, at: "2026-11-03T21:00:16.000Z", runId: "policy" } },
    ];
  });

  it("own and current-assigner rows are openable; the former reviewer's row is listed but not openable", async () => {
    asViewer(ME, MY_SCOPE);
    const r = await get("");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.events.map((e: any) => [e.id, e.trailAvailable]));
    expect(byId).toEqual({ e11: true, e12: true, e13: false, e14: true, e16: undefined });
  });

  it("every listed row agrees with what its drilldown actually answers", async () => {
    asViewer(ME, MY_SCOPE);
    const list = await get("");
    for (const ev of list.body.events.filter((e: any) => e.runId !== "policy")) {
      asViewer(ME, MY_SCOPE);
      const d = await trail(ev.runId, ev.collection ?? "runs");
      expect(`${ev.id}:${d.status === 200}`).toBe(`${ev.id}:${ev.trailAvailable}`);
    }
  });
});

describe("T8 — history, redaction and reviewer scope are unchanged", () => {
  it("the former reviewer's historical row is still listed, with the owner withheld and its text as stored", async () => {
    auditRows = [row("e21", "former-run", { question: "[redacted]", contentRedacted: true })];
    asViewer(ME, MY_SCOPE);
    const r = await get("");
    expect(r.body.events).toEqual([
      { id: "e21", action: "approved", byUid: ME, at: "2026-11-03T21:00:21.000Z", collection: "runs", runId: "former-run", question: "[redacted]", trailAvailable: false },
    ]);
  });

  it("the own-run arm does not touch the reviewer scope", () => {
    expect(runOwnerVisibleInGovernance(MY_SCOPE, ME)).toBe(false);
    expect(governanceTrailAccessible({ viewerUid: ME, visibleUserIds: MY_SCOPE, ownerUid: ME })).toBe(true);
    expect(MY_SCOPE).toEqual([ASSIGNER]);
  });

  it("the helper refuses empty identities and other owners", () => {
    expect(governanceTrailAccessible({ viewerUid: "", visibleUserIds: MY_SCOPE, ownerUid: "" })).toBe(false);
    expect(governanceTrailAccessible({ viewerUid: ME, visibleUserIds: MY_SCOPE, ownerUid: "" })).toBe(false);
    expect(governanceTrailAccessible({ viewerUid: ME, visibleUserIds: MY_SCOPE, ownerUid: FORMER })).toBe(false);
    expect(governanceTrailAccessible({ viewerUid: ME, visibleUserIds: MY_SCOPE, ownerUid: ASSIGNER })).toBe(true);
  });
});
