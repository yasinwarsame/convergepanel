/**
 * Addendum 3, m6 — the purpose-built JSON Schema subset validator has its own tests.
 * Each keyword has a passing control next to a failing case, so a validator that accepted
 * everything (or rejected everything) fails here. The request-contract corpus (positive and
 * negative examples, cross-type, limit, visible-content and control-character cases) runs in
 * apiOpenapiRequestContract.spec.ts against the real openapi.yaml schema.
 */
import { codePoints, compile, dereference, jsonEqual } from "./support/jsonSchemaSubset";

const v = (schema: unknown) => compile(schema);

describe("jsonSchemaSubset: keywords", () => {
  it.each<[string, unknown, unknown, unknown]>([
    ["type string", { type: "string" }, "x", 1],
    ["type integer", { type: "integer" }, 2, 2.5],
    ["type number accepts integers", { type: "number" }, 2, "2"],
    ["type array of types", { type: ["string", "null"] }, null, 0],
    ["type object excludes arrays", { type: "object" }, {}, []],
    ["const", { const: "claim" }, "claim", "Claim"],
    ["enum", { enum: ["a", "b"] }, "b", "c"],
    ["minLength counts code points", { type: "string", minLength: 2 }, "\u{1F600}\u{1F600}", "\u{1F600}"],
    ["maxLength counts code points", { type: "string", maxLength: 3 }, "\u{1F600}\u{1F600}\u{1F600}", "\u{1F600}\u{1F600}\u{1F600}\u{1F600}"],
    ["pattern is unanchored", { type: "string", pattern: "b" }, "abc", "xyz"],
    ["pattern uses the u flag (property escapes)", { type: "string", pattern: "^\\p{L}+$" }, "café", "caf3"],
    ["pattern u flag: a lone surrogate class", { type: "string", not: { type: "string", pattern: "[\\uD800-\\uDFFF]" } }, "\u{1F600}", "a\uD800"],
    ["required", { type: "object", required: ["a"] }, { a: 1 }, { b: 1 }],
    ["additionalProperties false", { type: "object", properties: { a: {} }, additionalProperties: false }, { a: 1 }, { a: 1, b: 2 }],
    ["additionalProperties schema", { type: "object", additionalProperties: { type: "string" } }, { a: "x" }, { a: 1 }],
    ["propertyNames", { type: "object", propertyNames: { pattern: "^[a-z]+$" } }, { ab: 1 }, { Ab: 1 }],
    ["maxProperties", { type: "object", maxProperties: 1 }, { a: 1 }, { a: 1, b: 2 }],
    ["minProperties", { type: "object", minProperties: 1 }, { a: 1 }, {}],
    ["items", { type: "array", items: { type: "string" } }, ["a"], ["a", 1]],
    ["minItems", { type: "array", minItems: 2 }, [1, 2], [1]],
    ["maxItems", { type: "array", maxItems: 1 }, [1], [1, 2]],
    ["uniqueItems uses deep equality", { type: "array", uniqueItems: true }, [{ a: 1 }, { a: 2 }], [{ a: 1, b: 2 }, { b: 2, a: 1 }]],
    ["minimum / maximum", { type: "integer", minimum: 1, maximum: 3 }, 2, 4],
    ["allOf", { allOf: [{ type: "string" }, { minLength: 2 }] }, "ab", "a"],
    ["anyOf", { anyOf: [{ type: "string" }, { type: "integer" }] }, 1, null],
    ["oneOf requires exactly one", { oneOf: [{ type: "integer" }, { type: "number" }] }, 1.5, 1],
    ["not", { not: { type: "string" } }, 1, "x"],
    ["aggregate code points", { type: "object", "x-cp-max-total-code-points": 4 }, { ab: "\u{1F600}\u{1F600}" }, { ab: "\u{1F600}\u{1F600}x" }],
    ["boolean schema false", { properties: { a: false } }, { b: 1 }, { a: 1 }],
  ])("%s", (_name, schema, good, bad) => {
    const f = v(schema);
    expect(f(good)).toBe(true);
    expect(f(bad)).toBe(false);
  });

  const disc = {
    type: "object",
    oneOf: [
      { type: "object", required: ["t", "a"], properties: { t: { const: "x" }, a: { type: "string" } }, additionalProperties: false },
      { type: "object", required: ["t", "b"], properties: { t: { const: "y" }, b: { type: "string" } }, additionalProperties: false },
    ],
    discriminator: { propertyName: "t" },
  };

  it.each<[string, unknown, boolean]>([
    ["branch x", { t: "x", a: "1" }, true],
    ["branch y", { t: "y", b: "1" }, true],
    ["branch x with y's member", { t: "x", b: "1" }, false],
    ["missing tag", { a: "1" }, false],
    ["non-string tag", { t: 1, a: "1" }, false],
    ["unknown tag", { t: "z", a: "1" }, false],
    ["non-object", "x", false],
  ])("discriminator: %s", (_n, value, ok) => {
    expect(v(disc)(value)).toBe(ok);
  });

  it("fails closed: an unsupported keyword or a bad pattern throws at compile time", () => {
    expect(() => v({ type: "string", format: "uri" })).toThrow(/unsupported keyword "format"/);
    expect(() => v({ if: { type: "string" } })).toThrow(/unsupported keyword "if"/);
    expect(() => v({ properties: { a: { dependentRequired: {} } } })).toThrow(/unsupported/);
    expect(() => v({ pattern: "\\p{NoSuchProperty}" })).toThrow();
    expect(() => v({ oneOf: [{ properties: { t: { type: "string" } } }], discriminator: { propertyName: "t" } })).toThrow(/const tag/);
    // Annotations and other vendor extensions are ignored, not rejected.
    expect(v({ type: "string", description: "d", default: "x", "x-other": 1 })("y")).toBe(true);
  });

  it("dereference resolves internal refs, from a pointer, and rejects cycles, misses and siblings", () => {
    const doc = { $defs: { s: { type: "string" }, o: { type: "object", properties: { a: { $ref: "#/$defs/s" } } } } };
    expect(dereference(doc, "#/$defs/o")).toEqual({ type: "object", properties: { a: { type: "string" } } });
    expect(() => dereference({ a: { $ref: "#/a" } })).toThrow(/cyclic/);
    expect(() => dereference({ a: { $ref: "#/nope" } })).toThrow(/unresolvable/);
    expect(() => dereference({ a: { $ref: "other.yaml#/x" } })).toThrow(/external/);
    expect(() => dereference({ s: {}, a: { $ref: "#/s", type: "string" } })).toThrow(/siblings/);
  });

  it("helpers: code points and JSON equality", () => {
    expect(codePoints("a\u{1F600}é")).toBe(4);
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(1, "1")).toBe(false);
  });
});
