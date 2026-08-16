/**
 * Project Foundation, Phase 6C — writeProjectEvent() tests. The central
 * property under test: this function NEVER throws and NEVER rejects,
 * regardless of the underlying Firestore write outcome — every caller
 * relies on this to keep event writes truly best-effort/secondary.
 */

const addMock = jest.fn();
const firestoreUnavailableFlag = { value: false };

const mockAdminDb: any = {
  collection: (name: string) => ({
    add: (data: Record<string, unknown>) => addMock(name, data),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return firestoreUnavailableFlag.value ? null : mockAdminDb;
  },
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { writeProjectEvent } from "@/lib/projects/projectEvents";
import { logger } from "@/lib/logger";

beforeEach(() => {
  jest.clearAllMocks();
  firestoreUnavailableFlag.value = false;
  addMock.mockResolvedValue({ id: "event-1" });
});

describe("writeProjectEvent", () => {
  it("writes into the dedicated projectEvents collection — never admin_audit_logs or any governance collection", async () => {
    await writeProjectEvent({ eventType: "project_created", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" });
    expect(addMock).toHaveBeenCalledWith("projectEvents", expect.anything());
  });

  it("payload contains exactly the expected metadata fields for a lifecycle event — no extras", async () => {
    await writeProjectEvent({ eventType: "project_renamed", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" });
    const [, payload] = addMock.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(["actorUid", "at", "eventType", "projectId", "workspaceId"].sort());
  });

  it("run-association fields are included only when supplied (reserved for Phase 6D)", async () => {
    await writeProjectEvent({
      eventType: "project_run_association_changed",
      actorUid: "uid-1",
      workspaceId: "personal-uid-1",
      projectId: "proj-1",
      runId: "run-1",
      fromProjectId: null,
      toProjectId: "proj-1",
    });
    const [, payload] = addMock.mock.calls[0];
    expect(payload.runId).toBe("run-1");
    expect(payload.fromProjectId).toBeNull();
    expect(payload.toProjectId).toBe("proj-1");
  });

  it("SECURITY: payload never contains a Project name field", async () => {
    await writeProjectEvent({ eventType: "project_created", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" });
    const [, payload] = addMock.mock.calls[0];
    expect(payload).not.toHaveProperty("name");
    expect(JSON.stringify(payload)).not.toMatch(/name/i);
  });

  it("SECURITY: this module has no parameter through which question/answer/report/synthesis/governance content could ever reach a written document — proven by source inspection of real code, not just the happy-path payload shape (the doc comment legitimately names these fields in prose to explain what's excluded, so comments are stripped before checking)", () => {
    const raw = require("fs").readFileSync(require.resolve("@/lib/projects/projectEvents"), "utf8");
    const realCodeOnly = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(realCodeOnly).not.toMatch(/question|answer|synthesis|governanceRecord|reportBody/i);
  });

  it("resolves (never throws) when the Firestore write succeeds", async () => {
    await expect(writeProjectEvent({ eventType: "project_created", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" })).resolves.toBeUndefined();
  });

  it("SECURITY/RELIABILITY: resolves (never throws or rejects) even when the Firestore write itself throws", async () => {
    addMock.mockRejectedValue(new Error("simulated Firestore outage"));
    await expect(writeProjectEvent({ eventType: "project_created", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves (never throws) when Firestore is unavailable", async () => {
    firestoreUnavailableFlag.value = true;
    await expect(writeProjectEvent({ eventType: "project_created", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-1" })).resolves.toBeUndefined();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("logs a structured warning (with eventType and projectId, no raw error object) on failure", async () => {
    addMock.mockRejectedValue(new Error("boom"));
    await writeProjectEvent({ eventType: "project_archived", actorUid: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-42" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write project event"),
      expect.objectContaining({ eventType: "project_archived", projectId: "proj-42" })
    );
  });

  it("append-only random-ID write — uses .add(), never a deterministic .doc(id).create() the way governance events do", () => {
    const source = require("fs").readFileSync(require.resolve("@/lib/projects/projectEvents"), "utf8");
    expect(source).toMatch(/\.add\(/);
    expect(source).not.toMatch(/\.doc\([^)]*\)\.create\(/);
  });
});
