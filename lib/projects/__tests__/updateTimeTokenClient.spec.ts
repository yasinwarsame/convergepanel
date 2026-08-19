import { isValidUpdateTimeTokenShape } from "@/lib/projects/updateTimeTokenClient";

describe("isValidUpdateTimeTokenShape", () => {
  it("accepts a well-formed token", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 1723600000, nanoseconds: 123456789 })).toBe(true);
  });

  it("accepts zero for both fields", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 0, nanoseconds: 0 })).toBe(true);
  });

  it("accepts the maximum valid nanoseconds (999_999_999)", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 1, nanoseconds: 999_999_999 })).toBe(true);
  });

  it.each([null, undefined, "string", 123, [], true])("rejects non-object %p", (value) => {
    expect(isValidUpdateTimeTokenShape(value)).toBe(false);
  });

  it("rejects missing seconds", () => {
    expect(isValidUpdateTimeTokenShape({ nanoseconds: 0 })).toBe(false);
  });

  it("rejects missing nanoseconds", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 0 })).toBe(false);
  });

  it("rejects non-integer seconds", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 1.5, nanoseconds: 0 })).toBe(false);
  });

  it("rejects negative seconds", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: -1, nanoseconds: 0 })).toBe(false);
  });

  it("rejects non-integer nanoseconds", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 0, nanoseconds: 1.5 })).toBe(false);
  });

  it("rejects negative nanoseconds", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 0, nanoseconds: -1 })).toBe(false);
  });

  it("rejects nanoseconds over 999_999_999", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 0, nanoseconds: 1_000_000_000 })).toBe(false);
  });

  it("rejects string-typed seconds/nanoseconds (e.g. a naively JSON-reshaped value)", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: "1723600000", nanoseconds: "0" })).toBe(false);
  });

  it("rejects NaN/Infinity", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: NaN, nanoseconds: 0 })).toBe(false);
    expect(isValidUpdateTimeTokenShape({ seconds: Infinity, nanoseconds: 0 })).toBe(false);
  });

  it("PRECISION: distinguishes tokens that differ only in nanoseconds — proves the shape check does not discard sub-second precision", () => {
    expect(isValidUpdateTimeTokenShape({ seconds: 100, nanoseconds: 123_000_000 })).toBe(true);
    expect(isValidUpdateTimeTokenShape({ seconds: 100, nanoseconds: 123_000_001 })).toBe(true);
  });
});
