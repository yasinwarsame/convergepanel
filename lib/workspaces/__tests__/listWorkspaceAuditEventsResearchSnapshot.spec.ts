/**
 * ADD-TO-TEAM-PROJECT §P — `workspace_research_snapshot_created` through the
 * Workspace Audit reader, the client parser, and the audit UI. Same in-memory
 * `FakeQuery` shape as `listWorkspaceAuditEvents.spec.ts`, reduced to what
 * this event needs. Every "never surfaced" assertion sits next to the
 * positive control that the row IS emitted with its allowed fields.
 */

class FakeTimestamp {
  constructor(
    public seconds: number,
    public nanoseconds: number = 0
  ) {}
  toDate() {
    return new Date(this.seconds * 1000);
  }
}
const DOC_ID_SENTINEL = Symbol("documentId");
jest.mock("firebase-admin/firestore", () => ({
  Timestamp: FakeTimestamp,
  FieldPath: { documentId: () => DOC_ID_SENTINEL },
}));

const mockResolveWorkspaceReviewerDisplayNames = jest.fn();
jest.mock("../workspaceReviewerIdentity", () => ({
  resolveWorkspaceReviewerDisplayNames: (...args: unknown[]) => mockResolveWorkspaceReviewerDisplayNames(...args),
}));

type FakeDoc = { id: string; data: Record<string, unknown> };
let eventDocs: FakeDoc[] = [];
class FakeQuery {
  constructor(private filters: Array<{ field: string; value: unknown }> = []) {}
  where(field: string, _op: string, value: unknown) {
    return new FakeQuery([...this.filters, { field, value }]);
  }
  orderBy() {
    return this;
  }
  startAfter() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    const docs = eventDocs.filter((d) => this.filters.every((f) => d.data[f.field] === f.value));
    return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
  }
}
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return { collection: () => new FakeQuery() };
  },
}));
const mockedLogger = { warn: jest.fn(), error: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockedLogger }));

const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));

import { readFileSync } from "fs";
import { join } from "path";
import { listWorkspaceAuditEvents } from "../listWorkspaceAuditEvents";
import { buildWorkspaceMembershipEventDocData } from "../workspaceMembershipEvents";
import { fetchWorkspaceAuditEvents } from "@/lib/client/workspaceTeamClient";

const WS_ID = "ws-1";
const SOURCE_RUN_ID = "run-personal-source";

function researchEvent(id: string, overrides: Record<string, unknown> = {}): FakeDoc {
  return {
    id,
    data: {
      eventType: "workspace_research_snapshot_created",
      workspaceId: WS_ID,
      actorUid: "actor-1",
      projectId: "proj-1",
      projectName: "Due Diligence",
      runId: "run-team-copy",
      runQuestion: "What is the capital of Kenya?",
      at: new FakeTimestamp(1723600000, 0),
      ...overrides,
    },
  };
}

beforeEach(() => {
  eventDocs = [];
  mockedLogger.warn.mockClear();
  mockResolveWorkspaceReviewerDisplayNames.mockReset();
  mockResolveWorkspaceReviewerDisplayNames.mockResolvedValue(new Map([["actor-1", "Amina"]]));
});

describe("writer builder", () => {
  it("builds the research-shaped doc with exactly the allowed identity and no source run id", () => {
    const at = new FakeTimestamp(1, 0) as never;
    const doc = buildWorkspaceMembershipEventDocData({ eventType: "workspace_research_snapshot_created", actorUid: "a", workspaceId: WS_ID, projectId: "p", projectName: "P", runId: "run-copy", runQuestion: "Q?", at });
    expect(doc).toEqual({ eventType: "workspace_research_snapshot_created", actorUid: "a", workspaceId: WS_ID, projectId: "p", projectName: "P", runId: "run-copy", runQuestion: "Q?", at });
    expect(Object.keys(doc)).not.toContain("sourceRunId");
    expect(Object.keys(doc)).not.toContain("targetUid");
  });
});

describe("reader", () => {
  it("emits the research event as a research-shaped DTO exposing project.name and research.question ONLY", async () => {
    eventDocs = [researchEvent("e1")];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toEqual([
      { eventType: "workspace_research_snapshot_created", occurredAt: new Date(1723600000 * 1000).toISOString(), actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, research: { question: "What is the capital of Kenya?" } },
    ]);
    const json = JSON.stringify(r.items);
    expect(json).not.toContain("proj-1");
    expect(json).not.toContain("run-team-copy");
    expect(json).not.toContain("actor-1");
    expect(json).not.toContain(SOURCE_RUN_ID);
  });

  it("skips (never repairs) a research row missing projectName, runId, or runQuestion — positive control: the complete row is emitted", async () => {
    eventDocs = [researchEvent("ok"), researchEvent("no-name", { projectName: "" }), researchEvent("no-run", { runId: undefined }), researchEvent("no-q", { runQuestion: 5 })];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(1);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(3);
  });

  it("a research row is never forced through the member schema (no targetUid/previousRole needed)", async () => {
    eventDocs = [researchEvent("e1")];
    const r = await listWorkspaceAuditEvents({ workspaceId: WS_ID, limit: 20 });
    if (r.status !== "ok") throw new Error("expected ok");
    expect("target" in r.items[0]).toBe(false);
    expect("previousRole" in r.items[0]).toBe(false);
  });
});

describe("client parser", () => {
  const ok = (events: unknown[]) => ({ ok: true, status: 200, json: async () => ({ ok: true, events, hasMore: false }) });
  const item = { eventType: "workspace_research_snapshot_created", occurredAt: "2026-09-13T00:00:00.000Z", actor: { displayName: "Amina" }, project: { name: "Due Diligence" }, research: { question: "Q?" } };

  it("accepts the research DTO", async () => {
    mockedAuthedFetch.mockResolvedValue(ok([item]));
    const r = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS_ID });
    expect(r).toEqual({ status: "ok", events: [item], hasMore: false });
  });

  it("rejects a research DTO missing research.question or project.name (positive control above)", async () => {
    for (const bad of [{ ...item, research: {} }, { ...item, research: { question: "" } }, { ...item, project: { name: "" } }, { ...item, research: undefined }]) {
      mockedAuthedFetch.mockResolvedValue(ok([bad]));
      expect(await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS_ID })).toEqual({ status: "error" });
    }
  });
});

describe("audit UI", () => {
  const source = readFileSync(join(__dirname, "..", "..", "..", "components", "workspace", "WorkspaceAuditLogShell.tsx"), "utf8");

  it("renders a dedicated 'Research added from Personal' branch BEFORE the final else, using research.question and project.name", () => {
    const branch = source.indexOf('event.eventType === "workspace_research_snapshot_created"');
    const finalElse = source.indexOf("Role changed");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(finalElse);
    expect(source).toMatch(/Research added from Personal/);
    expect(source).toMatch(/event\.research\.question/);
    expect(source).toMatch(/event\.project\.name/);
    expect(source).not.toMatch(/event\.runId|event\.projectId|sourceRunId/);
  });
});
