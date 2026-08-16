/**
 * Project Foundation, Phase 6C — POST /api/user/projects/{projectId}/restore tests.
 * Mirror image of the archive route tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

let globalEnabled = false;
let canaryUidsRaw: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get PROJECTS_ENABLED() {
    return globalEnabled;
  },
  get PROJECTS_CANARY_UIDS() {
    return canaryUidsRaw;
  },
}));

const mockedResolveProjectForOwner = jest.fn();
jest.mock("@/lib/projects/resolveProjectForOwner", () => ({
  resolveProjectForOwner: (...args: any[]) => mockedResolveProjectForOwner(...args),
}));

const mockedUpdateProjectFields = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  updateProjectFields: (...args: any[]) => mockedUpdateProjectFields(...args),
}));

const mockedWriteProjectEvent = jest.fn();
jest.mock("@/lib/projects/projectEvents", () => ({
  writeProjectEvent: (...args: any[]) => mockedWriteProjectEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST } from "@/app/api/user/projects/[projectId]/restore/route";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const PROJECT_ID = "proj-1";
const NOW = Timestamp.now();
const CURRENT_UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);
const TOKEN = { seconds: CURRENT_UPDATE_TIME.seconds, nanoseconds: CURRENT_UPDATE_TIME.nanoseconds };

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    workspaceId: WS_ID,
    name: "My Project",
    status: "archived",
    createdByUserId: UID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/user/projects/${PROJECT_ID}/restore`, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callRestore(body?: unknown, projectId = PROJECT_ID) {
  const res = await POST(buildRequest(body), { params: { projectId } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  globalEnabled = true;
  canaryUidsRaw = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ status: "archived" }), documentUpdateTime: CURRENT_UPDATE_TIME });
  mockedUpdateProjectFields.mockResolvedValue({ status: "updated", documentUpdateTime: Timestamp.fromMillis(1_800_000_000_000) });
  mockedWriteProjectEvent.mockResolvedValue(undefined);
});

describe("auth + rollout gate", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(401);
  });

  it("feature off -> dark", async () => {
    globalEnabled = false;
    const { res, json } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });
});

describe("valid archived -> active", () => {
  it("succeeds and returns the active DTO", async () => {
    const { res, json } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.project.status).toBe("active");
  });

  it("passes status: active to updateProjectFields", async () => {
    await callRestore({ expectedUpdateTime: TOKEN });
    expect(mockedUpdateProjectFields).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "active" }) }));
  });

  it("writes a project_restored event after success", async () => {
    await callRestore({ expectedUpdateTime: TOKEN });
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "project_restored" }));
  });
});

describe("stale token", () => {
  it("stale expectedUpdateTime -> 409 conflict, no write attempted", async () => {
    const staleToken = { seconds: 1, nanoseconds: 0 };
    const { res, json } = await callRestore({ expectedUpdateTime: staleToken });
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("conflict");
    expect(mockedUpdateProjectFields).not.toHaveBeenCalled();
  });
});

describe("repeated restore — invalid transition, not silently idempotent", () => {
  it("already-active Project, even with a fresh-looking token, is rejected as an invalid transition, not treated as success", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ status: "active" }), documentUpdateTime: CURRENT_UPDATE_TIME });
    const { res, json } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("invalid_project_status_transition");
    expect(mockedUpdateProjectFields).not.toHaveBeenCalled();
  });
});

describe("foreign Project concealment", () => {
  it("foreign Project -> concealed 404", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "workspace_mismatch" });
    const { res, json } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });
});

describe("body validation", () => {
  it("SECURITY: unknown field rejected outright", async () => {
    const { res, json } = await callRestore({ expectedUpdateTime: TOKEN, name: "Sneaky" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
  });
});

describe("events", () => {
  it("EVENT FAILURE SAFETY: restore still succeeds when the event write fails internally", async () => {
    mockedWriteProjectEvent.mockResolvedValue(undefined);
    const { res } = await callRestore({ expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
  });

  it("a canonical restore failure never attempts to write a success event", async () => {
    mockedUpdateProjectFields.mockResolvedValue({ status: "update_failed" });
    await callRestore({ expectedUpdateTime: TOKEN });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });

  it("PROPERTY B: the route awaits the event write before returning — the response does not settle until the event attempt's own promise settles", async () => {
    let resolveEvent!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    mockedWriteProjectEvent.mockReturnValue(deferred);

    let settled = false;
    const restorePromise = callRestore({ expectedUpdateTime: TOKEN }).then((result) => {
      settled = true;
      return result;
    });

    // Macrotask flush, not a fixed microtask-tick count — see the
    // create-route test's identical comment for why this matters.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false); // the route must still be awaiting the event attempt here

    resolveEvent();
    const { res } = await restorePromise;
    expect(settled).toBe(true);
    expect(res.status).toBe(200);
  });
});
