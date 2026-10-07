/**
 * TEAM_EXPORT_E2_B — `GET /api/workspaces/[ws]/runs/[runId]/exports/[exportId]`.
 *
 * Stop condition (owner, fixed):
 *   Every Team member who currently has research.read can retrieve an existing
 *   historical export only when their current plan permits advanced export
 *   access and the export's frozen governance state permits access. Retrieval
 *   creates no new export record or version and renders only the frozen record.
 *
 * Fakes record every call so each claim is asserted on what happened, not on
 * what the route returned: which document paths were read, whether any export
 * write helper was invoked, exactly which record object reached the renderer,
 * and who the audit row names.
 */

let exportEnabled = true;
let docxEnabled = false;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_RESEARCH_EXPORT_ENABLED() {
    return exportEnabled;
  },
  get ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED() {
    return docxEnabled;
  },
  ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED: false,
}));

const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedGetExport = jest.fn();
const exportWrites = { create: jest.fn(), ready: jest.fn(), failed: jest.fn(), supersede: jest.fn() };
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  getAdaptiveExportRecord: (...a: unknown[]) => mockedGetExport(...a),
  // Present only so a regression that starts writing is observable.
  createAdaptiveExportRecord: (...a: unknown[]) => exportWrites.create(...a),
  markAdaptiveExportReady: (...a: unknown[]) => exportWrites.ready(...a),
  markAdaptiveExportFailed: (...a: unknown[]) => exportWrites.failed(...a),
  supersedeOlderAdaptiveExports: (...a: unknown[]) => exportWrites.supersede(...a),
}));
const mockedEntitlements = jest.fn();
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: (...a: unknown[]) => mockedEntitlements(...a) }));
const mockedRender = jest.fn();
jest.mock("@/lib/pdf/renderAdaptiveResearchPdf", () => ({ renderAdaptiveResearchExport: (...a: unknown[]) => mockedRender(...a) }));
const mockedAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({ writeAdaptiveExportAdminAuditEvent: (...a: unknown[]) => mockedAudit(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const readPaths: string[] = [];
const runDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        readPaths.push(`${name}/${id}`);
        const data = name === "runs" ? runDocs.get(id) : undefined;
        return { exists: !!data, data: () => data };
      },
      // Any write is a test failure: retrieval must never write a run document.
      set: () => {
        throw new Error("unexpected write");
      },
      update: () => {
        throw new Error("unexpected write");
      },
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]/route";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const WS = "ws-1";
const RUN = "run-1";
const EXP = "exp-3";
const UID = "caller-uid";
const CREATOR_UID = "creator-uid";
const BYTES = Buffer.from("%PDF-SENTINEL-BYTES");
/** A canonically valid Team run (validateTeamRunRowShape requires a Timestamp createdAt). */
const teamRun = (over: Record<string, unknown> = {}) => ({ userId: CREATOR_UID, workspaceId: WS, projectId: null, createdAt: Timestamp.fromMillis(1_700_000_000_000), ...over });

type Role = "owner" | "admin" | "member" | "reviewer" | "viewer";
const grant = (role: Role, capabilities: readonly string[] = ROLE_CAPABILITIES[role]) => ({
  granted: true,
  workspace: { id: WS, type: "team", name: "WS" },
  membership: { uid: UID, role },
  capabilities,
});

function frozenRecord(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportId: EXP,
    runId: RUN,
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 3,
    format: "pdf",
    artifactStatus: "ready",
    createdAt: "2026-09-02T11:00:00.000Z",
    createdBy: CREATOR_UID,
    generatedBy: { displayName: "Creator", maskedEmail: "cr***@x.example" },
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    classification: "internal",
    reportSnapshot: { question: "FROZEN-QUESTION" },
    exportMetadata: { fileHash: "f".repeat(64) },
    ...over,
  };
}

let record: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  exportEnabled = true;
  docxEnabled = false;
  readPaths.length = 0;
  runDocs.clear();
  // The CURRENT run state deliberately differs from the frozen record (rejected,
  // different question) so any read of current state would show.
  runDocs.set(RUN, teamRun({ question: "CURRENT-QUESTION", governanceStatus: "blocked" }));
  record = frozenRecord();
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedAccess.mockImplementation(async (args: { uid: string; workspaceId: string }) =>
    args.uid === UID && args.workspaceId === WS ? grant("viewer") : { granted: false, reason: "membership_not_found" }
  );
  mockedGetProject.mockResolvedValue({ status: "found", project: { id: "p1", workspaceId: WS } });
  mockedGetExport.mockImplementation(async (runId: string, exportId: string) =>
    runId === RUN && exportId === EXP ? { ok: true, record } : { ok: false, reason: "not_found" }
  );
  mockedEntitlements.mockResolvedValue({ planId: "full" });
  mockedRender.mockResolvedValue({ bytes: BYTES });
  mockedAudit.mockResolvedValue({ status: "recorded" });
});

async function download(exportId = EXP, workspaceId = WS, runId = RUN) {
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}/exports/${exportId}`), {
    params: { workspaceId, runId, exportId },
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  return { status: res.status, headers: res.headers, json: isJson ? await res.json() : null, bytes: isJson ? null : Buffer.from(await res.arrayBuffer()) };
}

function expectNoExportWrites() {
  for (const fn of Object.values(exportWrites)) expect(fn).not.toHaveBeenCalled();
}
function expectNoTargetIO() {
  expect(readPaths).toEqual([]);
  expect(mockedGetProject).not.toHaveBeenCalled();
  expect(mockedGetExport).not.toHaveBeenCalled();
  expect(mockedRender).not.toHaveBeenCalled();
}

describe("stop condition — every current research.read holder, current plan, frozen governance", () => {
  it.each(Object.keys(ROLE_CAPABILITIES) as Role[])("%s (holds research.read) downloads the frozen export", async (role) => {
    expect(ROLE_CAPABILITIES[role]).toContain("research.read");
    mockedAccess.mockResolvedValue(grant(role));
    const r = await download();
    expect(r.status).toBe(200);
    expect(r.bytes?.equals(BYTES)).toBe(true);
  });

  it("reviewer and viewer lack exports.create and are STILL allowed: the capability axis is research.read", async () => {
    for (const role of ["reviewer", "viewer"] as const) {
      expect(ROLE_CAPABILITIES[role]).not.toContain("exports.create");
      mockedAccess.mockResolvedValue(grant(role));
      expect((await download()).status).toBe(200);
    }
  });

  it("a caller WITHOUT research.read is refused before any target I/O, even holding exports.create", async () => {
    mockedAccess.mockResolvedValue(grant("member", ["workspace.read", "exports.create"]));
    const r = await download();
    expect(r.status).toBe(403);
    expect(r.json?.errorCode).toBe("insufficient_capability");
    expectNoTargetIO();
  });

  it("the CURRENT plan decides: a free plan is refused (plan_not_entitled), and nothing is rendered", async () => {
    mockedEntitlements.mockResolvedValue({ planId: "free" });
    const r = await download();
    expect(r.status).toBe(403);
    expect(r.json?.errorCode).toBe("plan_not_entitled");
    expect(mockedRender).not.toHaveBeenCalled();
    expect(mockedEntitlements).toHaveBeenCalledWith(UID);
  });

  it.each([
    ["milestone2 rejected", { family: "milestone2", kind: "rejected", isOwnerOverride: false }],
    ["legacy blocked", { family: "legacy", status: "blocked" }],
  ])("FROZEN governance decides: %s is refused even though the caller is entitled", async (_l, status) => {
    record = frozenRecord({ governanceStatusAtExport: status });
    const r = await download();
    expect(r.status).toBe(403);
    expect(r.json?.errorCode).toBe("governance_state_blocked");
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it("the CURRENT run governance is not consulted: frozen approved + current run blocked -> downloadable", async () => {
    expect(runDocs.get(RUN)?.governanceStatus).toBe("blocked");
    expect((await download()).status).toBe(200);
  });

  it("creator identity is not authority: a non-creator downloads; the audit names the CURRENT caller", async () => {
    expect(UID).not.toBe(record.createdBy);
    expect((await download()).status).toBe(200);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    expect(mockedAudit.mock.calls[0][0]).toMatchObject({ action: "adaptive_export_regenerated", actorUid: UID, exportId: EXP, runId: RUN, reportVersion: 3 });
    expect(mockedAudit.mock.calls[0][0].actorUid).not.toBe(CREATOR_UID);
  });

  it("a former member — including the export's creator — is concealed by admission", async () => {
    mockedIdentity.mockResolvedValue({ status: "authenticated", uid: CREATOR_UID });
    const r = await download();
    expect(r.status).toBe(404);
    expectNoTargetIO();
  });
});

describe("retrieval creates nothing and renders only the frozen record", () => {
  it("no export record/version write, and the renderer receives the exact frozen record object", async () => {
    await download();
    expectNoExportWrites();
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(mockedRender.mock.calls[0][0]).toBe(record);
    expect(mockedGetExport).toHaveBeenCalledWith(RUN, EXP);
  });

  it("the run document is read only for its binding, and current run content never reaches the output", async () => {
    const r = await download();
    expect(readPaths).toEqual([`runs/${RUN}`]);
    expect(r.bytes?.toString()).not.toContain("CURRENT-QUESTION");
  });

  it("the STORED format is rendered even when its per-format flag is off today", async () => {
    docxEnabled = false;
    record = frozenRecord({ format: "docx" });
    const r = await download();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("wordprocessingml");
    expect(r.headers.get("content-disposition")).toContain(".docx");
  });

  it.each(["ready", "superseded"])("artifactStatus %s is downloadable", async (status) => {
    record = frozenRecord({ artifactStatus: status });
    expect((await download()).status).toBe(200);
  });

  it.each(["generating", "failed"])("artifactStatus %s is refused with 409 and not rendered", async (status) => {
    record = frozenRecord({ artifactStatus: status });
    const r = await download();
    expect(r.status).toBe(409);
    expect(r.json?.errorCode).toBe("export_not_ready");
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it("an audit failure does not turn a rendered download into an error", async () => {
    mockedAudit.mockRejectedValue(new Error("audit down"));
    const r = await download();
    expect(r.status).toBe(200);
    expect(r.bytes?.equals(BYTES)).toBe(true);
  });

  it("a render failure is a 500, with no audit row", async () => {
    mockedRender.mockRejectedValue(new Error("boom"));
    const r = await download();
    expect(r.status).toBe(500);
    expect(r.json?.errorCode).toBe("regeneration_failed");
    expect(mockedAudit).not.toHaveBeenCalled();
  });
});

describe("ordering, concealment and binding", () => {
  it.each(["a/b", "..", ".", " exp", "exp\u0000"])("a malformed exportId %j is concealed before any I/O", async (bad) => {
    const r = await download(bad);
    expect(r.status).toBe(404);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });

  it("a non-member is concealed with zero target I/O", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await download();
    expect(r.status).toBe(404);
    expectNoTargetIO();
  });

  it("the master flag is concealed until authorization: a non-member sees no flag-specific answer", async () => {
    exportEnabled = false;
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const denied = await download();
    exportEnabled = true;
    const deniedOn = await download();
    expect(denied).toEqual(deniedOn);
  });

  it("the master flag off -> concealed for an authorized caller, with no target I/O", async () => {
    exportEnabled = false;
    const r = await download();
    expect(r.status).toBe(404);
    expect(r.json?.errorCode).toBe("run_not_found");
    expectNoTargetIO();
  });

  it("a run bound to ANOTHER Workspace is concealed and its exports never read", async () => {
    runDocs.set(RUN, teamRun({ workspaceId: "ws-other" }));
    const r = await download();
    expect(r.status).toBe(404);
    expect(mockedGetExport).not.toHaveBeenCalled();
  });

  it("a run filed in a Project of another Workspace is concealed", async () => {
    runDocs.set(RUN, teamRun({ projectId: "p-foreign" }));
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "p-foreign", workspaceId: "ws-other" } });
    const r = await download();
    expect(r.status).toBe(404);
    expect(mockedGetExport).not.toHaveBeenCalled();
  });

  it("an export id that does not exist under this run is concealed exactly like a missing run", async () => {
    const missing = await download("exp-missing");
    runDocs.delete(RUN);
    const missingRun = await download();
    expect(missing).toEqual(missingRun);
    expect(missing.status).toBe(404);
  });

  it("a record whose own runId/exportId disagree with the address is concealed and not rendered", async () => {
    record = frozenRecord({ runId: "run-other" });
    const r = await download();
    expect(r.status).toBe(404);
    expect(mockedRender).not.toHaveBeenCalled();
  });

  it("an export read failure is 503, not a concealed 404", async () => {
    mockedGetExport.mockResolvedValue({ ok: false, reason: "read_failed" });
    const r = await download();
    expect(r.status).toBe(503);
  });

  it("unauthenticated -> 401 with no I/O", async () => {
    mockedIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const r = await download();
    expect(r.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });
});
