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
 * Not covered (server behaviour, API-3 tests): NFC normalization, lone surrogates, invalid
 * UTF-8, body byte limits and the error precedence order of error-catalog.md §3.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const $RefParser = require("@apidevtools/json-schema-ref-parser");

// The hoisted `ajv` is v6. Ajv v8 (JSON Schema 2020-12) is installed as ajv-formats' own
// dependency (package-lock pins it), so resolve it from there and assert the major version.
const ajvBase = path.dirname(require.resolve("ajv-formats/package.json"));
const ajvPkg = require(require.resolve("ajv/package.json", { paths: [ajvBase] }));
const Ajv2020 = require(require.resolve("ajv/dist/2020", { paths: [ajvBase] })).default;

const ROOT = path.resolve(__dirname, "..", "..");
const OPENAPI = path.join(ROOT, "docs/product/api-0/openapi.yaml");
const CATALOG = path.join(ROOT, "docs/product/api-0/error-catalog.md");
const PRD = path.join(ROOT, "docs/product/api-platform-prd.md");

type Json = any;

const raw: Json = yaml.load(fs.readFileSync(OPENAPI, "utf8"));
let deref: Json;
let validate: any;

function stripMapping(node: Json): Json {
  // Ajv's discriminator rejects `mapping`; the mapping is checked structurally below instead.
  if (Array.isArray(node)) return node.map(stripMapping);
  if (node && typeof node === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "discriminator" && v && typeof v === "object") {
        const { mapping: _m, ...rest } = v as Json;
        out[k] = rest;
      } else out[k] = stripMapping(v);
    }
    return out;
  }
  return node;
}

beforeAll(async () => {
  deref = await $RefParser.dereference(JSON.parse(JSON.stringify(raw)));
  const ajv = new Ajv2020({ strict: false, discriminator: true, allErrors: true });
  validate = ajv.compile(stripMapping(deref.components.schemas.CreateVerificationRequest));
});

const ok = (body: Json): boolean => validate(body) === true;

// ---------------------------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------------------------
interface Row { status: number; type: string; plane: string; beta: string; implemented: boolean }

function catalogRows(): Map<string, Row> {
  const md = fs.readFileSync(CATALOG, "utf8");
  const start = md.indexOf("## 2. Catalog");
  const end = md.indexOf("### 2.1", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows = new Map<string, Row>();
  for (const line of md.slice(start, end).split("\n")) {
    const m = /^\| `([a-z_]+)` \| (\d{3}) \| `([a-z_]+)` \| (data|management|both) \| [^|]+ \| ([a-z-]+) \| (yes|no) \| [^|]+ \|$/.exec(line);
    if (!m) continue;
    expect(rows.has(m[1])).toBe(false); // listed once
    rows.set(m[1], { status: Number(m[2]), type: m[3], plane: m[4], beta: m[5], implemented: m[6] === "yes" });
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

const IMPLEMENTED_API1A: ReadonlyArray<[string, number, string]> = [
  ["invalid_api_key", 401, "authentication_error"],
  ["api_key_not_accepted", 401, "authentication_error"],
  ["session_required", 401, "authentication_error"],
  ["insufficient_scope", 403, "permission_error"],
  ["org_suspended", 403, "permission_error"],
  ["live_key_requires_plan", 403, "permission_error"],
  ["insufficient_role", 403, "permission_error"],
  ["fresh_session_required", 403, "permission_error"],
  ["not_found", 404, "not_found"],
  ["invalid_request", 400, "invalid_request_error"],
  ["internal_error", 500, "api_error"],
  ["api_unavailable", 503, "service_unavailable"],
];

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
  it("is OpenAPI 3.1 at 0.3.0-draft and uses the Ajv 8 2020-12 dialect for validation", () => {
    expect(raw.openapi).toBe("3.1.0");
    expect(raw.info.version).toBe("0.3.0-draft");
    expect(String(ajvPkg.version).startsWith("8.")).toBe(true);
  });

  it("every internal $ref points at an existing node, and none remain after dereferencing", () => {
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
    expect(JSON.stringify(deref)).not.toContain('"$ref"');
  });
});

describe("C-1: CreateVerificationRequest is discriminated on type", () => {
  it("is a oneOf of exactly the claim and research variants, with a matching discriminator mapping", () => {
    const s = raw.components.schemas.CreateVerificationRequest;
    expect(s.discriminator?.propertyName).toBe("type");
    // Ajv's discriminator passes non-objects through; the union itself must say `object`.
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
    expect(all.filter(([, e]) => !e["x-expected-error"]).length).toBeGreaterThanOrEqual(4);
    expect(all.filter(([, e]) => e["x-expected-error"]).length).toBeGreaterThanOrEqual(8);
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
      expect({ code, ...mirror[code] }).toEqual({ code, status: r.status, type: r.type, plane: r.plane, beta: r.beta });
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

  it("the 12 implemented API-1a codes appear with the same status and type, and are the only ones marked implemented", () => {
    const rows = catalogRows();
    for (const [code, status, type] of IMPLEMENTED_API1A) {
      expect({ code, status: rows.get(code)?.status, type: rows.get(code)?.type }).toEqual({ code, status, type });
    }
    const marked = Array.from(rows).filter(([, r]) => r.implemented).map(([c]) => c).sort();
    expect(marked).toEqual(IMPLEMENTED_API1A.map(([c]) => c).sort());
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
    expect(rows.get("identity_not_verified")).toEqual({ status: 403, type: "permission_error", plane: "management", beta: "reserved", implemented: false });
    expect(rows.get("research_schema_unsupported")?.beta).toBe("proposed");
    expect(rows.has("account_disabled")).toBe(false);
    expect(rows.get("verification_not_found")?.plane).toBe("data");
    expect(rows.get("not_found")?.plane).toBe("management");
  });
});
