/**
 * Project Foundation, Phase 6C — PATCH /api/user/projects/{projectId} (rename) tests.
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
import { PATCH } from "@/app/api/user/projects/[projectId]/route";

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
    status: "active",
    createdByUserId: UID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/user/projects/${PROJECT_ID}`, {
    method: "PATCH",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function callPatch(body?: unknown, projectId = PROJECT_ID) {
  const res = await PATCH(buildRequest(body), { params: { projectId } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  globalEnabled = true;
  canaryUidsRaw = undefined;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject(), documentUpdateTime: CURRENT_UPDATE_TIME });
  mockedUpdateProjectFields.mockResolvedValue({ status: "updated", documentUpdateTime: Timestamp.fromMillis(1_800_000_000_000) });
  mockedWriteProjectEvent.mockResolvedValue(undefined);
});

describe("auth + rollout gate", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(401);
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("feature off -> dark, no Project access attempted", async () => {
    globalEnabled = false;
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("projects_disabled");
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("exact canary uid -> available", async () => {
    globalEnabled = false;
    canaryUidsRaw = UID;
    const { res } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
  });
});

describe("body validation", () => {
  it("SECURITY: unknown field rejected outright", async () => {
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN, workspaceId: "personal-someone-else" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("invalid name -> 400", async () => {
    const { res, json } = await callPatch({ name: "", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_project_name");
  });

  it("missing/invalid expectedUpdateTime -> 400", async () => {
    const { res, json } = await callPatch({ name: "X" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_update_time");
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });
});

describe("own vs. foreign/malformed Project — concealed 404", () => {
  it("own Project renames successfully", async () => {
    const { res, json } = await callPatch({ name: "New Name", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
    expect(json.project.name).toBe("New Name");
  });

  it("foreign Project -> concealed 404 project_not_found", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "workspace_mismatch" });
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });

  it("malformed Project -> concealed 404, same errorCode as foreign", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "malformed" });
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("project_not_found");
  });

  it("archived Project may still be renamed — no status-transition restriction on rename", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ status: "archived" }), documentUpdateTime: CURRENT_UPDATE_TIME });
    const { res } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
  });
});

describe("OCC", () => {
  it("stale expectedUpdateTime -> 409 conflict, update never attempted", async () => {
    const staleToken = { seconds: 1, nanoseconds: 0 };
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: staleToken });
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("conflict");
    expect(mockedUpdateProjectFields).not.toHaveBeenCalled();
  });

  it("SECURITY: the conflict response never echoes the Project's actual current state", async () => {
    const staleToken = { seconds: 1, nanoseconds: 0 };
    const { json } = await callPatch({ name: "X", expectedUpdateTime: staleToken });
    expect(JSON.stringify(json)).not.toMatch(/My Project/);
  });

  it("a concurrent precondition failure at the actual write (race between resolve and update) also -> 409, mapped the same way as an early-detected stale token", async () => {
    mockedUpdateProjectFields.mockResolvedValue({ status: "precondition_failed" });
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(409);
    expect(json.errorCode).toBe("conflict");
  });

  it("uses Firestore's native updateTime as the precondition passed to updateProjectFields, never ProjectV1.updatedAt", async () => {
    await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    const callArgs = mockedUpdateProjectFields.mock.calls[0][0];
    expect(callArgs.expectedUpdateTime).toEqual(CURRENT_UPDATE_TIME);
  });
});

describe("events", () => {
  it("EVENT FAILURE SAFETY: rename still succeeds when the project_renamed event fails internally", async () => {
    mockedWriteProjectEvent.mockResolvedValue(undefined); // real contract: never rejects
    const { res, json } = await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "project_renamed" }));
  });

  it("a canonical update failure never attempts to write a success event", async () => {
    mockedUpdateProjectFields.mockResolvedValue({ status: "update_failed" });
    await callPatch({ name: "X", expectedUpdateTime: TOKEN });
    expect(mockedWriteProjectEvent).not.toHaveBeenCalled();
  });
});
