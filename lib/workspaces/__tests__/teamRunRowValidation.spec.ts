import { Timestamp } from "firebase-admin/firestore";
import { validateTeamRunRowShape } from "../teamRunRowValidation";

const W = "ws-team-1";
const NOW = Timestamp.now();

function validRow(overrides: Record<string, unknown> = {}) {
  return { userId: "uid-1", workspaceId: W, projectId: null, createdAt: NOW, question: "q", selectedModels: [], ...overrides };
}

describe("validateTeamRunRowShape", () => {
  it("valid row, projectId null -> ok, projectId null", () => {
    const r = validateTeamRunRowShape(validRow(), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: null });
  });

  it("valid row, projectId assigned -> ok, projectId string", () => {
    const r = validateTeamRunRowShape(validRow({ projectId: "proj-1" }), W);
    expect(r).toEqual({ ok: true, userId: "uid-1", workspaceId: W, projectId: "proj-1" });
  });

  it("missing userId -> not ok", () => {
    const data = validRow();
    delete (data as any).userId;
    expect(validateTeamRunRowShape(data, W)).toEqual({ ok: false });
  });

  it("empty userId -> not ok", () => {
    expect(validateTeamRunRowShape(validRow({ userId: "" }), W)).toEqual({ ok: false });
  });

  it("workspaceId mismatch -> not ok", () => {
    expect(validateTeamRunRowShape(validRow({ workspaceId: "some-other-ws" }), W)).toEqual({ ok: false });
  });

  it("workspaceId missing -> not ok", () => {
    const data = validRow();
    delete (data as any).workspaceId;
    expect(validateTeamRunRowShape(data, W)).toEqual({ ok: false });
  });

  it("malformed createdAt (plain object, not a real Timestamp) -> not ok", () => {
    expect(validateTeamRunRowShape(validRow({ createdAt: { seconds: 1, nanoseconds: 0 } }), W)).toEqual({ ok: false });
  });

  it("missing createdAt -> not ok", () => {
    const data = validRow();
    delete (data as any).createdAt;
    expect(validateTeamRunRowShape(data, W)).toEqual({ ok: false });
  });

  it("projectId absent -> not ok (Team has no legacy-Unfiled compatibility)", () => {
    const data = validRow();
    delete (data as any).projectId;
    expect(validateTeamRunRowShape(data, W)).toEqual({ ok: false });
  });

  it("projectId malformed (empty string) -> not ok", () => {
    expect(validateTeamRunRowShape(validRow({ projectId: "" }), W)).toEqual({ ok: false });
  });

  it("projectId malformed (wrong type) -> not ok", () => {
    expect(validateTeamRunRowShape(validRow({ projectId: 42 }), W)).toEqual({ ok: false });
  });
});
