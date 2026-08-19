import { isValidProjectIdSyntaxClientSide } from "@/lib/projects/projectIdClient";

describe("isValidProjectIdSyntaxClientSide", () => {
  it("accepts a well-formed id", () => {
    expect(isValidProjectIdSyntaxClientSide("abc123XYZ")).toBe(true);
  });

  it.each([
    ["non-string", 123],
    ["empty string", ""],
    ["leading/trailing whitespace", " abc "],
    ["control character", "abc\x00"],
    ["contains a slash", "abc/def"],
    ["exactly '.'", "."],
    ["exactly '..'", ".."],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isValidProjectIdSyntaxClientSide(value)).toBe(false);
  });

  it("rejects an id exceeding the 1500-byte Firestore document-id limit", () => {
    expect(isValidProjectIdSyntaxClientSide("a".repeat(1501))).toBe(false);
  });

  it("accepts an id at exactly the 1500-byte limit", () => {
    expect(isValidProjectIdSyntaxClientSide("a".repeat(1500))).toBe(true);
  });
});
