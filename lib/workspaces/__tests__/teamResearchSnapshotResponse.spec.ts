/**
 * ADD-TO-TEAM-PROJECT §R — shared response contract.
 */

import { buildTeamResearchDetailHref, buildTeamResearchSnapshotDto, mapTeamResearchSnapshotErrorCode, snapshotTooLargeResponse, sourceResearchNotFoundConcealedResponse, validateTeamResearchSnapshotDto } from "../teamResearchSnapshotResponse";

const ids = { workspaceId: "ws 1", projectId: "p/1", runId: "run-9" };

describe("buildTeamResearchDetailHref", () => {
  it("Z39 — points at the existing Team research detail route with every segment percent-encoded", () => {
    expect(buildTeamResearchDetailHref(ids)).toBe("/workspace/team/ws%201/projects/p%2F1/research/run-9");
  });
});

describe("DTO round-trip", () => {
  it("a server-built DTO validates for the destination it was built for", () => {
    const dto = buildTeamResearchSnapshotDto({ status: "created", ...ids });
    expect(dto).toEqual({ ok: true, status: "created", runId: "run-9", workspaceId: "ws 1", projectId: "p/1", href: "/workspace/team/ws%201/projects/p%2F1/research/run-9" });
    expect(validateTeamResearchSnapshotDto(dto, { workspaceId: "ws 1", projectId: "p/1" })).toEqual(dto);
    expect(validateTeamResearchSnapshotDto(buildTeamResearchSnapshotDto({ status: "already_exists", ...ids }), { workspaceId: "ws 1", projectId: "p/1" })?.status).toBe("already_exists");
  });

  it("rejects a DTO naming a different destination than requested, a foreign href, an unknown status, or a blank run id", () => {
    const dto = buildTeamResearchSnapshotDto({ status: "created", ...ids });
    expect(validateTeamResearchSnapshotDto(dto, { workspaceId: "ws-other", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto(dto, { workspaceId: "ws 1", projectId: "p-other" })).toBeNull();
    expect(validateTeamResearchSnapshotDto({ ...dto, href: "/workspace/team/ws%201/projects/p%2F1/research/run-8" }, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto({ ...dto, href: "https://evil.example/x" }, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto({ ...dto, status: "moved" }, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto({ ...dto, runId: "" }, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto({ ...dto, ok: false }, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
    expect(validateTeamResearchSnapshotDto(null, { workspaceId: "ws 1", projectId: "p/1" })).toBeNull();
  });
});

describe("error responses", () => {
  it("source_not_found is a 404 that names no predicate", () => {
    const r = sourceResearchNotFoundConcealedResponse();
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, errorCode: "source_not_found", message: "This research could not be found." });
  });

  it("snapshot_too_large is a 413", () => {
    expect(snapshotTooLargeResponse().status).toBe(413);
    expect(snapshotTooLargeResponse().body.errorCode).toBe("snapshot_too_large");
  });

  it("maps known codes verbatim and everything else to internal_error", () => {
    expect(mapTeamResearchSnapshotErrorCode("project_archived")).toBe("project_archived");
    expect(mapTeamResearchSnapshotErrorCode("source_not_found")).toBe("source_not_found");
    expect(mapTeamResearchSnapshotErrorCode("something_new")).toBe("internal_error");
    expect(mapTeamResearchSnapshotErrorCode(undefined)).toBe("internal_error");
    expect(mapTeamResearchSnapshotErrorCode("network_error")).toBe("internal_error");
  });
});
