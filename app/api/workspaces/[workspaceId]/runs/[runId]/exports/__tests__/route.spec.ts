/**
 * TEAM_EXPORT_E2_A — `GET /api/workspaces/{workspaceId}/runs/{runId}/exports`.
 *
 * Identity, the Team run access resolver, the Project reader and the export-list
 * helper are mocked at their module boundaries. The capability matrix, the row
 * validator, the response family and the runId syntax guard are REAL.
 *
 * The Firestore fake is PATH-AWARE and throws on any path the test did not
 * configure, and it records every read so ordering invariants can be asserted
 * against actual I/O rather than HTTP status.
 */

let mockExportFlagEnabled = true;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_RESEARCH_EXPORT_ENABLED() {
    return mockExportFlagEnabled;
  },
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedListExports = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({ listAdaptiveExportRecords: (...a: unknown[]) => mockedListExports(...a) }));

const runDocs = new Map<string, Record<string, unknown>>();
let runGetThrows = false;
let adminDbAvailable = true;
const readPaths: string[] = [];
/** E2-A must write nothing at all. */
const writeAttempts: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!adminDbAvailable) return null;
    const record = (op: string) => async () => {
      writeAttempts.push(op);
      throw new Error(`unexpected write: ${op}`);
    };
    return {
      collection: (name: string) => ({
        doc: (id: string) => {
          const path = `${name}/${id}`;
          return {
            id,
            __path: path,
            get: async () => {
              readPaths.push(path);
              if (name !== "runs") throw new Error(`test fake: unconfigured collection "${name}"`);
              if (runGetThrows) throw new Error("firestore down");
              return { exists: runDocs.has(id), data: () => runDocs.get(id) };
            },
            set: record(`${path}.set`),
            update: record(`${path}.update`),
            collection: (sub: string) => ({
              doc: (subId: string) => ({ id: subId, __path: `${path}/${sub}/${subId}` }),
              orderBy: () => {
                readPaths.push(`${path}/${sub}[query]`);
                throw new Error("test fake: export subcollection queried directly; the route must use listAdaptiveExportRecords");
              },
            }),
          };
        },
      }),
      batch: () => ({ set: record("batch.set"), commit: record("batch.commit") }),
      runTransaction: record("runTransaction"),
    };
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/exports/route";
import { FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const UID = "member-b";
const CREATOR_UID = "member-a";
const WS = FIXTURE_WORKSPACE_ID;
const OTHER_WS = "bOtherWorkspaceAutoId9999";
const RUN = FIXTURE_RUN_ID;
const RUN_PATH = `runs/${RUN}`;
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const teamRun = (overrides: Record<string, unknown> = {}) => fullTeamRunData({ createdAt: CREATED, ...overrides });

const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer") => ({
  granted: true,
  workspace: { schemaVersion: 1, id: WS, type: "team", name: "WS", ownerUserId: "owner-1", createdByUserId: "owner-1", createdAt: CREATED, updatedAt: CREATED },
  membership: { uid: UID, role },
  capabilities: ROLE_CAPABILITIES[role],
});

/** A record shaped like what E1 persists — created by SOMEONE ELSE, so `createdBy` can never be the thing granting access. */
const exportRecord = (reportVersion: number, over: Record<string, unknown> = {}) => ({
  exportId: `exp-${reportVersion}`,
  reportVersion,
  schemaId: "comparison_matrix",
  schemaFamily: "milestone2",
  format: "pdf",
  artifactStatus: "ready",
  createdAt: "2026-09-02T11:00:00.000Z",
  createdBy: CREATOR_UID,
  governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
  classification: "internal",
  // Present in Firestore and deliberately NOT projected into the DTO. The
  // sentinels are what make E2A-S8 falsifiable: `"milestone2"` could never
  // serve, because `schemaFamily` legitimately carries that exact value.
  reportSnapshot: { question: "SENTINEL_FROZEN_QUESTION", milestone2: { schemaId: "comparison_matrix", result: { executiveSummary: "SENTINEL_REPORT_BODY" } } },
  exportMetadata: { exportId: `exp-${reportVersion}`, runId: RUN, schemaVersion: 1, fileHash: "f".repeat(64), requestingUser: CREATOR_UID },
  ...over,
});

const submit = async (query = "", workspaceId = WS, runId = RUN) => {
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}/exports${query}`), { params: { workspaceId, runId } });
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  readPaths.length = 0;
  writeAttempts.length = 0;
  runGetThrows = false;
  adminDbAvailable = true;
  mockExportFlagEnabled = true;
  runDocs.set(RUN, teamRun());
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedAccess.mockResolvedValue(grant("member"));
  mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: WS } });
  mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3), exportRecord(2)], hasMore: false });
});

/**
 * E2A-S1/S2 — NO target-associated I/O: the run, the Project and the export
 * subcollection. R1 found the Project read outside this boundary, so a mutation
 * moving `getProject` above admission survived; it is counted now.
 */
const expectNoTargetIO = () => {
  expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
  expect(mockedGetProject).not.toHaveBeenCalled();
  expect(mockedListExports).not.toHaveBeenCalled();
};
const noWrites = () => expect(writeAttempts).toEqual([]);
// R1 FROZEN RULE: for a positive "this caller CAN list/read X" test, `status 200`
// is insufficient — it survives an empty list, and a universal predicate over an
// empty array is vacuously true. Every positive read asserts non-emptiness by
// CARDINALITY and by IDENTITY.
const expectTheFixtureHistory = (r: { status: number; json: { exports: { exportId: string }[] } }) => {
  expect(r.status).toBe(200);
  expect(r.json.exports).toHaveLength(2);
  expect(r.json.exports.map((e) => e.exportId)).toEqual(["exp-3", "exp-2"]);
};

describe("E2-A — the authorized list path", () => {
  it("returns metadata newest-first for an authorized Research reader", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.runId).toBe(RUN);
    expect(r.json.exports.map((e: { reportVersion: number }) => e.reportVersion)).toEqual([3, 2]);
    expect(r.json.hasMore).toBe(false);
    expect(r.json.nextCursor).toBeNull();
    expect(mockedListExports).toHaveBeenCalledWith(RUN, { limit: undefined, beforeReportVersion: undefined });
    // the control that gives the negative I/O assertions meaning
    expect(readPaths).toEqual([RUN_PATH]);
  });

  it("E2A-S8 the response exposes only the approved metadata DTO", async () => {
    const r = await submit();
    const blob = JSON.stringify(r.json);
    // Sentinel VALUES from the REAL persisted shape, not type names —
    // `"milestone2"` could never serve, since `schemaFamily` legitimately
    // carries it. R1 removed an earlier `governanceRecord` fixture: the export
    // record has no such key, so those sentinels proved nothing.
    for (const sentinel of ["SENTINEL_FROZEN_QUESTION", "SENTINEL_REPORT_BODY"]) {
      expect(blob).not.toContain(sentinel);
    }
    expect(blob).not.toContain("reportSnapshot");
    // the projection is an allow-list: exactly these keys
    expect(Object.keys(r.json.exports[0]).sort()).toEqual(
      ["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "fileHash", "format", "governanceStatusAtExport", "hashAlgorithm", "hashReproducible", "reportVersion", "schemaFamily", "schemaId"].sort()
    );
  });

  it("E2A-S7 a current reader who did NOT create the exports receives them", async () => {
    // R1 P2: the previous version could not fail under the violation it named.
    // `status 200` survives an EMPTY list, `[].every(...)` is true, and
    // comparing two module constants can never fail — so a route filtering by
    // `createdBy === uid` passed this test. Cardinality and identity now carry
    // the proof: if the records a non-creator is entitled to disappear, this
    // fails, which is exactly what the mutation does.
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(2);
    expect(r.json.exports.map((e: { exportId: string }) => e.exportId)).toEqual(["exp-3", "exp-2"]);
    expect(r.json.exports.map((e: { reportVersion: number }) => e.reportVersion)).toEqual([3, 2]);
    // supporting evidence only: every returned record was created by someone else
    expect(r.json.exports.map((e: { createdBy: string }) => e.createdBy)).toEqual([CREATOR_UID, CREATOR_UID]);
  });

  it("E2A-S9 a role with research.read but WITHOUT exports.create can list", async () => {
    for (const role of ["reviewer", "viewer"] as const) {
      expect(ROLE_CAPABILITIES[role]).toContain("research.read");
      expect(ROLE_CAPABILITIES[role]).not.toContain("exports.create");
      mockedAccess.mockResolvedValue(grant(role));
      // Not merely "not refused": this role receives the actual history.
      expectTheFixtureHistory(await submit());
    }
  });

  it("E2-A writes nothing and never queries the export subcollection directly", async () => {
    await submit();
    noWrites();
    expect(readPaths.filter((p) => p.includes("[query]"))).toEqual([]);
  });

  it("surfaces hasMore/nextCursor from the helper", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(9), exportRecord(8)], hasMore: true });
    const r = await submit();
    expect(r.json.hasMore).toBe(true);
    expect(r.json.nextCursor).toBe(8);
  });

  it("a TYPED persistence failure is 503 — one contract for one condition", async () => {
    // R1 INFORMATIONAL-3: this used to be 500 while the identical condition on
    // the run read was 503. Normalised on the helper's own typed reasons.
    for (const reason of ["firestore_unavailable", "read_failed"]) {
      mockedListExports.mockResolvedValue({ ok: false, reason });
      const r = await submit();
      expect(r.status).toBe(503);
      expect(r.json.errorCode).toBe("team_workspace_unavailable");
    }
  });

  it("an UNRECOGNISED failure reason still falls through to 500 — not laundered into 503", async () => {
    // The mapping is deliberately not a blanket catch: an unexpected reason must
    // not be dressed up as infrastructure unavailability.
    mockedListExports.mockResolvedValue({ ok: false, reason: "something_new" });
    const r = await submit();
    expect(r.status).toBe(500);
    expect(r.json.errorCode).toBe("list_failed");
  });
});

describe("E2-A — authority ordering", () => {
  it("E2A-S1 a NON-MEMBER performs zero run, Project and export I/O", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    expectNoTargetIO();
    noWrites();
  });

  it("E2A-S2 a caller WITHOUT research.read performs zero run, Project and export I/O", async () => {
    // a real role lacking research.read does not exist today, so the capability
    // set is narrowed directly — the route reads `capabilities`, not the label.
    mockedAccess.mockResolvedValue({ ...grant("member"), capabilities: ["workspace.read"] });
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("insufficient_capability");
    expectNoTargetIO();
    noWrites();
  });

  it("signed out: denied before any authority work", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const r = await submit();
    expect(r.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });

  it("E2A-S6 CROSS-WORKSPACE: a run bound to another Workspace is concealed and never listed", async () => {
    runDocs.set(RUN, teamRun({ workspaceId: OTHER_WS }));
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it("E2A-S6 a Project belonging to another Workspace is concealed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: OTHER_WS } });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a same-Workspace Project lists normally", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: WS } });
    expectTheFixtureHistory(await submit());
  });

  it("E2A-S6/S7 a FORMER member — including the export creator — is concealed", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: CREATOR_UID });
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const r = await submit();
    expect(r.status).toBe(404);
    expectNoTargetIO();
  });

  it("a missing run is concealed; an infrastructure failure is 503", async () => {
    runDocs.clear();
    expect((await submit()).json.errorCode).toBe("run_not_found");
    runDocs.set(RUN, teamRun());
    runGetThrows = true;
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
  });
});

describe("E2A-S3 — the flag is concealed until authorization", () => {
  const bothStates = async () => {
    mockExportFlagEnabled = false;
    const off = await submit();
    expect(mockedListExports).not.toHaveBeenCalled();
    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
    mockExportFlagEnabled = true;
    const on = await submit();
    return { off, on };
  };

  it("a non-member cannot distinguish the flag state", async () => {
    mockedAccess.mockImplementation(async () => ({ granted: false, reason: "membership_not_found" }));
    const { off, on } = await bothStates();
    expect(off.status).toBe(on.status);
    expect(off.json).toEqual(on.json);
    expect(off.json.errorCode).toBe("team_workspace_not_found");
  });

  it("a caller without research.read cannot distinguish the flag state", async () => {
    mockedAccess.mockImplementation(async () => ({ ...grant("member"), capabilities: ["workspace.read"] }));
    const { off, on } = await bothStates();
    expect(off.json).toEqual(on.json);
    expect(off.json.errorCode).toBe("insufficient_capability");
  });

  it("POSITIVE CONTROL: an authorized reader DOES observe the flag", async () => {
    mockExportFlagEnabled = false;
    const off = await submit();
    expect(off.status).toBe(404);
    expect(off.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
    expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
  });
});

describe("E2A-S4 — pagination validity is concealed until authorization", () => {
  it("an unauthorized caller cannot distinguish pagination validity", async () => {
    mockedAccess.mockImplementation(async () => ({ granted: false, reason: "membership_not_found" }));
    const valid = await submit("?cursor=5&limit=10");
    const malformed = await submit("?cursor=not-a-number&limit=abc");
    const absurd = await submit("?cursor=-Infinity&limit=99999999");
    expect(malformed.json).toEqual(valid.json);
    expect(absurd.json).toEqual(valid.json);
    for (const r of [valid, malformed, absurd]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.json)).not.toMatch(/cursor|limit|pagination/i);
    }
    expectNoTargetIO();
  });
});

describe("E2A-S10 — this route forwards paging and owns no paging policy", () => {
  const lastCall = () => mockedListExports.mock.calls[mockedListExports.mock.calls.length - 1][1] as { limit?: number; beforeReportVersion?: number };

  it("passes cursor and limit through, truncating fractions", async () => {
    await submit("?cursor=7&limit=10");
    expect(lastCall()).toEqual({ limit: 10, beforeReportVersion: 7 });
    await submit("?cursor=7.9&limit=10.5");
    expect(lastCall()).toEqual({ limit: 10, beforeReportVersion: 7 });
  });

  it("omits non-finite values so the helper applies its own defaults and clamp", async () => {
    await submit("?cursor=abc&limit=xyz");
    expect(lastCall()).toEqual({ limit: undefined, beforeReportVersion: undefined });
    await submit("?limit=Infinity");
    expect(lastCall()).toEqual({ limit: undefined, beforeReportVersion: undefined });
  });

  it("does not clamp in the route — the helper owns the [1,50] bound (one implementation)", async () => {
    await submit("?limit=99999");
    expect(lastCall().limit).toBe(99999);
  });

  it("lists every persisted status without Team-only filtering", async () => {
    mockedListExports.mockResolvedValue({
      ok: true,
      records: [exportRecord(4, { artifactStatus: "ready" }), exportRecord(3, { artifactStatus: "superseded" }), exportRecord(2, { artifactStatus: "failed" }), exportRecord(1, { artifactStatus: "generating" })],
      hasMore: false,
    });
    const r = await submit();
    expect(r.json.exports.map((e: { artifactStatus: string }) => e.artifactStatus)).toEqual(["ready", "superseded", "failed", "generating"]);
  });

  it("omits the hash trio when no fileHash was persisted", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(1, { exportMetadata: { exportId: "exp-1", runId: RUN, schemaVersion: 1, requestingUser: CREATOR_UID } })], hasMore: false });
    const item = (await submit()).json.exports[0];
    expect(item.fileHash).toBeUndefined();
    expect(item.hashReproducible).toBeUndefined();
  });

  it("marks docx as non-reproducible and pdf as reproducible", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(2, { format: "docx" }), exportRecord(1, { format: "pdf" })], hasMore: false });
    const items = (await submit()).json.exports;
    expect(items[0].hashReproducible).toBe(false);
    expect(items[1].hashReproducible).toBe(true);
  });
});

describe("E2A-S5 — runId syntax is load-bearing for path integrity", () => {
  // Probed against the real @google-cloud/firestore: an EVEN component count is
  // ACCEPTED and redirects the reference — `otherRun/exports/exp-1` resolves to
  // `runs/otherRun/exports/exp-1`, a real document location. Odd counts throw.
  it.each(["a/b/c", "otherRun/exports/exp-1", "..", " x", "a/b", ""])("rejects %p before any document path is constructed", async (bad) => {
    const r = await submit("", WS, bad);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(readPaths).toEqual([]);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });

  it("a valid runId is accepted (isolating the syntax gate as the cause)", async () => {
    expectTheFixtureHistory(await submit());
  });
});

describe("E2-A — infrastructure and identity envelopes", () => {
  it("§7 an unavailable database short-circuits before ALL authority work and all target I/O", async () => {
    adminDbAvailable = false;
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
    noWrites();
  });

  it("§10 identity failures keep DISTINCT pre-auth vocabulary, so a later edit cannot collapse them into an oracle", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const missing = await submit();
    expect(missing.status).toBe(401);
    expect(missing.json.errorCode).toBe("unauthorized");

    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "invalid_token" });
    const invalid = await submit();
    expect(invalid.status).toBe(401);
    expect(invalid.json.errorCode).toBe("auth_error");

    // distinct codes, and neither reveals anything about the target
    expect(missing.json.errorCode).not.toBe(invalid.json.errorCode);
    expectNoTargetIO();
  });
});
