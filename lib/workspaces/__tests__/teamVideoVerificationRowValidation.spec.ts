import { Timestamp } from "firebase-admin/firestore";
import { validateTeamVideoVerificationRowShape } from "../teamVideoVerificationRowValidation";

const W = "ws-team-1";
const NOW = Timestamp.now();

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: "uid-1",
    workspaceId: W,
    projectId: null,
    type: "video_verification",
    timestamp: NOW,
    fileName: "clip.mp4",
    verdict: "authentic_captured",
    ...overrides,
  };
}

describe("validateTeamVideoVerificationRowShape", () => {
  it("valid row, projectId null -> ok, projectId null", () => {
    const r = validateTeamVideoVerificationRowShape(validRow(), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: null });
  });

  it("valid row, projectId assigned -> ok, projectId string", () => {
    const r = validateTeamVideoVerificationRowShape(validRow({ projectId: "proj-1" }), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: "proj-1" });
  });

  it("missing userId -> not ok", () => {
    const data = validRow();
    delete (data as any).userId;
    expect(validateTeamVideoVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("empty userId -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ userId: "" }), W)).toEqual({ ok: false });
  });

  it("malformed userId (wrong type) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ userId: 42 }), W)).toEqual({ ok: false });
  });

  it("workspaceId missing -> not ok", () => {
    const data = validRow();
    delete (data as any).workspaceId;
    expect(validateTeamVideoVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("workspaceId empty -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ workspaceId: "" }), W)).toEqual({ ok: false });
  });

  it("workspaceId mismatch (wrong Workspace) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ workspaceId: "some-other-ws" }), W)).toEqual({ ok: false });
  });

  it("projectId field missing -> not ok (Team has no legacy-Unfiled compatibility)", () => {
    const data = validRow();
    delete (data as any).projectId;
    expect(validateTeamVideoVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("projectId undefined value (field present) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ projectId: undefined }), W)).toEqual({ ok: false });
  });

  it("projectId malformed (empty string) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ projectId: "" }), W)).toEqual({ ok: false });
  });

  it("projectId malformed (wrong type) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ projectId: 42 }), W)).toEqual({ ok: false });
  });

  it("timestamp missing -> not ok", () => {
    const data = validRow();
    delete (data as any).timestamp;
    expect(validateTeamVideoVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("timestamp malformed (plain object, not a real Timestamp) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ timestamp: { seconds: 1, nanoseconds: 0 } }), W)).toEqual({ ok: false });
  });

  it("timestamp wrong type (string) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ timestamp: "2026-01-01T00:00:00.000Z" }), W)).toEqual({ ok: false });
  });

  it("type missing -> not ok", () => {
    const data = validRow();
    delete (data as any).type;
    expect(validateTeamVideoVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("type wrong (claim_verification, cross-collection confusion) -> not ok", () => {
    expect(validateTeamVideoVerificationRowShape(validRow({ type: "claim_verification" }), W)).toEqual({ ok: false });
  });
});
