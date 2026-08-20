/**
 * Phase 8B.2 — the frozen V1 review-capability correction. `reviews.submit`
 * is granted to every role except Viewer (single-role eligibility model,
 * not a second membership role) — actual vote casting additionally
 * requires the pre-existing per-run reviewer assignment, unchanged, tested
 * elsewhere in this codebase (`app/api/teams/adaptive-runs/[runId]/votes`).
 */

import { ROLE_CAPABILITIES, ORDINARY_SETTABLE_ROLES, roleHasCapability } from "@/lib/workspaces/capabilities";
import { WORKSPACE_MEMBERSHIP_ROLES } from "@/lib/workspaces/membershipTypes";

describe("ROLE_CAPABILITIES", () => {
  it("defines a capability set for every frozen V1 role", () => {
    for (const role of WORKSPACE_MEMBERSHIP_ROLES) {
      expect(ROLE_CAPABILITIES[role]).toBeDefined();
      expect(Array.isArray(ROLE_CAPABILITIES[role])).toBe(true);
    }
  });

  it("is deeply frozen — the map and every role's array", () => {
    expect(Object.isFrozen(ROLE_CAPABILITIES)).toBe(true);
    for (const role of WORKSPACE_MEMBERSHIP_ROLES) {
      expect(Object.isFrozen(ROLE_CAPABILITIES[role])).toBe(true);
    }
  });

  /**
   * The exact frozen V1 review matrix (Phase 8B.2 §14), asserted
   * positively AND negatively for every role — a mutation flipping any
   * single cell must fail exactly one row below.
   */
  describe("frozen review-capability matrix", () => {
    it.each([
      ["owner", "reviews.read", true],
      ["owner", "reviews.submit", true],
      ["owner", "reviews.manage", true],
      ["owner", "reviews.override", true],
      ["admin", "reviews.read", true],
      ["admin", "reviews.submit", true],
      ["admin", "reviews.manage", true],
      ["admin", "reviews.override", false],
      ["member", "reviews.read", true],
      ["member", "reviews.submit", true],
      ["member", "reviews.manage", false],
      ["member", "reviews.override", false],
      ["reviewer", "reviews.read", true],
      ["reviewer", "reviews.submit", true],
      ["reviewer", "reviews.manage", false],
      ["reviewer", "reviews.override", false],
      ["viewer", "reviews.read", true],
      ["viewer", "reviews.submit", false],
      ["viewer", "reviews.manage", false],
      ["viewer", "reviews.override", false],
    ] as const)("%s.%s === %s", (role, capability, expected) => {
      expect(roleHasCapability(role, capability)).toBe(expected);
    });
  });

  describe("owner", () => {
    it("has every capability, including ownership.transfer and admins.manage", () => {
      expect(roleHasCapability("owner", "ownership.transfer")).toBe(true);
      expect(roleHasCapability("owner", "admins.manage")).toBe(true);
    });
  });

  describe("admin", () => {
    it("cannot override reviews", () => {
      expect(roleHasCapability("admin", "reviews.override")).toBe(false);
    });
    it("cannot transfer ownership", () => {
      expect(roleHasCapability("admin", "ownership.transfer")).toBe(false);
    });
    it("cannot manage admins (grant/revoke Admin)", () => {
      expect(roleHasCapability("admin", "admins.manage")).toBe(false);
    });
    it("can manage reviews and read audit log", () => {
      expect(roleHasCapability("admin", "reviews.manage")).toBe(true);
      expect(roleHasCapability("admin", "audit.read")).toBe(true);
    });
  });

  describe("member", () => {
    it("is eligible to submit reviews (Phase 8B.2) but cannot manage or override a panel", () => {
      expect(roleHasCapability("member", "reviews.submit")).toBe(true);
      expect(roleHasCapability("member", "reviews.manage")).toBe(false);
      expect(roleHasCapability("member", "reviews.override")).toBe(false);
    });
    it("can read/create/manage projects and research", () => {
      expect(roleHasCapability("member", "projects.create")).toBe(true);
      expect(roleHasCapability("member", "research.create")).toBe(true);
      expect(roleHasCapability("member", "exports.create")).toBe(true);
    });
  });

  describe("reviewer", () => {
    it("can submit reviews but not manage or override them", () => {
      expect(roleHasCapability("reviewer", "reviews.submit")).toBe(true);
      expect(roleHasCapability("reviewer", "reviews.manage")).toBe(false);
      expect(roleHasCapability("reviewer", "reviews.override")).toBe(false);
    });
    it("can read Projects but cannot create, manage, or organize them", () => {
      expect(roleHasCapability("reviewer", "projects.read")).toBe(true);
      expect(roleHasCapability("reviewer", "projects.create")).toBe(false);
      expect(roleHasCapability("reviewer", "projects.manage")).toBe(false);
      expect(roleHasCapability("reviewer", "research.organize")).toBe(false);
    });
    it("cannot export (conservative V1 — Phase 8B.2 §17)", () => {
      expect(roleHasCapability("reviewer", "exports.create")).toBe(false);
    });
  });

  describe("viewer", () => {
    it("cannot export (conservative V1 — Phase 8B.2 §17)", () => {
      expect(roleHasCapability("viewer", "exports.create")).toBe(false);
    });
    it("cannot submit reviews", () => {
      expect(roleHasCapability("viewer", "reviews.submit")).toBe(false);
    });
    it("has no mutation capabilities at all", () => {
      expect(roleHasCapability("viewer", "projects.create")).toBe(false);
      expect(roleHasCapability("viewer", "projects.manage")).toBe(false);
      expect(roleHasCapability("viewer", "research.create")).toBe(false);
      expect(roleHasCapability("viewer", "research.organize")).toBe(false);
      expect(roleHasCapability("viewer", "members.manage")).toBe(false);
    });
    it("can still read workspace/projects/research/reviews", () => {
      expect(roleHasCapability("viewer", "workspace.read")).toBe(true);
      expect(roleHasCapability("viewer", "projects.read")).toBe(true);
      expect(roleHasCapability("viewer", "research.read")).toBe(true);
      expect(roleHasCapability("viewer", "reviews.read")).toBe(true);
    });
  });
});

describe("ORDINARY_SETTABLE_ROLES", () => {
  it("never includes owner", () => {
    expect(ORDINARY_SETTABLE_ROLES).not.toContain("owner");
  });

  it("includes every non-owner role", () => {
    expect([...ORDINARY_SETTABLE_ROLES].sort()).toEqual(["admin", "member", "reviewer", "viewer"].sort());
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ORDINARY_SETTABLE_ROLES)).toBe(true);
  });
});
