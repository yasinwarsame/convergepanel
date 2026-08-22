import { Timestamp } from "firebase-admin/firestore";
import { validateTeamClaimVerificationRowShape } from "../teamClaimVerificationRowValidation";

const W = "ws-team-1";
const NOW = Timestamp.now();

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    userId: "uid-1",
    workspaceId: W,
    projectId: null,
    type: "claim_verification",
    timestamp: NOW,
    claim: "The sky is blue.",
    verdict: "accurate",
    ...overrides,
  };
}

describe("validateTeamClaimVerificationRowShape", () => {
  it("valid row, projectId null -> ok, projectId null", () => {
    const r = validateTeamClaimVerificationRowShape(validRow(), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: null });
  });

  it("valid row, projectId assigned -> ok, projectId string", () => {
    const r = validateTeamClaimVerificationRowShape(validRow({ projectId: "proj-1" }), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: "proj-1" });
  });

  it("missing userId -> not ok", () => {
    const data = validRow();
    delete (data as any).userId;
    expect(validateTeamClaimVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("malformed userId (wrong type) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ userId: 42 }), W)).toEqual({ ok: false });
  });

  it("empty userId -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ userId: "" }), W)).toEqual({ ok: false });
  });

  it("workspaceId missing -> not ok", () => {
    const data = validRow();
    delete (data as any).workspaceId;
    expect(validateTeamClaimVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("workspaceId malformed (wrong type) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ workspaceId: 42 }), W)).toEqual({ ok: false });
  });

  it("workspaceId mismatch -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ workspaceId: "some-other-ws" }), W)).toEqual({ ok: false });
  });

  it("projectId missing -> not ok (Team has no legacy-Unfiled compatibility)", () => {
    const data = validRow();
    delete (data as any).projectId;
    expect(validateTeamClaimVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("projectId malformed (empty string) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ projectId: "" }), W)).toEqual({ ok: false });
  });

  it("projectId malformed (wrong type) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ projectId: 42 }), W)).toEqual({ ok: false });
  });

  it("timestamp missing -> not ok", () => {
    const data = validRow();
    delete (data as any).timestamp;
    expect(validateTeamClaimVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("timestamp malformed (plain object, not a real Timestamp) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ timestamp: { seconds: 1, nanoseconds: 0 } }), W)).toEqual({ ok: false });
  });

  it("type missing -> not ok", () => {
    const data = validRow();
    delete (data as any).type;
    expect(validateTeamClaimVerificationRowShape(data, W)).toEqual({ ok: false });
  });

  it("type wrong (video_verification, cross-collection confusion) -> not ok", () => {
    expect(validateTeamClaimVerificationRowShape(validRow({ type: "video_verification" }), W)).toEqual({ ok: false });
  });
});
