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

  describe("owner", () => {
    it("has every capability, including ownership.transfer and admins.manage", () => {
      expect(roleHasCapability("owner", "ownership.transfer")).toBe(true);
      expect(roleHasCapability("owner", "admins.manage")).toBe(true);
      expect(roleHasCapability("owner", "reviews.override")).toBe(true);
      expect(roleHasCapability("owner", "reviews.manage")).toBe(true);
      expect(roleHasCapability("owner", "reviews.submit")).toBe(true);
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
    it("cannot submit reviews by default", () => {
      expect(roleHasCapability("member", "reviews.submit")).toBe(false);
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
    it("cannot export", () => {
      expect(roleHasCapability("reviewer", "exports.create")).toBe(false);
    });
  });

  describe("viewer", () => {
    it("cannot export", () => {
      expect(roleHasCapability("viewer", "exports.create")).toBe(false);
    });
    it("cannot submit reviews", () => {
      expect(roleHasCapability("viewer", "reviews.submit")).toBe(false);
    });
    it("can still read workspace/research/reviews", () => {
      expect(roleHasCapability("viewer", "workspace.read")).toBe(true);
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
