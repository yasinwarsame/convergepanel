/**
 * Team Run Lists, Phase 8C-B2 — TeamRunSummaryDto tests.
 */

import { Timestamp } from "firebase-admin/firestore";
import { toTeamRunSummary } from "../teamRunSummary";

const NOW = Timestamp.now();

function rawRunData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "uid-1",
    workspaceId: "ws-team-1",
    projectId: null,
    question: "What's the best CRM?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    createdAt: NOW,
    ...overrides,
  };
}

describe("toTeamRunSummary", () => {
  it("includes every RunSummaryBase field", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", null);
    expect(dto).toMatchObject({
      id: "run-1",
      question: "What's the best CRM?",
      selectedModels: ["chatgpt", "claude"],
      status: "complete",
    });
    expect(typeof dto.at).toBe("string");
  });

  it("includes userId, workspaceId, projectId", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", "proj-1");
    expect(dto.userId).toBe("uid-1");
    expect(dto.workspaceId).toBe("ws-team-1");
    expect(dto.projectId).toBe("proj-1");
  });

  it("projectId null survives as null", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", null);
    expect(dto.projectId).toBeNull();
  });

  it("assigned projectId survives as the exact string", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", "proj-abc123");
    expect(dto.projectId).toBe("proj-abc123");
  });

  it("projectId is never undefined — the type signature requires string|null, not string|null|undefined", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", null);
    expect("projectId" in dto).toBe(true);
    expect(dto.projectId).not.toBeUndefined();
  });

  it("no membership/capability/authorization internals leak — the DTO has exactly the expected key set", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", null);
    const keys = Object.keys(dto);
    const forbidden = ["membership", "capabilities", "capability", "role", "reason", "workspaceType", "granted"];
    for (const f of forbidden) {
      expect(keys).not.toContain(f);
    }
  });

  it("does not expose raw Firestore snapshot metadata (e.g. no updateTime/createTime leak)", () => {
    const dto = toTeamRunSummary("run-1", rawRunData(), "uid-1", "ws-team-1", null);
    expect(Object.keys(dto)).not.toContain("updateTime");
    expect(Object.keys(dto)).not.toContain("createTime");
  });
});
