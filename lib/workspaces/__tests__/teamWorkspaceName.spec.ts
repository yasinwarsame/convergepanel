/**
 * Team Workspace Core Foundation, Phase 8B — validateTeamWorkspaceName()
 * tests. Structural mirror of lib/projects/__tests__/projectName.spec.ts.
 * Max length recorded here: 200 characters (post-trim).
 */

import { validateTeamWorkspaceName } from "@/lib/workspaces/teamWorkspaceName";

describe("validateTeamWorkspaceName", () => {
  it("accepts an ordinary name", () => {
    expect(validateTeamWorkspaceName("Acme Research Team")).toEqual({ ok: true, name: "Acme Research Team" });
  });

  it("rejects non-string input", () => {
    expect(validateTeamWorkspaceName(42)).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("rejects an empty string", () => {
    expect(validateTeamWorkspaceName("")).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("rejects a whitespace-only string", () => {
    expect(validateTeamWorkspaceName("   ")).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("accepts a single character (post-trim minimum)", () => {
    expect(validateTeamWorkspaceName("A")).toEqual({ ok: true, name: "A" });
  });

  it("accepts exactly 200 characters (post-trim)", () => {
    const name = "A".repeat(200);
    expect(validateTeamWorkspaceName(name)).toEqual({ ok: true, name });
  });

  it("rejects 201 characters (post-trim)", () => {
    const name = "A".repeat(201);
    expect(validateTeamWorkspaceName(name)).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("trims leading/trailing whitespace and returns the normalized value", () => {
    expect(validateTeamWorkspaceName("  Acme Team  ")).toEqual({ ok: true, name: "Acme Team" });
  });

  it("length limit is measured AFTER trimming, not before", () => {
    const padded = `  ${"A".repeat(200)}  `;
    expect(validateTeamWorkspaceName(padded)).toEqual({ ok: true, name: "A".repeat(200) });
  });

  it("accepts ordinary Unicode", () => {
    expect(validateTeamWorkspaceName("Café Team 咖啡馆")).toEqual({ ok: true, name: "Café Team 咖啡馆" });
  });

  it("rejects a control character", () => {
    expect(validateTeamWorkspaceName("My\x00Team")).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("rejects a DEL character", () => {
    expect(validateTeamWorkspaceName("My\x7fTeam")).toEqual({ ok: false, reason: "invalid_team_workspace_name" });
  });

  it("does not lowercase the name", () => {
    expect(validateTeamWorkspaceName("MixedCase Name")).toEqual({ ok: true, name: "MixedCase Name" });
  });

  it("does not slugify the name", () => {
    expect(validateTeamWorkspaceName("A Name / With Slashes")).toEqual({ ok: true, name: "A Name / With Slashes" });
  });

  it("two distinct calls with the same display value both succeed independently — duplicate Workspace names are allowed; name is never an identity", () => {
    const first = validateTeamWorkspaceName("Duplicate Name");
    const second = validateTeamWorkspaceName("Duplicate Name");
    expect(first).toEqual({ ok: true, name: "Duplicate Name" });
    expect(second).toEqual({ ok: true, name: "Duplicate Name" });
  });
});
