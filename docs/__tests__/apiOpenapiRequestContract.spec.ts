/**
 * API-0 Addendum 2 — the create-request contract and the error catalog are tests, not prose.
 *
 * Audit findings pinned here (03-quality-and-acceptance-contract.md §4, §5, §9):
 *   C-1  `CreateVerificationRequest.input` was not tied to `type`, so a claim carrying
 *        `question`, or research carrying `claim`, validated. The schema is now a `oneOf`
 *        discriminated on `type`; this spec compiles it with Ajv (JSON Schema 2020-12) and
 *        runs positive controls next to every negative case, so a permissive schema fails.
 *   C-3  Limits are counted in code points (the 4,000-emoji control proves Ajv counts code
 *        points, not UTF-16 units), C0 controls are excluded, models/metadata are bounded.
 *   C-4  One error catalog: docs/product/api-0/error-catalog.md §2. Its table, the OpenAPI
 *        mirror `components.x-error-catalog`, the codes named in OpenAPI response
 *        descriptions, PRD §9.5, the Addendum 1 codes and the 12 implemented API-1a codes
 *        must agree.
 *
 * Addendum 3 (Quality Correction R2) pins, in addition:
 *   m1  the catalog against the draft implementation snapshot
 *       docs/product/api-0/implementation-snapshots/api-1a-errors.json (generated from the real
 *       lib/apiPlatform/errors.ts at #327 @ fa9146a), status + type + message;
 *   m4  input text needs a VISIBLE code point (zero-width-only text is rejected, legitimate
 *       joiners, marks and variation selectors are accepted);
 *   m5  every published error example (PRD, OpenAPI, catalog) conforms to the catalog;
 *   m6  no transitive Ajv: the schema is compiled by the purpose-built subset validator
 *       ./support/jsonSchemaSubset.ts (its own spec: jsonSchemaSubset.spec.ts);
 *   exception 2  DEL and C1 controls are rejected alongside C0.
 *
 * Not covered (server behaviour, API-3 tests): NFC normalization, lone surrogates in raw bytes,
 * invalid UTF-8, body byte limits on the wire and the executed precedence order.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { compile, dereference } from "./support/jsonSchemaSubset";

const ROOT = path.resolve(__dirname, "..", "..");
const OPENAPI = path.join(ROOT, "docs/product/api-0/openapi.yaml");
const CATALOG = path.join(ROOT, "docs/product/api-0/error-catalog.md");
const PRD = path.join(ROOT, "docs/product/api-platform-prd.md");
const SNAPSHOT = path.join(ROOT, "docs/product/api-0/implementation-snapshots/api-1a-errors.json");

type Json = any;

const raw: Json = yaml.load(fs.readFileSync(OPENAPI, "utf8"));
let deref: Json;
let validate: any;

beforeAll(() => {
  // Only the request schema is dereferenced: response schemas elsewhere use `$ref` with
  // sibling keywords (2020-12), which the subset dereferencer deliberately does not merge.
  deref = dereference(raw, "#/components/schemas/CreateVerificationRequest");
  validate = compile(deref);
});

const ok = (body: Json): boolean => validate(body) === true;

// ---------------------------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------------------------
interface Row { status: number; type: string; plane: string; beta: string; message: string; implemented: boolean; production: string }

function catalogRows(): Map<string, Row> {
  const md = fs.readFileSync(CATALOG, "utf8");
  const start = md.indexOf("## 2. Catalog");
  const end = md.indexOf("### 2.1", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = new Map<string, Row>();
  for (const line of md.slice(start, end).split("\n")) {
    const m = /^\| `([a-z_]+)` \| (\d{3}) \| `([a-z_]+)` \| (data|management|both) \| [^|]+ \| ([a-z-]+) \| ([^|]+) \| (yes|no) \| (none) \|$/.exec(line);
    if (!m) continue;
    expect(rows.has(m[1])).toBe(false); // listed once
    rows.set(m[1], { status: Number(m[2]), type: m[3], plane: m[4], beta: m[5], message: m[6], implemented: m[7] === "yes", production: m[8] });
  }
  return rows;
}

const ERROR_TYPES = new Set([
  "invalid_request_error", "authentication_error", "billing_error", "permission_error", "not_found",
  "idempotency_error", "gone", "request_too_large", "unprocessable", "rate_limit_error", "api_error",
  "service_unavailable",
]);
// Backticked words in error descriptions that are field or envelope names, not codes. Pinned.
// Words that are both an error `type` and a code of the same status.
const TYPE_AND_CODE = new Set(["not_found", "request_too_large"]);
const NON_CODE_TOKENS = new Set(["retain_input", "retain_model_responses", "request_id", "param", "type", "charset"]);

interface Snapshot { source: string; pr: number; commit: string; codes: Record<string, { status: number; type: string; message: string }> }
const snapshot: Snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));

const RESPONSE_STATUS: Record<string, number> = {
  BadRequest: 400, Unauthorized: 401, PaymentRequired: 402, Forbidden: 403, NotFound: 404,
  Conflict: 409, Gone: 410, TooLarge: 413, UnsupportedMediaType: 415, Unprocessable: 422,
  TooManyRequests: 429, InternalError: 500, ServiceUnavailable: 503,
};

/** Codes named in prose. A code written as "422 `code`" is a cross-reference to that status. */
function statusedCodeTokens(text: string): Array<{ code: string; status: number | null }> {
  return Array.from(text.matchAll(/(?:\b(\d{3}) )?`([a-z][a-z0-9_]*)`/g), (m) => ({
    code: m[2],
    status: m[1] ? Number(m[1]) : null,
  })).filter((t) => !NON_CODE_TOKENS.has(t.code) && (!ERROR_TYPES.has(t.code) || TYPE_AND_CODE.has(t.code)));
}
function codeTokens(text: string): string[] {
  return statusedCodeTokens(text).map((t) => t.code);
}

// ---------------------------------------------------------------------------------------------
describe("openapi.yaml parses and resolves", () => {
  it("is OpenAPI 3.1 at 0.4.0-draft", () => {
    expect(raw.openapi).toBe("3.1.0");
    expect(raw.info.version).toBe("0.4.0-draft");
  });

  it("m6: the spec loads no transitive validator (no Ajv, no ref-parser)", () => {
    const src = fs.readFileSync(__filename, "utf8");
    const banned = ["aj" + "v", "json-schema-" + "ref-parser", "ajv-" + "formats"];
    for (const b of banned) expect({ b, used: new RegExp(`require\\([^)]*${b}|from "[^"]*${b}`).test(src) }).toEqual({ b, used: false });
  });

  it("every internal $ref points at an existing node, and none remain in the dereferenced request schema", () => {
    const refs: string[] = [];
    const walk = (n: Json): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        if (typeof n.$ref === "string") refs.push(n.$ref);
        Object.values(n).forEach(walk);
      }
    };
    walk(raw);
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) {
      expect(ref.startsWith("#/")).toBe(true);
      let node: Json = raw;
      for (const part of ref.slice(2).split("/")) {
        node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      expect({ ref, found: node !== undefined }).toEqual({ ref, found: true });
    }
    expect(JSON.stringify(deref)).not.toContain('"$ref":');
  });
});

describe("C-1: CreateVerificationRequest is discriminated on type", () => {
  it("is a oneOf of exactly the claim and research variants, with a matching discriminator mapping", () => {
    const s = raw.components.schemas.CreateVerificationRequest;
    expect(s.discriminator?.propertyName).toBe("type");
    // A discriminator passes non-objects through; the union itself must say `object`.
    expect(s.type).toBe("object");
    expect(s.oneOf).toEqual([
      { $ref: "#/components/schemas/ClaimVerificationRequest" },
      { $ref: "#/components/schemas/ResearchVerificationRequest" },
    ]);
    expect(s.discriminator.mapping).toEqual({
      claim: "#/components/schemas/ClaimVerificationRequest",
      research: "#/components/schemas/ResearchVerificationRequest",
    });
    expect(raw.components.schemas.ClaimVerificationRequest.properties.type.const).toBe("claim");
    expect(raw.components.schemas.ResearchVerificationRequest.properties.type.const).toBe("research");
    for (const name of ["ClaimVerificationRequest", "ResearchVerificationRequest", "ClaimInput", "ResearchInput", "VerificationOptions"]) {
      expect({ name, closed: raw.components.schemas[name].additionalProperties }).toEqual({ name, closed: false });
    }
  });

  const examples = (): Array<[string, Json]> =>
    Object.entries(raw.paths["/verifications"].post.requestBody.content["application/json"].examples);

  it("has positive and negative request examples", () => {
    const all = examples();
    expect(all.filter(([, e]) => !e["x-expected-error"]).length).toBeGreaterThanOrEqual(5);
    expect(all.filter(([, e]) => e["x-expected-error"]).length).toBeGreaterThanOrEqual(11);
  });

  it("every positive example validates and every negative example fails", () => {
    for (const [name, ex] of examples()) {
      const expected = ex["x-expected-error"] ? "invalid" : "valid";
      expect({ name, result: ok(ex.value) ? "valid" : "invalid" }).toEqual({ name, result: expected });
    }
  });

  it("every negative example names a catalog code with its status", () => {
    const rows = catalogRows();
    for (const [name, ex] of examples()) {
      const e = ex["x-expected-error"];
      if (!e) continue;
      expect({ name, status: rows.get(e.code)?.status }).toEqual({ name, status: e.status });
      expect(name.startsWith("invalid_")).toBe(true);
    }
  });

  const claim = (input: Json, extra: Json = {}): Json => ({ type: "claim", input, ...extra });
  const research = (input: Json, extra: Json = {}): Json => ({ type: "research", input, ...extra });
  const C = { claim: "Water boils at 100 C at sea level." };
  const Q = { question: "What are the risks?" };
  const keys = (n: number, len = 3): Json =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(len - 1, "0")}`, "v"]));

  // Positive controls: each negative below has a passing neighbour, so a vacuous schema fails.
  const VALID: Array<[string, Json]> = [
    ["claim minimal", claim(C)],
    ["research minimal", research(Q)],
    ["research with context", research({ ...Q, context: "Audience: reviewers." })],
    ["research with empty context", research({ ...Q, context: "" })],
    ["claim with every option false", claim(C, { options: { synthesis: false, allow_fallback: false, retain_input: false, retain_model_responses: false } })],
    ["claim with synthesis true (schema-valid; 422 synthesis_not_supported is semantic)", claim(C, { options: { synthesis: true } })],
    ["research with synthesis true (schema-valid; 422 synthesis_unavailable is semantic, step 9)", research(Q, { options: { synthesis: true } })],
    // m4: legitimate joiners, marks and selectors are accepted (and never stripped).
    ["ZWJ emoji sequence", claim({ claim: "\u{1F469}\u200D\u{1F4BB}" })],
    ["ZWNJ inside a Persian word", claim({ claim: "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645" })],
    ["ZWNJ inside a Hindi word", research({ question: "\u0915\u094D\u200C\u0937" })],
    ["decomposed combining sequence", claim({ claim: "cafe\u0301" })],
    ["base with several combining marks", claim({ claim: "a\u0301\u0323\u0308" })],
    ["variation selector after a base", claim({ claim: "\u2764\uFE0F" })],
    ["one visible letter among zero-width characters", claim({ claim: "\u200Ba\u200B" })],
    ["mark before a base", claim({ claim: "\u0301a" })],
    ["bidi controls around real text", claim({ claim: "\u202Babc\u202C" })],
    ["a single digit", claim({ claim: "7" })],
    ["a single punctuation mark", claim({ claim: "?" })],
    ["a single emoji", claim({ claim: "\u{1F642}" })],
    ["private-use character (accepted edge, error-catalog §4.2)", claim({ claim: "\uE000" })],
    ["braille pattern blank (accepted edge, error-catalog §4.2)", claim({ claim: "\u2800" })],
    ["context made only of zero-width characters (context may be empty)", research({ ...Q, context: "\u200B\u200B" })],
    ["metadata value made only of zero-width characters", claim(C, { metadata: { ref: "\u200B" } })],
    ["metadata at the 4000 code-point aggregate", claim(C, { metadata: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, "v".repeat(i < 7 ? 498 : 500 - 14)])) })],
    ["two models", claim(C, { models: ["chatgpt", "claude"] })],
    ["five models", research(Q, { models: ["chatgpt", "claude", "grok", "perplexity", "gemini"] })],
    ["64-character model ID", claim(C, { models: ["a".repeat(64), "claude"] })],
    ["claim of 4000 ASCII code points", claim({ claim: "a".repeat(4000) })],
    ["claim of 4000 astral code points (8000 UTF-16 units)", claim({ claim: "\u{1F600}".repeat(4000) })],
    ["question of 4000 code points", research({ question: "q".repeat(4000) })],
    ["context of 20000 code points", research({ ...Q, context: "c".repeat(20000) })],
    ["claim with tab, LF and CR", claim({ claim: "line one\tx\nline two\r\n" })],
    ["metadata with 20 keys", claim(C, { metadata: keys(20) })],
    ["metadata key of 40 characters", claim(C, { metadata: { ["k".repeat(40)]: "v" } })],
    ["metadata value of 500 code points", claim(C, { metadata: { ref: "v".repeat(500) } })],
    ["metadata empty value", claim(C, { metadata: { ref: "" } })],
  ];

  const INVALID: Array<[string, Json]> = [
    ["claim with question", claim({ ...C, question: "Is it?" })],
    ["claim with context", claim({ ...C, context: "Physics." })],
    ["claim with only question", claim(Q)],
    ["claim with empty input object", claim({})],
    ["claim without input", { type: "claim" }],
    ["research with claim", research(C)],
    ["research with claim and question", research({ ...C, ...Q })],
    ["research with no question", research({ context: "Physics." })],
    ["research with empty input object", research({})],
    ["no type", { input: C }],
    ["type outside the release (video)", { type: "video", input: C }],
    ["type in the wrong case", { type: "Claim", input: C }],
    ["type not a string", { type: 1, input: C }],
    ["input not an object", { type: "claim", input: "Water boils." }],
    ["empty claim", claim({ claim: "" })],
    ["whitespace-only claim", claim({ claim: " \t\n " })],
    ["empty question", research({ question: "" })],
    ["whitespace-only question (U+3000)", research({ question: "　　" })],
    ["claim of 4001 code points", claim({ claim: "a".repeat(4001) })],
    ["claim of 4001 astral code points", claim({ claim: "\u{1F600}".repeat(4001) })],
    ["question of 4001 code points", research({ question: "q".repeat(4001) })],
    ["context of 20001 code points", research({ ...Q, context: "c".repeat(20001) })],
    ["claim with NUL", claim({ claim: "abc\u0000def" })],
    ["claim with ESC (C0)", claim({ claim: "abc\u001bdef" })],
    ["context with C0", research({ ...Q, context: "x\u0007" })],
    ["unknown top-level field", claim(C, { priority: "high" })],
    ["unknown input field", claim({ ...C, lang: "en" })],
    ["unknown option", claim(C, { options: { stream: true } })],
    ["non-boolean option", claim(C, { options: { synthesis: "yes" } })],
    ["models with one item", claim(C, { models: ["claude"] })],
    ["models with six items", research(Q, { models: ["chatgpt", "claude", "grok", "perplexity", "gemini", "deepseek"] })],
    ["empty models", claim(C, { models: [] })],
    ["duplicate models", claim(C, { models: ["claude", "claude"] })],
    ["empty model ID", claim(C, { models: ["", "claude"] })],
    ["uppercase model ID", claim(C, { models: ["Claude", "chatgpt"] })],
    ["65-character model ID", claim(C, { models: ["a".repeat(65), "claude"] })],
    ["model ID with a space", claim(C, { models: ["chat gpt", "claude"] })],
    ["non-string model ID", claim(C, { models: [1, "claude"] })],
    ["models not an array", claim(C, { models: "claude" })],
    ["metadata with 21 keys", claim(C, { metadata: keys(21) })],
    ["metadata value of 501 code points", claim(C, { metadata: { ref: "v".repeat(501) } })],
    ["metadata key of 41 characters", claim(C, { metadata: { ["k".repeat(41)]: "v" } })],
    ["metadata key with a space", claim(C, { metadata: { "bad key": "v" } })],
    ["metadata empty key", claim(C, { metadata: { "": "v" } })],
    ["metadata non-string value", claim(C, { metadata: { n: 1 } })],
    ["metadata nested object", claim(C, { metadata: { n: { deep: "v" } } })],
    ["metadata value with C0", claim(C, { metadata: { ref: "a\u0001" } })],
    ["metadata over the 4000 code-point aggregate", claim(C, { metadata: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v".repeat(450)])) })],
    // m4: no visible code point.
    ["claim of ZWSP only", claim({ claim: "\u200B" })],
    ["claim of ZWSP, ZWNJ, ZWJ, WJ, BOM", claim({ claim: "\u200B\u200C\u200D\u2060\uFEFF" })],
    ["question of ZWJ only", research({ question: "\u200D\u200D" })],
    ["claim of U+180E", claim({ claim: "\u180E" })],
    ["claim of soft hyphen", claim({ claim: "\u00AD" })],
    ["claim of bidi controls only", claim({ claim: "\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C" })],
    ["claim of variation selectors only", claim({ claim: "\uFE0F\uFE00\u{E0100}" })],
    ["claim of combining marks only", claim({ claim: "\u0301\u0308" })],
    ["claim of an enclosing mark only", claim({ claim: "\u20DD" })],
    ["claim of a spacing mark only", claim({ claim: "\u093E" })],
    ["claim of tag characters only", claim({ claim: "\u{E0001}\u{E0041}\u{E007F}" })],
    ["claim of Hangul fillers only", claim({ claim: "\u115F\u1160\u3164\uFFA0" })],
    ["claim of CGJ only", claim({ claim: "\u034F" })],
    ["claim of interlinear annotation controls only", claim({ claim: "\uFFF9\uFFFA\uFFFB" })],
    ["claim of zero-width and whitespace mixed", claim({ claim: " \u200B\t\u00A0\u2060\u3000" })],
    ["claim of line and paragraph separators", claim({ claim: "\u2028\u2029" })],
    // Reviewer exception 2: DEL and C1 are controls like C0.
    ["claim with DEL", claim({ claim: "abc\u007Fdef" })],
    ["claim with NEL (C1)", claim({ claim: "abc\u0085def" })],
    ["claim with U+0080 (C1)", claim({ claim: "abc\u0080def" })],
    ["claim with U+009F (C1)", claim({ claim: "abc\u009Fdef" })],
    ["context with DEL", research({ ...Q, context: "x\u007F" })],
    ["metadata value with C1", claim(C, { metadata: { ref: "a\u0090" } })],
    ["claim with a lone high surrogate", claim({ claim: "abc\uD800def" })],
    ["claim with a lone low surrogate", claim({ claim: "abc\uDC00" })],
    ["top-level array", [claim(C)]],
  ];

  it.each(VALID)("accepts: %s", (_name, body) => {
    expect(ok(body)).toBe(true);
  });

  it.each(INVALID)("rejects: %s", (_name, body) => {
    expect(ok(body)).toBe(false);
  });
});

describe("C-4: one error catalog", () => {
  it("the catalog table lists every code once, with a known type", () => {
    const rows = catalogRows();
    expect(rows.size).toBeGreaterThanOrEqual(50);
    for (const [code, r] of rows) expect({ code, known: ERROR_TYPES.has(r.type) }).toEqual({ code, known: true });
  });

  it("the catalog and components.x-error-catalog enumerate the same codes with the same status, type, plane and beta status", () => {
    const rows = catalogRows();
    const mirror: Record<string, Json> = raw.components["x-error-catalog"].codes;
    expect(Object.keys(mirror).sort()).toEqual(Array.from(rows.keys()).sort());
    for (const [code, r] of rows) {
      expect({ code, ...mirror[code] }).toEqual({ code, status: r.status, type: r.type, plane: r.plane, beta: r.beta, message: r.message, implemented_in_draft: r.implemented });
    }
  });

  it("every code named in an OpenAPI error response is in the catalog with that response's status", () => {
    const rows = catalogRows();
    // The status map above must match how paths use the responses.
    for (const [p, item] of Object.entries<Json>(raw.paths)) {
      for (const [method, op] of Object.entries<Json>(item)) {
        if (!op || typeof op !== "object" || !op.responses) continue;
        for (const [status, resp] of Object.entries<Json>(op.responses)) {
          const m = /^#\/components\/responses\/(\w+)$/.exec(resp?.$ref ?? "");
          if (m) expect({ at: `${method} ${p} ${status}`, s: RESPONSE_STATUS[m[1]] }).toEqual({ at: `${method} ${p} ${status}`, s: Number(status) });
        }
      }
    }
    expect(Object.keys(raw.components.responses).sort()).toEqual(Object.keys(RESPONSE_STATUS).sort());
    const named = new Set<string>();
    for (const [name, resp] of Object.entries<Json>(raw.components.responses)) {
      for (const { code, status } of statusedCodeTokens(resp.description)) {
        named.add(code);
        const want = status ?? RESPONSE_STATUS[name];
        expect({ response: name, code, status: rows.get(code)?.status }).toEqual({ response: name, code, status: want });
      }
    }
    // Reverse: every data-plane code is documented on some response.
    for (const [code, r] of rows) {
      if (r.plane !== "management") expect({ code, documented: named.has(code) }).toEqual({ code, documented: true });
    }
  });

  it("m1: the implementation snapshot is a generated record of #327 at a full commit SHA", () => {
    expect(snapshot.source).toBe("lib/apiPlatform/errors.ts");
    expect(snapshot.pr).toBe(327);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.commit.startsWith("fa9146a")).toBe(true);
    expect(Object.keys(snapshot.codes)).toEqual(Object.keys(snapshot.codes).slice().sort());
    expect(Object.keys(snapshot.codes).length).toBe(13);
    // The catalog column header names the same commit.
    expect(fs.readFileSync(CATALOG, "utf8")).toContain(`Draft implementation (#327 @ \`${snapshot.commit.slice(0, 7)}\`)`);
  });

  it("m1: every snapshot code is in the catalog with the identical status, type and message, and is marked implemented", () => {
    const rows = catalogRows();
    for (const [code, spec] of Object.entries(snapshot.codes)) {
      const r = rows.get(code);
      expect({ code, status: r?.status, type: r?.type, message: r?.message, implemented: r?.implemented })
        .toEqual({ code, status: spec.status, type: spec.type, message: spec.message, implemented: true });
    }
    const marked = Array.from(rows).filter(([, r]) => r.implemented).map(([c]) => c).sort();
    expect(marked).toEqual(Object.keys(snapshot.codes).sort());
  });

  it("m1: no code is active in Production (the API is dark)", () => {
    for (const [code, r] of catalogRows()) expect({ code, production: r.production }).toEqual({ code, production: "none" });
  });

  it("every PRD §9.5 code appears with the PRD's status", () => {
    const rows = catalogRows();
    const prd = fs.readFileSync(PRD, "utf8");
    const start = prd.indexOf("### 9.5 Error model");
    const section = prd.slice(start, prd.indexOf("\n---", start));
    let seen = 0;
    for (const line of section.split("\n")) {
      const m = /^\| (\d{3}) \| (.+) \|$/.exec(line);
      if (!m) continue;
      for (const code of codeTokens(m[2])) {
        seen++;
        expect({ code, status: rows.get(code)?.status }).toEqual({ code, status: Number(m[1]) });
      }
    }
    expect(seen).toBeGreaterThanOrEqual(30);
  });

  it("the Addendum 1 codes appear with Addendum 1's status, and the C-2/C-5 codes are reserved/proposed", () => {
    const rows = catalogRows();
    const want: Array<[string, number]> = [
      ["invalid_cursor", 400], ["invalid_status", 400],
      ["pipeline_processing_not_acknowledged", 403], ["option_unavailable_in_beta", 422],
      ["synthesis_unavailable", 422], ["fallback_unavailable", 422],
    ];
    for (const [code, status] of want) expect({ code, status: rows.get(code)?.status }).toEqual({ code, status });
    expect(rows.get("identity_not_verified")).toEqual({ status: 403, type: "permission_error", plane: "management", beta: "active", message: "Verify your email address to perform this action.", implemented: true, production: "none" });
    expect(rows.get("research_schema_unsupported")?.beta).toBe("proposed");
    expect(rows.has("account_disabled")).toBe(false);
    expect(rows.get("verification_not_found")?.plane).toBe("data");
    expect(rows.get("not_found")?.plane).toBe("management");
  });
});

// ---------------------------------------------------------------------------------------------
// m5: every published error example conforms to the catalog
// ---------------------------------------------------------------------------------------------
describe("m5: published error examples", () => {
  const DOC_BASE = "https://docs.convergepanel.com/errors#";
  const ENVELOPE_KEYS = ["code", "doc_url", "message", "param", "request_id", "type"];

  /** Every ```json block in a markdown file whose JSON has a top-level `error` member. */
  function markdownExamples(file: string): Array<{ where: string; value: Json }> {
    const md = fs.readFileSync(file, "utf8");
    const out: Array<{ where: string; value: Json }> = [];
    for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
      if (!/"error"\s*:/.test(m[1])) continue;
      const where = `${path.relative(ROOT, file)}:${md.slice(0, m.index).split("\n").length}`;
      out.push({ where, value: JSON.parse(m[1]) });
    }
    return out;
  }

  function openapiExamples(): Array<{ where: string; value: Json; status: number }> {
    const out: Array<{ where: string; value: Json; status: number }> = [];
    for (const [name, resp] of Object.entries<Json>(raw.components.responses)) {
      const media = resp.content?.["application/json"];
      if (media?.example) out.push({ where: `openapi components.responses.${name}.example`, value: media.example, status: RESPONSE_STATUS[name] });
      for (const [ex, v] of Object.entries<Json>(media?.examples ?? {})) out.push({ where: `openapi components.responses.${name}.examples.${ex}`, value: v.value, status: RESPONSE_STATUS[name] });
    }
    return out;
  }

  function check(where: string, value: Json, status?: number): void {
    const rows = catalogRows();
    expect({ where, keys: Object.keys(value) }).toEqual({ where, keys: ["error"] });
    const e = value.error;
    expect({ where, keys: Object.keys(e).sort() }).toEqual({ where, keys: ENVELOPE_KEYS });
    const r = rows.get(e.code);
    expect({ where, code: e.code, known: r !== undefined }).toEqual({ where, code: e.code, known: true });
    expect({ where, type: e.type, message: e.message, doc_url: e.doc_url })
      .toEqual({ where, type: r?.type, message: r?.message, doc_url: `${DOC_BASE}${e.code}` });
    if (status !== undefined) expect({ where, status: r?.status }).toEqual({ where, status });
    expect(e.param === null || typeof e.param === "string").toBe(true);
    expect(e.request_id).toMatch(/^req_[A-Za-z0-9…]+$/);
  }

  it("the PRD §9.5 envelope sample, every markdown example and every OpenAPI response example conform", () => {
    const md = [PRD, CATALOG, ...fs.readdirSync(path.dirname(CATALOG)).filter((f) => f.endsWith(".md")).map((f) => path.join(path.dirname(CATALOG), f))];
    const all = Array.from(new Set(md)).flatMap(markdownExamples);
    const prd = all.filter((x) => x.where.startsWith("docs/product/api-platform-prd.md"));
    expect(prd.length).toBeGreaterThanOrEqual(1);
    expect(all.some((x) => x.where.startsWith("docs/product/api-0/error-catalog.md"))).toBe(true);
    for (const x of all) check(x.where, x.value);
    const oa = openapiExamples();
    expect(oa.length).toBeGreaterThanOrEqual(2);
    for (const x of oa) check(x.where, x.value, x.status);
  });

  it("the PRD sample for model_limit_exceeded has type unprocessable (the m5 defect)", () => {
    const prd = markdownExamples(PRD).find((x) => x.value.error.code === "model_limit_exceeded");
    expect(prd?.value.error.type).toBe("unprocessable");
  });

  it("every negative request example's x-expected-error names a catalog code, status and a dotted param", () => {
    const rows = catalogRows();
    for (const [name, ex] of Object.entries<Json>(raw.paths["/verifications"].post.requestBody.content["application/json"].examples)) {
      const e = ex["x-expected-error"];
      if (!e) continue;
      expect({ name, keys: Object.keys(e).sort() }).toEqual({ name, keys: ["code", "param", "status"] });
      expect({ name, status: rows.get(e.code)?.status }).toEqual({ name, status: e.status });
      expect(e.param).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// m2 / m3: rate limits on every operation and the normative order of error-catalog.md §3.1
// ---------------------------------------------------------------------------------------------
describe("m2/m3: precedence and rate limits", () => {
  it("every data-plane operation documents 429 TooManyRequests, which carries Retry-After", () => {
    expect(raw.components.responses.TooManyRequests.headers["Retry-After"]).toBeDefined();
    let ops = 0;
    for (const [p, item] of Object.entries<Json>(raw.paths)) {
      for (const [method, op] of Object.entries<Json>(item)) {
        if (!op || typeof op !== "object" || !op.responses) continue;
        ops++;
        expect({ at: `${method} ${p}`, r429: op.responses["429"]?.$ref }).toEqual({ at: `${method} ${p}`, r429: "#/components/responses/TooManyRequests" });
      }
    }
    expect(ops).toBe(9);
  });

  function precedenceTables(): Array<string[]> {
    const md = fs.readFileSync(CATALOG, "utf8");
    const sec = md.slice(md.indexOf("### 3.1 Data plane"), md.indexOf("### 3.2 Management plane"));
    const tables: Array<string[]> = [];
    let cur: string[] | null = null;
    for (const line of sec.split("\n")) {
      if (line.startsWith("| Step |")) { cur = []; tables.push(cur); continue; }
      if (cur && /^\| \d+ \|/.test(line)) cur.push(line);
      else if (cur && !line.startsWith("|")) cur = null;
    }
    return tables;
  }
  const rowOf = (rows: string[], code: string): number => {
    const i = rows.findIndex((r) => r.includes(`\`${code}\``));
    expect({ code, found: i >= 0 }).toEqual({ code, found: true });
    return i;
  };

  it("create: transport < flood limit < auth < rate < org/scope < decoding < idempotency < every new-job-only check", () => {
    const [create] = precedenceTables();
    const order = (a: string, b: string): void => expect({ a, b, before: rowOf(create, a) < rowOf(create, b) }).toEqual({ a, b, before: true });
    order("request_too_large", "invalid_api_key");
    expect(create.filter((r) => r.includes("`rate_limited`")).length).toBe(2); // pre-auth and authenticated
    order("invalid_api_key", "org_suspended");
    expect(rowOf(create, "invalid_api_key")).toBeLessThan(create.findIndex((r, i) => i > rowOf(create, "invalid_api_key") && r.includes("`rate_limited`")) + 1);
    order("org_suspended", "insufficient_scope");
    order("insufficient_scope", "invalid_json");
    order("invalid_json", "idempotency_key_reused");
    for (const c of ["synthesis_unavailable", "fallback_unavailable", "option_unavailable_in_beta", "type_unavailable", "pipeline_processing_not_acknowledged", "model_unavailable", "model_limit_exceeded", "queue_unavailable", "concurrency_limit", "failed_job_threshold_exceeded", "quota_exceeded", "capacity_protection", "platform_spend_ceiling"]) {
      order("idempotency_key_reused", c);
      expect({ c, newJobOnly: create[rowOf(create, c)].includes("*New job only.*") }).toEqual({ c, newJobOnly: true });
    }
    // Authenticated rate limit (second rate_limited row) precedes all body decoding.
    const rateRows = create.map((r, i) => (r.includes("`rate_limited`") ? i : -1)).filter((i) => i >= 0);
    expect(rateRows[1]).toBeGreaterThan(rowOf(create, "invalid_api_key"));
    expect(rateRows[1]).toBeLessThan(rowOf(create, "invalid_json"));
  });

  it("GET/poll/list/delete/cancel: rate limit is decided before the tenant-bound lookup", () => {
    const [, reads] = precedenceTables();
    expect(reads).toBeDefined();
    expect(rowOf(reads, "rate_limited")).toBeLessThan(rowOf(reads, "invalid_api_key") + 2);
    expect(rowOf(reads, "invalid_api_key")).toBeLessThan(reads.findIndex((r) => r.includes("Authenticated request rate")));
    expect(reads.findIndex((r) => r.includes("Authenticated request rate"))).toBeLessThan(rowOf(reads, "verification_not_found"));
    expect(reads.find((r) => r.includes("Authenticated request rate"))).toContain("before the path ID");
  });
});
