/**
 * Projects Foundation, Phase 6B — validateProjectName() tests.
 */

import { validateProjectName } from "@/lib/projects/projectName";

describe("validateProjectName", () => {
  it("accepts an ordinary name", () => {
    expect(validateProjectName("Q3 Vendor Review")).toEqual({ ok: true, name: "Q3 Vendor Review" });
  });

  it("rejects non-string input", () => {
    expect(validateProjectName(42)).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("rejects an empty string", () => {
    expect(validateProjectName("")).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("rejects a whitespace-only string", () => {
    expect(validateProjectName("   ")).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("accepts a single character (post-trim minimum)", () => {
    expect(validateProjectName("A")).toEqual({ ok: true, name: "A" });
  });

  it("accepts exactly 200 characters (post-trim)", () => {
    const name = "A".repeat(200);
    expect(validateProjectName(name)).toEqual({ ok: true, name });
  });

  it("rejects 201 characters (post-trim)", () => {
    const name = "A".repeat(201);
    expect(validateProjectName(name)).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("trims leading/trailing whitespace and returns the normalized value", () => {
    expect(validateProjectName("  My Project  ")).toEqual({ ok: true, name: "My Project" });
  });

  it("length limit is measured AFTER trimming, not before", () => {
    // 200 real characters plus surrounding whitespace that would push the
    // raw length over 200 — must still pass, since only the trimmed form
    // counts.
    const padded = `  ${"A".repeat(200)}  `;
    expect(validateProjectName(padded)).toEqual({ ok: true, name: "A".repeat(200) });
  });

  it("accepts ordinary Unicode", () => {
    expect(validateProjectName("Café Renovation 咖啡馆")).toEqual({ ok: true, name: "Café Renovation 咖啡馆" });
  });

  it("rejects a control character", () => {
    expect(validateProjectName("My\x00Project")).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("rejects a DEL character", () => {
    expect(validateProjectName("My\x7fProject")).toEqual({ ok: false, reason: "invalid_project_name" });
  });

  it("does not lowercase the name", () => {
    const result = validateProjectName("MixedCase Name");
    expect(result).toEqual({ ok: true, name: "MixedCase Name" });
  });

  it("does not slugify the name", () => {
    const result = validateProjectName("A Name / With Slashes");
    expect(result).toEqual({ ok: true, name: "A Name / With Slashes" });
  });

  it("two distinct calls with the same display value both succeed independently — no implicit deduplication at this layer", () => {
    const first = validateProjectName("Duplicate Name");
    const second = validateProjectName("Duplicate Name");
    expect(first).toEqual({ ok: true, name: "Duplicate Name" });
    expect(second).toEqual({ ok: true, name: "Duplicate Name" });
  });
});
