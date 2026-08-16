/**
 * Project Foundation, Phase 6C — toProjectSummaryDto() tests.
 */

import { Timestamp } from "firebase-admin/firestore";
import { toProjectSummaryDto } from "@/lib/projects/projectDto";
import type { ProjectV1 } from "@/lib/projects/types";

function project(overrides: Partial<ProjectV1> = {}): ProjectV1 {
  return {
    schemaVersion: 1,
    id: "proj-1",
    workspaceId: "personal-owner-1",
    name: "My Project",
    status: "active",
    createdByUserId: "owner-1",
    createdAt: Timestamp.fromMillis(1_000_000),
    updatedAt: Timestamp.fromMillis(2_000_000),
    ...overrides,
  };
}

describe("toProjectSummaryDto", () => {
  it("exposes exactly the intended browser-facing fields — never more", () => {
    const dto = toProjectSummaryDto(project(), Timestamp.fromMillis(3_000_000));
    expect(Object.keys(dto).sort()).toEqual(["createdAt", "id", "name", "status", "updateTime", "updatedAt"].sort());
  });

  it("never includes workspaceId", () => {
    const dto = toProjectSummaryDto(project(), Timestamp.fromMillis(3_000_000));
    expect(dto).not.toHaveProperty("workspaceId");
    expect(JSON.stringify(dto)).not.toMatch(/workspaceId/);
  });

  it("never includes createdByUserId", () => {
    const dto = toProjectSummaryDto(project(), Timestamp.fromMillis(3_000_000));
    expect(dto).not.toHaveProperty("createdByUserId");
  });

  it("never includes schemaVersion", () => {
    const dto = toProjectSummaryDto(project(), Timestamp.fromMillis(3_000_000));
    expect(dto).not.toHaveProperty("schemaVersion");
  });

  it("id/name/status pass through unchanged", () => {
    const dto = toProjectSummaryDto(project({ id: "proj-x", name: "Renamed", status: "archived" }), Timestamp.fromMillis(3_000_000));
    expect(dto.id).toBe("proj-x");
    expect(dto.name).toBe("Renamed");
    expect(dto.status).toBe("archived");
  });

  it("createdAt/updatedAt are ISO strings derived from the ProjectV1 Timestamps", () => {
    const dto = toProjectSummaryDto(project(), Timestamp.fromMillis(3_000_000));
    expect(dto.createdAt).toBe(new Date(1_000_000).toISOString());
    expect(dto.updatedAt).toBe(new Date(2_000_000).toISOString());
  });

  it("SECURITY/CORRECTNESS: updateTime comes from the supplied documentUpdateTime parameter, NEVER derived from project.updatedAt — even when they differ", () => {
    const p = project({ updatedAt: Timestamp.fromMillis(2_000_000) });
    const documentUpdateTime = Timestamp.fromMillis(9_999_000); // deliberately different from p.updatedAt
    const dto = toProjectSummaryDto(p, documentUpdateTime);
    expect(dto.updateTime).toEqual({ seconds: documentUpdateTime.seconds, nanoseconds: documentUpdateTime.nanoseconds });
    expect(dto.updateTime).not.toEqual({ seconds: p.updatedAt.seconds, nanoseconds: p.updatedAt.nanoseconds });
  });

  it("updateTime is a losslessly-serialized {seconds, nanoseconds} pair, not a Timestamp instance or a string", () => {
    const documentUpdateTime = new Timestamp(42, 123_456_789);
    const dto = toProjectSummaryDto(project(), documentUpdateTime);
    expect(dto.updateTime).toEqual({ seconds: 42, nanoseconds: 123_456_789 });
    expect(typeof dto.updateTime.seconds).toBe("number");
    expect(typeof dto.updateTime.nanoseconds).toBe("number");
  });
});
