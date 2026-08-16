/**
 * Project Foundation, Phase 6C — updateTimeToken tests.
 */

import { Timestamp } from "firebase-admin/firestore";
import { validateUpdateTimeToken, serializeUpdateTimeToken, updateTimeTokensEqual } from "@/lib/projects/updateTimeToken";

describe("validateUpdateTimeToken", () => {
  it("accepts a well-formed token", () => {
    const result = validateUpdateTimeToken({ seconds: 100, nanoseconds: 500 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timestamp.seconds).toBe(100);
      expect(result.timestamp.nanoseconds).toBe(500);
    }
  });

  it("rejects null", () => {
    expect(validateUpdateTimeToken(null)).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects a non-object", () => {
    expect(validateUpdateTimeToken("not an object")).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects missing seconds", () => {
    expect(validateUpdateTimeToken({ nanoseconds: 0 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects missing nanoseconds", () => {
    expect(validateUpdateTimeToken({ seconds: 0 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects a non-integer seconds value", () => {
    expect(validateUpdateTimeToken({ seconds: 1.5, nanoseconds: 0 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects a negative seconds value", () => {
    expect(validateUpdateTimeToken({ seconds: -1, nanoseconds: 0 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects a negative nanoseconds value", () => {
    expect(validateUpdateTimeToken({ seconds: 0, nanoseconds: -1 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("rejects nanoseconds exceeding 999,999,999", () => {
    expect(validateUpdateTimeToken({ seconds: 0, nanoseconds: 1_000_000_000 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("accepts nanoseconds at exactly the maximum", () => {
    const result = validateUpdateTimeToken({ seconds: 0, nanoseconds: 999_999_999 });
    expect(result.ok).toBe(true);
  });

  it("accepts seconds: 0, nanoseconds: 0", () => {
    const result = validateUpdateTimeToken({ seconds: 0, nanoseconds: 0 });
    expect(result.ok).toBe(true);
  });

  it("rejects a string seconds value even if numeric-looking", () => {
    expect(validateUpdateTimeToken({ seconds: "100", nanoseconds: 0 })).toEqual({ ok: false, reason: "invalid_update_time" });
  });

  it("reconstructs the exact Timestamp via the (seconds, nanoseconds) constructor, never a lossy millisecond path", () => {
    // A value that would be truncated if ever routed through Timestamp.fromMillis().
    const result = validateUpdateTimeToken({ seconds: 100, nanoseconds: 123_456_789 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timestamp).toEqual(new Timestamp(100, 123_456_789));
    }
  });
});

describe("serializeUpdateTimeToken", () => {
  it("round-trips losslessly through validate -> serialize", () => {
    const original = { seconds: 42, nanoseconds: 987_654_321 };
    const validated = validateUpdateTimeToken(original);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(serializeUpdateTimeToken(validated.timestamp)).toEqual(original);
    }
  });
});

describe("updateTimeTokensEqual", () => {
  it("true for identical seconds/nanoseconds", () => {
    expect(updateTimeTokensEqual(new Timestamp(1, 2), new Timestamp(1, 2))).toBe(true);
  });

  it("false when seconds differ", () => {
    expect(updateTimeTokensEqual(new Timestamp(1, 2), new Timestamp(2, 2))).toBe(false);
  });

  it("false when only nanoseconds differ", () => {
    expect(updateTimeTokensEqual(new Timestamp(1, 2), new Timestamp(1, 3))).toBe(false);
  });

  it("MUTATION CHECK: a millisecond-only comparison would wrongly treat these as equal — the real function must not", () => {
    const a = new Timestamp(1, 1_000); // 1.000001s
    const b = new Timestamp(1, 2_000); // 1.000002s — same millisecond, different nanosecond
    const millisEqual = a.toMillis() === b.toMillis();
    expect(millisEqual).toBe(true); // proves the two ARE millis-equal
    expect(updateTimeTokensEqual(a, b)).toBe(false); // the real function still distinguishes them
  });
});
