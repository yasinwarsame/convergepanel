import { isValidProjectNameClientSide, PROJECT_NAME_MAX_LENGTH } from "@/lib/projects/projectNameClient";

describe("isValidProjectNameClientSide — mirrors validateProjectName()'s exact server bounds", () => {
  it("accepts a normal name", () => {
    expect(isValidProjectNameClientSide("My Project")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidProjectNameClientSide("")).toBe(false);
  });

  it("rejects whitespace-only (trims to empty)", () => {
    expect(isValidProjectNameClientSide("   ")).toBe(false);
  });

  it("accepts exactly 1 character after trim", () => {
    expect(isValidProjectNameClientSide("A")).toBe(true);
  });

  it(`accepts exactly ${PROJECT_NAME_MAX_LENGTH} characters`, () => {
    expect(isValidProjectNameClientSide("x".repeat(PROJECT_NAME_MAX_LENGTH))).toBe(true);
  });

  it(`rejects ${PROJECT_NAME_MAX_LENGTH + 1} characters`, () => {
    expect(isValidProjectNameClientSide("x".repeat(PROJECT_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects control characters even inside an otherwise-valid name", () => {
    expect(isValidProjectNameClientSide("A\x07B")).toBe(false);
  });

  it("control-character check applies to the TRIMMED value, matching server order", () => {
    // Leading/trailing whitespace is trimmed first; a name that's otherwise
    // fine after trimming should pass even with surrounding whitespace.
    expect(isValidProjectNameClientSide("  Valid Name  ")).toBe(true);
  });

  it("accepts Unicode", () => {
    expect(isValidProjectNameClientSide("プロジェクト 🚀")).toBe(true);
  });
});
