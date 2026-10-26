/**
 * AI Integrity Order 6, S-1a-min — tests for `buildDsProvenanceViewMin`.
 *
 * The golden cases in `fixtures/dsProvenanceViewMin.goldens.json` are exported
 * from the sealed R17 protected inventory (every S-1a-min-executable record),
 * with inputs resolved exactly as the sealed validator's §3.5 reference does.
 * The file header records the source digests. Every data golden is replayed
 * here; the property records (ITEM3-PURITY, ITEM5-*, V-09) are covered by
 * the property tests below.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  buildDsProvenanceViewMin,
  OPTION_CLUSTERING_UNVERIFIED_TEXT,
  REVIEW_HISTORY_NOT_SHOWN_TEXT,
  type DsProvenanceViewMin,
} from "../dsProvenanceViewMin";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface GoldenCase {
  record: string;
  fixture: string;
  kind: "layers" | "l5";
  context: Record<string, Json>;
  projection: string;
  adaptive: string;
  governance: string | null;
  expected: Record<string, Json>;
  absentKeysRegex?: string | null;
  prohibitedPhrases?: string[];
  reachability?: { label: string } | null;
}
interface Goldens {
  source: Record<string, Json>;
  semantics: {
    flagText: string;
    historyText: string;
    piKeyRegex: string;
    d2Regex: string;
    closedVocabulary: Record<string, string[]>;
    claimPatterns: string[];
    approvedClaimTokenValues: string[];
    approvedClaimTokenKeys: string[];
    forbiddenKeys: Record<string, string>;
    contextCatalog: Array<Record<string, Json>>;
    l4Keys: string[];
  };
  fixtures: {
    governance: Record<string, { record?: Json; absent?: true; expectedParser: Json }>;
    projections: Record<string, Json>;
    adaptive: Record<string, Json>;
  };
  cases: GoldenCase[];
  coverage: Array<{ record: string; executable: boolean; status: string; goldenCases?: number; expectedResult?: Record<string, Json> }>;
}

const G: Goldens = JSON.parse(readFileSync(join(__dirname, "fixtures", "dsProvenanceViewMin.goldens.json"), "utf-8"));
const SEM = G.semantics;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function governanceOf(key: string | null): unknown {
  if (key === null) return undefined;
  const g = G.fixtures.governance[key];
  return g.absent ? undefined : clone(g.record);
}
function inputOf(c: GoldenCase) {
  return {
    publicResults: clone(G.fixtures.projections[c.projection]),
    publicAdaptiveOutput: clone(G.fixtures.adaptive[c.adaptive]),
    governanceRecord: governanceOf(c.governance),
    surfaceRequest: clone(c.context),
  };
}
const STD_INPUT = (surfaceRequest: unknown, governanceRecord: unknown = undefined) => {
  const c = G.cases.find((x) => x.kind === "l5")!;
  return {
    publicResults: clone(G.fixtures.projections[c.projection]),
    publicAdaptiveOutput: clone(G.fixtures.adaptive[c.adaptive]),
    governanceRecord,
    surfaceRequest,
  };
};

/** Every decided-review fixture in the export (used for property tests over many records). */
const GOVERNANCE_FIXTURES = Object.entries(G.fixtures.governance).map(([k, g]) => [k, g.absent ? undefined : g.record] as const);

// ─── Walk helpers ─────────────────────────────────────────────────────────

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  return out;
}
/** [vocabulary path, value] for every leaf; array indices are dropped from the path. */
function leaves(v: unknown, path = "", out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, path, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  else out.push([path, v]);
  return out;
}
// Paths whose values are copied from the projection or the parser (equality-checked by the goldens, never scanned for wording).
const STORED_PATHS = new Set([
  "l1.slotId", "l1.requestedModel", "l1.answeredByProvider", "l1.substitutedFrom",
  "l2.recommendation.action", "l2.recommendation.recommendedOptionId", "l2.computedAt",
  "l3.sourcesListedByModels.list", "l3.modelSelfReportedEvidenceStrength.optionId", "l3.modelSelfReportedEvidenceStrength.criterionId",
  "l3.modelSelfReportedEvidenceStrength.evidenceStrength",
  "humanReview.decision", "humanReview.reviewedAt", "humanReview.conditions",
]);
/** Generated string values (not copied from the projection or parser). */
function generatedStrings(view: unknown): Array<[string, string]> {
  return leaves(view).filter(([p, v]) => typeof v === "string" && !STORED_PATHS.has(p)) as Array<[string, string]>;
}

// ─── 1. Golden replay ─────────────────────────────────────────────────────

describe("S-1a-min goldens (sealed R17 protected inventory, executable records)", () => {
  it("the export covers every executable record and only those (35 of 68)", () => {
    expect(G.coverage).toHaveLength(68);
    expect(G.coverage.filter((c) => c.executable)).toHaveLength(35);
    for (const c of G.coverage.filter((x) => !x.executable)) expect(c.status).toBe("NOT_EXECUTABLE_IN_S1A_MIN");
    expect(G.cases.length).toBe(352);
  });

  it.each(G.cases.map((c, i) => [`${c.record} ${c.fixture} ${JSON.stringify(c.context)} #${i}`, c] as const))("%s", (_label, c) => {
    const view = buildDsProvenanceViewMin(inputOf(c));
    expect(view.kind).toBe("ds_provenance_min");
    if (view.kind !== "ds_provenance_min") return;
    const e = c.expected;
    for (const layer of ["l1", "l2", "l3", "l4"] as const) if (layer in e) expect(view[layer]).toEqual(e[layer]);
    if ("d2DenominatorStatement" in e) expect(view.l2?.denominatorStatement).toBe(e.d2DenominatorStatement);
    if ("humanReview" in e || "humanReviewUnavailable" in e) {
      expect("humanReview" in view && "humanReviewUnavailable" in view).toBe(false);
      if ("humanReview" in e) expect(view.humanReview).toEqual(e.humanReview);
      if ("humanReviewUnavailable" in e) {
        expect(view.humanReviewUnavailable).toBe(true);
        expect("humanReview" in view).toBe(false);
      }
    }
    if (c.absentKeysRegex) {
      const re = new RegExp(c.absentKeysRegex, "i");
      expect(allKeys(view).filter((k) => re.test(k))).toEqual([]);
    }
    for (const phrase of c.prohibitedPhrases ?? []) {
      const p = phrase.toLowerCase();
      expect(allKeys(view).filter((k) => k.toLowerCase().includes(p))).toEqual([]);
      expect(generatedStrings(view).filter(([, v]) => v.toLowerCase().includes(p))).toEqual([]);
    }
  });

  it("every golden view has exactly one of humanReview / humanReviewUnavailable and the L6 constant", () => {
    for (const c of G.cases) {
      const v = buildDsProvenanceViewMin(inputOf(c));
      if (v.kind !== "ds_provenance_min") throw new Error("not built");
      expect(("humanReview" in v ? 1 : 0) + ("humanReviewUnavailable" in v ? 1 : 0)).toBe(1);
      expect(v.useAuthorization).toBe("not_authorized_no_policy");
    }
  });
});

// ─── 2. Statement rules: closed vocabulary, claim semantics, keys (I-7, I-12) ─

const STRUCTURAL_PATHS = new Set([
  "version", "surfaceId", "humanReviewUnavailable",
  "l2.rules.envelopeVersion", "l2.dispatchedModels", "l2.recommendingModels", "l2.largestAgreeingGroup", "l2.recommendation.isContested", "l2.humanReviewNeeded",
  "l3.sourcesListedByModels.count",
  "l4.option_clustering_unverified", "l4.evidence_self_reported", "l4.sources_unchecked", "l4.freshness_not_evaluated", "l4.retry_text_not_retained",
  "l4.rules_unversioned", "l4.historical_rules_unknown", "l4.review_history_not_shown", "l4.coverage_partial", "l4.contested",
]);

describe("statement rules over every golden view", () => {
  const views = G.cases.map((c) => buildDsProvenanceViewMin(inputOf(c)));
  const d2 = new RegExp(SEM.d2Regex);
  const vocab = SEM.closedVocabulary;

  it("every generated value is in the closed vocabulary for its path", () => {
    const misses: string[] = [];
    for (const v of views) {
      for (const [p, val] of leaves(v)) {
        if (STORED_PATHS.has(p)) continue;
        const key = p;
        const allowed = vocab[key];
        if (!allowed) {
          // S1R-9: a generated path without a vocabulary entry must be a listed structural number/boolean field.
          const ok = p === "surfaceId" ? ["P1", "P2", "W1", "W2"].includes(val as string) : STRUCTURAL_PATHS.has(p) && (typeof val === "boolean" || typeof val === "number" || val === "unknown");
          if (!ok) misses.push(`unlisted ${p}=${JSON.stringify(val)}`);
          continue;
        }
        if (allowed.includes("<D2_RE>") && typeof val === "string" && d2.test(val)) continue;
        if (allowed.includes(val as string)) continue;
        if (allowed.includes("<stored>")) continue;
        misses.push(`${p}=${JSON.stringify(val)}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("no generated value matches a claim pattern unless it is an approved claim-token value", () => {
    const res = SEM.claimPatterns.map((p) => new RegExp(p, "i"));
    const hits: string[] = [];
    for (const v of views) {
      for (const [p, val] of generatedStrings(v)) {
        if (SEM.approvedClaimTokenValues.includes(val)) continue;
        if (d2.test(val)) continue; // the D-2 template is the owner-approved form (no ratio: checked below)
        for (const re of res) if (re.test(val)) hits.push(`${p}: ${re} in ${val}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("surfaceId is always one of the four in-scope surfaces", () => {
    for (const v of views) if (v.kind === "ds_provenance_min") expect(["P1", "P2", "W1", "W2"]).toContain(v.surfaceId);
  });

  it("the D-2 statement never forms an N-of-M ratio", () => {
    for (const v of views) {
      if (v.kind !== "ds_provenance_min" || !v.l2) continue;
      expect(v.l2.denominatorStatement).not.toMatch(/\b\d+\s*(of|out of|\/)\s*\d+\b/);
    }
  });

  it("no forbidden key and no provider-independence key anywhere (I-7, OS-1(b))", () => {
    const pi = new RegExp(SEM.piKeyRegex, "i");
    const forbidden = new Set(Object.keys(SEM.forbiddenKeys));
    for (const v of views) {
      const keys = allKeys(v);
      expect(keys.filter((k) => forbidden.has(k))).toEqual([]);
      expect(keys.filter((k) => pi.test(k))).toEqual([]);
    }
  });

  it("the option-clustering flag is hard-wired with the exact text on every built view (I-10, U-02(1))", () => {
    expect(OPTION_CLUSTERING_UNVERIFIED_TEXT).toBe(SEM.flagText);
    expect(REVIEW_HISTORY_NOT_SHOWN_TEXT).toBe(SEM.historyText);
    for (const v of views) {
      if (v.kind !== "ds_provenance_min") throw new Error("not built");
      expect(v.l4.option_clustering_unverified).toBe(true);
      expect(v.l4.option_clustering_unverified_text).toBe(SEM.flagText);
      expect(v.l4.option_clustering_unverified_knownDefect).toBe("R5-P1-08");
      expect(v.l4.review_history_not_shown_text).toBe(SEM.historyText);
    }
  });
});

// ─── 3. Scope and viewer context (V-09, I-5) ─────────────────────────────

describe("scope and viewer context", () => {
  const notInScope = [{ surfaceId: "P3" }, { surfaceId: "W3" }, { surfaceId: "W4" }, { surfaceId: "T1" }, { surfaceId: "T2" }, { surfaceId: "personal" }, { surfaceId: "team" }, {}, undefined, null, "P1", 7, []];
  it.each(notInScope.map((s) => [JSON.stringify(s) ?? "undefined", s]))("surface %s → not_built / surface_not_in_initial_scope with no run data (V-09)", (_l, s) => {
    expect(buildDsProvenanceViewMin(STD_INPUT(s, G.fixtures.governance[Object.keys(G.fixtures.governance)[0]].record))).toEqual({
      kind: "not_built",
      version: 1,
      reason: "surface_not_in_initial_scope",
    });
  });

  const mismatches: Array<Record<string, unknown>> = [
    { surfaceId: "P1", path: "personal", role: "team_member", mayReadDecisionContent: true },
    { surfaceId: "P1", path: "team_bound", role: "team_member", mayReadDecisionContent: false },
    { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: false },
    { surfaceId: "P1", path: "team_bound", role: "owner", mayReadDecisionContent: true },
    { surfaceId: "P1", path: "personal", role: "personal_reviewer", mayReadDecisionContent: "true" },
    { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true, viewerUid: "u1" },
    { surfaceId: "P2", role: "owner", mayReadDecisionReviewer: false },
    { surfaceId: "P2", role: "team_member", mayReadDecisionReviewer: true },
    { surfaceId: "P2", role: "personal_reviewer" },
    { surfaceId: "W1", role: "owner" },
    { surfaceId: "W1", role: "team_member", mayReadDecisionContent: true },
    { surfaceId: "W1", role: "owner", mayReadDecisionReviewer: true },
    { surfaceId: "W2", admission: "other" },
    { surfaceId: "W2" },
  ];
  it.each(mismatches.map((m) => [JSON.stringify(m), m]))("context %s → viewer_context_mismatch (I-5)", (_l, m) => {
    expect(buildDsProvenanceViewMin(STD_INPUT(m))).toEqual({ kind: "not_built", version: 1, reason: "viewer_context_mismatch" });
  });

  it("every catalogued context builds a view", () => {
    for (const ctx of SEM.contextCatalog) expect(buildDsProvenanceViewMin(STD_INPUT(ctx)).kind).toBe("ds_provenance_min");
  });

  it("non-Decision-Support or invalid adaptive output → input_not_decision_support (D-1(a))", () => {
    const ctx = SEM.contextCatalog[0];
    const ds = STD_INPUT(ctx).publicAdaptiveOutput as Record<string, unknown>;
    const variants: unknown[] = [
      null,
      undefined,
      "x",
      { ...ds, version: 2 },
      { ...ds, schemaId: "ranked_enumeration" },
      { ...ds, result: { ...(ds.result as object), recommendation: "go" } },
      { ...ds, answerShape: "ranked_list" },
    ];
    for (const out of variants) {
      expect(buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicAdaptiveOutput: out })).toEqual({ kind: "not_built", version: 1, reason: "input_not_decision_support" });
    }
  });

  it("a VALID adaptive output of another schema (parser ok) → input_not_decision_support, on every surface", () => {
    const ds = STD_INPUT(SEM.contextCatalog[0]).publicAdaptiveOutput as Record<string, unknown>;
    const ranked = {
      version: 1,
      schemaId: "ranked_enumeration",
      answerShape: "ranked_list",
      classification: ds.classification,
      meta: ds.meta,
      generatedAt: ds.generatedAt,
      result: { items: [], lowConfidenceItems: [], totalModels: 3 },
    };
    for (const ctx of SEM.contextCatalog) {
      expect(buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicAdaptiveOutput: ranked })).toEqual({ kind: "not_built", version: 1, reason: "input_not_decision_support" });
    }
  });

  it("not_built carries no run data", () => {
    const v = buildDsProvenanceViewMin({ ...STD_INPUT({ surfaceId: "P3" }) });
    expect(Object.keys(v).sort()).toEqual(["kind", "reason", "version"]);
  });
});

// ─── 4. Purity, determinism, immutability, environment (ITEM3-PURITY, I-8, I-9) ─

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

describe("purity (ITEM3-PURITY)", () => {
  const surfaces: unknown[] = [...SEM.contextCatalog, { surfaceId: "P3" }, { surfaceId: "W3" }, { surfaceId: "W4" }, { surfaceId: "T1" }, { surfaceId: "T2" }, { surfaceId: "personal" }, { surfaceId: "team" }, undefined];
  const sample = G.cases.filter((_, i) => i % 7 === 0);

  it("deep-frozen inputs never throw, are not mutated, and every context/surface is handled", () => {
    for (const c of sample) {
      for (const s of surfaces) {
        const input = { ...inputOf(c), surfaceRequest: clone(s ?? null) ?? undefined };
        const before = JSON.stringify(input);
        expect(() => buildDsProvenanceViewMin(deepFreeze(input))).not.toThrow();
        expect(JSON.stringify(input)).toBe(before);
      }
    }
  });

  it("build(x) deep-equals build(x) and build(structuredClone(x))", () => {
    for (const c of sample) {
      const x = inputOf(c);
      const a = buildDsProvenanceViewMin(x);
      expect(buildDsProvenanceViewMin(x)).toEqual(a);
      expect(buildDsProvenanceViewMin(structuredClone(x))).toEqual(a);
    }
  });

  it("the output does not alias input arrays or objects", () => {
    const c = G.cases.find((x) => x.kind === "l5" && (x.expected.humanReview as { conditions?: unknown } | undefined)?.conditions)!;
    const input = inputOf(c);
    const v = buildDsProvenanceViewMin(input) as Extract<DsProvenanceViewMin, { kind: "ds_provenance_min" }>;
    const hr = v.humanReview as { conditions?: string[] };
    const rec = input.governanceRecord as { humanReview: { conditions: string[] } };
    expect(hr.conditions).toEqual(rec.humanReview.conditions);
    expect(hr.conditions).not.toBe(rec.humanReview.conditions);
    if (v.l3 && Array.isArray(v.l3.sourcesListedByModels.list)) {
      expect(v.l3.sourcesListedByModels.list).not.toBe((input.publicAdaptiveOutput as { result: { sources: unknown } }).result.sources);
    }
  });

  it("output is identical whatever process.env holds (N-R11-7)", () => {
    const saved = { ...process.env };
    try {
      const expected = sample.map((c) => buildDsProvenanceViewMin(inputOf(c)));
      for (const envCase of [{}, { SOURCE_PUBLISHER_CLASS_ENABLED: "true", SOURCE_AUTHORITY_METADATA_ENABLED: "true" }, { SOURCE_PUBLISHER_CLASS_ENABLED: "false", SOURCE_AUTHORITY_METADATA_ENABLED: "false", NODE_ENV: "production", X: "y" }]) {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, envCase);
        expect(sample.map((c) => buildDsProvenanceViewMin(inputOf(c)))).toEqual(expected);
      }
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("no clock, randomness, logging or network call during build", () => {
    const spies = [
      jest.spyOn(Date, "now"),
      jest.spyOn(Math, "random"),
      jest.spyOn(console, "log"),
      jest.spyOn(console, "warn"),
      jest.spyOn(console, "error"),
      jest.spyOn(console, "info"),
    ];
    const fetchSpy = jest.fn();
    const g = globalThis as { fetch?: unknown };
    const savedFetch = g.fetch;
    g.fetch = fetchSpy;
    try {
      for (const c of sample) buildDsProvenanceViewMin(inputOf(c));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
      g.fetch = savedFetch;
    }
  });

  it("the module imports only the two canonical parsers (no I/O, env, logger or Firebase)", () => {
    const src = readFileSync(join(__dirname, "..", "dsProvenanceViewMin.ts"), "utf-8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./governanceRecordParser", "./persistedOutput"]);
    expect(src).not.toMatch(/process\.env|Date\.now|new Date|Math\.random|console\.|require\(/);
  });

  it("never throws for hostile or malformed inputs (I-9)", () => {
    const throwing = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
    const getter = Object.defineProperty({}, "surfaceRequest", { enumerable: true, get() { throw new Error("boom"); } });
    const cyclic: Record<string, unknown> = { surfaceId: "P1" };
    cyclic.self = cyclic;
    const ctx = SEM.contextCatalog[0];
    const cases: unknown[] = [
      undefined, null, 0, "x", [], throwing, getter,
      { surfaceRequest: cyclic },
      { ...STD_INPUT(ctx), publicResults: throwing },
      { ...STD_INPUT(ctx), publicResults: [throwing, null, 1, "s", [], {}] },
      { ...STD_INPUT(ctx), governanceRecord: throwing },
      { ...STD_INPUT(ctx), publicAdaptiveOutput: throwing },
      { ...STD_INPUT(ctx), surfaceRequest: throwing },
    ];
    for (const x of cases) expect(() => buildDsProvenanceViewMin(x)).not.toThrow();
    // own-property reads go through the descriptor trap, which this proxy does not override: fail closed by scope
    expect(buildDsProvenanceViewMin(throwing)).toEqual({ kind: "not_built", version: 1, reason: "surface_not_in_initial_scope" });
    // a proxy that throws on every trap reaches the catch path: fail closed with no run data
    const allTraps = new Proxy({}, new Proxy({}, { get: () => () => { throw new Error("boom"); } }));
    expect(buildDsProvenanceViewMin(allTraps)).toEqual({ kind: "not_built", version: 1, reason: "input_not_decision_support" });
    expect(buildDsProvenanceViewMin({ ...STD_INPUT(ctx), governanceRecord: allTraps })).toEqual({ kind: "not_built", version: 1, reason: "input_not_decision_support" });
  });
});

// ─── 5. L1 projection rules and raw-only denial (I-6) ─────────────────────

describe("L1 from the authorized projection only", () => {
  const ctx = { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true };
  const rows = [
    { modelId: "a", status: "ok", provider: "openai", requestedModel: "gpt-x", rawText: "RAW-TEXT-SENTINEL", rawTextFull: "RAW-FULL-SENTINEL", tokenUsage: { input: 1, output: 2, total: 3 }, latencyMs: 9, wasTruncatedForStorage: true, rawResponse: "RAWRESPONSE-SENTINEL", errorMessage: "ERR-SENTINEL", actualModel: "ACTUAL-SENTINEL" },
    { modelId: "b", status: "substituted", provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: "anthropic:claude-x", substitutionReason: "provider_error" },
    { modelId: "c", status: "substituted", provider: "deepseek" },
    { modelId: "d", status: "failed", substitutedFrom: "openai:gpt-x" },
    { modelId: "e", status: "error", provider: "", requestedModel: "   " },
    { status: "ok", provider: "p" },
    { modelId: 42, status: "timeout", provider: 7 },
    "not-an-object",
    null,
  ];

  it("maps each projected row field by field (status vocabulary, not_recorded vs unknown, substitutedFrom only on substituted)", () => {
    const v = buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicResults: rows });
    if (v.kind !== "ds_provenance_min") throw new Error("not built");
    expect(v.l1).toEqual([
      { slotId: "a", status: "ok", requestedModel: "gpt-x", answeredByProvider: "openai", contributedRecommendation: "unknown" },
      { slotId: "b", status: "substituted", requestedModel: "deepseek-chat", answeredByProvider: "deepseek", substitutedFrom: "anthropic:claude-x", contributedRecommendation: "unknown" },
      { slotId: "c", status: "substituted", requestedModel: "not_recorded", answeredByProvider: "deepseek", substitutedFrom: "not_recorded", contributedRecommendation: "unknown" },
      { slotId: "d", status: "failed", requestedModel: "not_recorded", answeredByProvider: "not_recorded", contributedRecommendation: "unknown" },
      { slotId: "e", status: "unknown", requestedModel: "unknown", answeredByProvider: "unknown", contributedRecommendation: "unknown" },
      { slotId: "unknown", status: "ok", requestedModel: "not_recorded", answeredByProvider: "p", contributedRecommendation: "unknown" },
      { slotId: "unknown", status: "unknown", requestedModel: "not_recorded", answeredByProvider: "unknown", contributedRecommendation: "unknown" },
      { slotId: "unknown", status: "unknown", requestedModel: "unknown", answeredByProvider: "unknown", contributedRecommendation: "unknown" },
      { slotId: "unknown", status: "unknown", requestedModel: "unknown", answeredByProvider: "unknown", contributedRecommendation: "unknown" },
    ]);
  });

  it("copies no raw-only or legacy pass-through field", () => {
    const text = JSON.stringify(buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicResults: rows }));
    for (const s of ["RAW-TEXT-SENTINEL", "RAW-FULL-SENTINEL", "RAWRESPONSE-SENTINEL", "ERR-SENTINEL", "ACTUAL-SENTINEL", "provider_error"]) expect(text).not.toContain(s);
    for (const k of ["rawText", "rawTextFull", "tokenUsage", "latencyMs", "wasTruncatedForStorage", "rawResponse", "errorMessage", "actualModel", "substitutionReason", "rawRetained", "perModelFieldsRetained"]) {
      expect(allKeys(JSON.parse(text))).not.toContain(k);
    }
  });

  it("a non-array projection gives l1 { slots: 'unknown' }", () => {
    for (const bad of [undefined, null, {}, "rows"]) {
      const v = buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicResults: bad });
      expect(v.kind === "ds_provenance_min" && v.l1).toEqual({ slots: "unknown" });
    }
  });

  it("never groups or counts providers (no inferred independence)", () => {
    const sameProvider = [
      { modelId: "a", status: "ok", provider: "openai" },
      { modelId: "b", status: "ok", provider: "openai" },
    ];
    const v = buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicResults: sameProvider });
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/independen|distinct|shared|diversity|same provider|different provider/i);
  });
});

// ─── 6. Content ceiling on P2/W2 and the L5 disclosure ceilings (D-11(A)) ─

const DECIDED_FULL = (() => {
  const base = GOVERNANCE_FIXTURES.find(([, r]) => r && (r as { humanReview: { status: string } }).humanReview.status === "approved_with_conditions")![1] as Record<string, unknown>;
  const rec = clone(base) as { humanReview: Record<string, unknown> } & Record<string, unknown>;
  rec.humanReview = {
    ...rec.humanReview,
    status: "approved_with_conditions",
    reviewerId: "uid-REVIEWER-SENTINEL",
    reviewedAt: "2026-10-24T15:09:30.143Z",
    comment: "COMMENT-SENTINEL",
    conditions: ["COND-SENTINEL"],
    decidedVia: "single_reviewer",
  };
  return rec;
})();

describe("content ceiling and disclosure ceilings", () => {
  it("P2 and W2 carry no L1–L3 and no data-derived L4 (I-6)", () => {
    for (const ctx of SEM.contextCatalog.filter((c) => c.surfaceId === "P2" || c.surfaceId === "W2")) {
      const v = buildDsProvenanceViewMin(STD_INPUT(ctx, clone(DECIDED_FULL)));
      if (v.kind !== "ds_provenance_min") throw new Error("not built");
      expect(Object.keys(v).sort()).toEqual(["humanReview", "kind", "l4", "surfaceId", "useAuthorization", "version"]);
      expect("coverage_partial" in v.l4 || "contested" in v.l4).toBe(false);
    }
  });

  it("never emits reviewer identity, comment, record timestamps or governanceUpdatedAt, on any context", () => {
    const rec = { ...clone(DECIDED_FULL), updatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2025-12-31T00:00:00.000Z", governanceUpdatedAt: "x" };
    for (const ctx of SEM.contextCatalog) {
      const text = JSON.stringify(buildDsProvenanceViewMin(STD_INPUT(ctx, clone(rec))));
      expect(text).not.toContain("uid-REVIEWER-SENTINEL");
      expect(text).not.toContain("COMMENT-SENTINEL");
      expect(text).not.toContain("2026-01-01T00:00:00.000Z");
      expect(text).not.toContain("2025-12-31T00:00:00.000Z");
      for (const k of ["reviewerId", "recordedBy", "comment", "panelists", "overrideBy", "panelSupport", "finalizer", "traceComplete", "governanceUpdatedAt", "updatedAt", "createdAt", "assignee", "assignedTo"]) {
        expect(allKeys(JSON.parse(text))).not.toContain(k);
      }
    }
  });

  // ITEM5-POS in-scope cells (sealed record) and the complementary absences (ITEM5-NEG, field×column level).
  const COLUMNS: Record<string, Array<Record<string, unknown>>> = {
    P1_owner: [{ surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true }],
    P1_personal_reviewer: [{ surfaceId: "P1", path: "personal", role: "personal_reviewer", mayReadDecisionContent: true }],
    P1_team_viewer: [
      { surfaceId: "P1", path: "team_bound", role: "team_member", mayReadDecisionContent: true },
      { surfaceId: "P1", path: "team_bound", role: "team_reviewer", mayReadDecisionContent: true },
    ],
    P2_owner: [{ surfaceId: "P2", role: "owner", mayReadDecisionReviewer: true }],
    P2_personal_reviewer: [{ surfaceId: "P2", role: "personal_reviewer", mayReadDecisionReviewer: true }],
    W1: [{ surfaceId: "W1", role: "team_member" }, { surfaceId: "W1", role: "team_reviewer" }],
    W2: [{ surfaceId: "W2", admission: "normal" }, { surfaceId: "W2", admission: "drain" }],
  };
  const FIELD_PATH: Record<string, string> = { status: "decision", reviewedAt: "reviewedAt", conditions: "conditions", decidedVia: "decidedVia" };
  const posRecord = G.coverage.find((c) => c.record === "ITEM5-POS")!.expectedResult as { inScopeCells: string[] };

  it("ITEM5-POS: each of the 23 allowed (field, column) cells is emitted with the stored value", () => {
    expect(posRecord.inScopeCells).toHaveLength(23);
    for (const cell of posRecord.inScopeCells) {
      const [field, column] = cell.split("|");
      for (const ctx of COLUMNS[column]) {
        const v = buildDsProvenanceViewMin(STD_INPUT(ctx, clone(DECIDED_FULL)));
        if (v.kind !== "ds_provenance_min" || !v.humanReview || v.humanReview.state !== "decided") throw new Error(`no decided view for ${cell}`);
        const got = (v.humanReview as Record<string, unknown>)[FIELD_PATH[field]];
        const stored = field === "status" ? "approved_with_conditions" : DECIDED_FULL.humanReview[field];
        expect(got).toEqual(stored);
      }
    }
  });

  it("ITEM5-NEG (field×column): every (field, column) not in the allowed set is absent, and identity/panel/trace fields never appear", () => {
    const allowed = new Set(posRecord.inScopeCells);
    for (const [column, ctxs] of Object.entries(COLUMNS)) {
      for (const ctx of ctxs) {
        const v = buildDsProvenanceViewMin(STD_INPUT(ctx, clone(DECIDED_FULL)));
        if (v.kind !== "ds_provenance_min" || !v.humanReview) throw new Error("no view");
        const hr = v.humanReview as Record<string, unknown>;
        for (const field of Object.keys(FIELD_PATH)) {
          if (!allowed.has(`${field}|${column}`)) expect(FIELD_PATH[field] in hr).toBe(false);
        }
        for (const k of ["comment", "finalizerIdentity", "overrideBy", "panelVoteCounts", "panelists", "singlePathIndicator", "singleReviewerIdentity", "supportingReviewerCount", "traceValues", "panelSupport"]) {
          expect(allKeys(v)).not.toContain(k);
        }
      }
    }
  });

  it("a personal reviewer without decision-content authority sees no reviewedAt or conditions on P1, and P2 reviewedAt follows the baseline gate", () => {
    const p1 = buildDsProvenanceViewMin(STD_INPUT({ surfaceId: "P1", path: "personal", role: "personal_reviewer", mayReadDecisionContent: false }, clone(DECIDED_FULL)));
    expect(p1.kind === "ds_provenance_min" && p1.humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only" });
    const p2 = (mayReadDecisionReviewer: boolean, hr: Record<string, unknown>) =>
      buildDsProvenanceViewMin(STD_INPUT({ surfaceId: "P2", role: "personal_reviewer", mayReadDecisionReviewer }, { ...clone(DECIDED_FULL), humanReview: { ...DECIDED_FULL.humanReview, ...hr } }));
    const reviewedAt = (v: DsProvenanceViewMin) => (v.kind === "ds_provenance_min" ? (v.humanReview as Record<string, unknown>).reviewedAt : "not-built");
    expect(reviewedAt(p2(true, {}))).toBe("2026-10-24T15:09:30.143Z");
    expect(reviewedAt(p2(false, {}))).toBeUndefined();
    expect(reviewedAt(p2(true, { reviewerId: "" }))).toBeUndefined();
    expect(reviewedAt(p2(true, { reviewerId: "   " }))).toBe("2026-10-24T15:09:30.143Z"); // baseline: untrimmed truthiness
    expect(reviewedAt(p2(true, { decidedVia: "multi_reviewer_panel" }))).toBeUndefined();
    expect(reviewedAt(p2(true, { decidedVia: null }))).toBeUndefined();
  });

  it("decidedVia: absent → single_or_legacy, unknown values → unknown, never to a personal reviewer or on P2", () => {
    const team = { surfaceId: "W1", role: "team_member" };
    const dv = (hr: Record<string, unknown>, ctx: Record<string, unknown> = team) => {
      const rec = { ...clone(DECIDED_FULL), humanReview: { ...DECIDED_FULL.humanReview, ...hr } };
      if ("decidedVia" in hr && hr.decidedVia === undefined) delete (rec.humanReview as Record<string, unknown>).decidedVia;
      const v = buildDsProvenanceViewMin(STD_INPUT(ctx, rec));
      return v.kind === "ds_provenance_min" ? (v.humanReview as Record<string, unknown>).decidedVia : "not-built";
    };
    expect(dv({ decidedVia: undefined })).toBe("single_or_legacy");
    expect(dv({ decidedVia: "multi_reviewer_owner_override" })).toBe("multi_reviewer_owner_override");
    expect(dv({ decidedVia: "something_else" })).toBe("unknown");
    expect(dv({ decidedVia: { injected: true } })).toBe("unknown");
    expect(dv({}, { surfaceId: "P1", path: "personal", role: "personal_reviewer", mayReadDecisionContent: true })).toBeUndefined();
    expect(dv({}, { surfaceId: "P2", role: "owner", mayReadDecisionReviewer: true })).toBeUndefined();
  });

  it("L5 states: absent → none; unreviewed/pending → pending with no ceiling field; malformed/unsupported → out-of-band unavailable marker only", () => {
    const ctx = SEM.contextCatalog[0];
    const v0 = buildDsProvenanceViewMin(STD_INPUT(ctx, undefined));
    expect(v0.kind === "ds_provenance_min" && v0.humanReview).toEqual({ state: "none" });
    for (const status of ["unreviewed", "pending"]) {
      const v = buildDsProvenanceViewMin(STD_INPUT(ctx, { ...clone(DECIDED_FULL), humanReview: { status, reviewedAt: "2026-10-24T15:09:30.143Z", conditions: ["x"], decidedVia: "single_reviewer" } }));
      expect(v.kind === "ds_provenance_min" && v.humanReview).toEqual({ state: "pending", decision: status, reviewedContent: "run_result_by_id_only" });
    }
    for (const bad of [{ ...clone(DECIDED_FULL), version: 2 }, { ...clone(DECIDED_FULL), humanReview: { status: "approved_maybe" } }, "garbage", 5]) {
      const v = buildDsProvenanceViewMin(STD_INPUT(ctx, bad));
      if (v.kind !== "ds_provenance_min") throw new Error("not built");
      expect(v.humanReviewUnavailable).toBe(true);
      expect("humanReview" in v).toBe(false);
      expect(JSON.stringify(v)).not.toMatch(/malformed|unsupported_version/);
    }
  });

  it("no decision time is fabricated: a decided record without reviewedAt emits none (OD-R9-1)", () => {
    const rec = clone(DECIDED_FULL);
    delete (rec.humanReview as Record<string, unknown>).reviewedAt;
    for (const ctx of SEM.contextCatalog) {
      const v = buildDsProvenanceViewMin(STD_INPUT(ctx, rec));
      expect(v.kind === "ds_provenance_min" && "reviewedAt" in (v.humanReview as object)).toBe(false);
      expect(JSON.stringify(v)).not.toContain((rec as { updatedAt?: string }).updatedAt ?? "@@none@@");
    }
  });
});

// ─── 7. Decision Support integrity: denominators, option clustering, no claims ─

describe("Decision Support integrity", () => {
  const ctx = { surfaceId: "W1", role: "team_member" };
  const withResult = (patch: Record<string, unknown>, recPatch: Record<string, unknown> = {}) => {
    const input = STD_INPUT(ctx);
    const out = input.publicAdaptiveOutput as { result: Record<string, unknown> & { recommendation: Record<string, unknown> } };
    Object.assign(out.result, patch);
    Object.assign(out.result.recommendation, recPatch);
    const v = buildDsProvenanceViewMin(input);
    if (v.kind !== "ds_provenance_min") throw new Error("not built");
    return v;
  };

  it("M, K and N stay distinct and exact; the D-2 template uses 'model' only for M = 1", () => {
    const v = withResult({ totalModels: 4 }, { totalModelsWithRecommendation: 3, supportCount: 2 });
    expect([v.l2!.dispatchedModels, v.l2!.recommendingModels, v.l2!.largestAgreeingGroup]).toEqual([4, 3, 2]);
    expect(v.l2!.denominatorStatement).toBe("4 models dispatched; 3 gave a recommendation; largest group recommending the same action: 2.");
    expect(v.l4.coverage_partial).toBe(true);
    const one = withResult({ totalModels: 1 }, { totalModelsWithRecommendation: 1, supportCount: 1 });
    expect(one.l2!.denominatorStatement).toBe("1 model dispatched; 1 gave a recommendation; largest group recommending the same action: 1.");
    expect(one.l4.coverage_partial).toBe(false);
  });

  it("a non-integer or negative count makes that count and the statement 'unknown' (no fabricated denominator)", () => {
    for (const [patch, recPatch] of [[{ totalModels: 2.5 }, {}], [{}, { supportCount: -1 }], [{}, { totalModelsWithRecommendation: "3" }]] as const) {
      const v = withResult(patch, recPatch);
      expect(v.l2!.denominatorStatement).toBe("unknown");
      expect([v.l2!.dispatchedModels, v.l2!.recommendingModels, v.l2!.largestAgreeingGroup]).toContain("unknown");
    }
  });

  it("opposing options merged by the aggregator stay explicitly unverified (U-02(1); no agreement claim)", () => {
    const v = withResult(
      {
        options: [{ id: "opt-1", label: "Approve / Disapprove", source: "model", coverageCount: 3, totalModels: 3, coverageRatio: 1, contributingModels: ["chatgpt", "claude", "gemini"] }],
        totalModels: 3,
      },
      { action: "choose_option", recommendedOptionId: "opt-1", isContested: false, supportCount: 3, totalModelsWithRecommendation: 3 },
    );
    expect(v.l4.option_clustering_unverified).toBe(true);
    expect(v.l4.option_clustering_unverified_text).toBe(SEM.flagText);
    expect(v.l2!.recommendation).toEqual({ action: "choose_option", recommendedOptionId: "opt-1", isContested: false });
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/consensus|converg|unanim|strong|majorit|verified option|agreement on an option is established/i);
    for (const slot of v.l1 as Array<{ contributedRecommendation: string }>) expect(slot.contributedRecommendation).toBe("unknown");
  });

  it("sources are listed as model-supplied and never as verified; freshness is not evaluated", () => {
    const v = withResult({ sources: ["https://example.com/a", "Example report"], sourceBacked: true });
    expect(v.l3!.sourcesListedByModels).toEqual({ list: ["https://example.com/a", "Example report"], count: 2 });
    expect(v.l3!.sourceCheck).toBe("not_evaluated");
    expect(v.l3!.freshness).toBe("not_evaluated");
    expect(v.l4.sources_unchecked).toBe(true);
    expect(allKeys(v)).not.toContain("sourceBacked");
    expect(JSON.stringify(v)).not.toMatch(/source-backed|verified source|sourceVerified/i);
  });

  it("no operational-use authorization and no recomputed consensus tier", () => {
    const v = withResult({});
    expect(v.useAuthorization).toBe("not_authorized_no_policy");
    expect(allKeys(v)).not.toContain("consensusLevelShown");
    expect(allKeys(v)).not.toContain("authorizedForUse");
  });
});

// ─── 8. Independent-review corrections (S1R-1 … S1R-7) ────────────────────

describe("independent-review corrections", () => {
  const ctx = { surfaceId: "W1", role: "team_member" };
  const dsWith = (mutate: (result: Record<string, unknown>, rec: Record<string, unknown>) => void) => {
    const input = STD_INPUT(ctx);
    const out = input.publicAdaptiveOutput as { result: Record<string, unknown> & { recommendation: Record<string, unknown> } };
    mutate(out.result, out.result.recommendation);
    const v = buildDsProvenanceViewMin(input);
    if (v.kind !== "ds_provenance_min") throw new Error("not built");
    return v;
  };

  it("S1R-1: a DS output persisted without `sources` / `assessments` (pre-b8e3e62 shape) shows 'unknown', never '0 sources listed'", () => {
    const v = dsWith((r) => {
      delete r.sources;
      delete r.assessments;
      r.sourceBacked = true;
    });
    expect(v.l3!.sourcesListedByModels).toEqual({ list: "unknown", count: "unknown" });
    expect(v.l3!.modelSelfReportedEvidenceStrength).toBe("unknown");
    expect(allKeys(v)).not.toContain("sourceBacked");
  });

  it("S1R-2 / S1R-5: counts must print in plain base-10 digits; -0 is normalised to 0", () => {
    for (const big of [1e21, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const v = dsWith((r) => {
        r.totalModels = big;
      });
      expect(v.l2!.dispatchedModels).toBe("unknown");
      expect(v.l2!.denominatorStatement).toBe("unknown");
    }
    const z = dsWith((r, rec) => {
      r.totalModels = 2;
      rec.totalModelsWithRecommendation = -0;
      rec.supportCount = -0;
    });
    expect(Object.is(z.l2!.recommendingModels, 0)).toBe(true);
    expect(Object.is(z.l2!.largestAgreeingGroup, 0)).toBe(true);
    expect(z.l2!.denominatorStatement).toMatch(new RegExp(SEM.d2Regex));
  });

  it("S1R-3: the context is read once; a getter that changes after validation cannot widen disclosure or relabel the surface", () => {
    let reads = 0;
    const flipping = {
      surfaceId: "P1",
      path: "personal",
      role: "personal_reviewer",
      get mayReadDecisionContent() {
        reads += 1;
        return reads > 1;
      },
    };
    const v = buildDsProvenanceViewMin(STD_INPUT(flipping, clone(DECIDED_FULL)));
    if (v.kind !== "ds_provenance_min") throw new Error("not built");
    expect(v.humanReview).toEqual({ state: "decided", decision: "approved_with_conditions", reviewedContent: "run_result_by_id_only" });
    let sReads = 0;
    const relabel = {
      get surfaceId() {
        sReads += 1;
        return sReads > 1 ? "P2" : "W1";
      },
      role: "team_member",
    };
    const w = buildDsProvenanceViewMin(STD_INPUT(relabel, clone(DECIDED_FULL)));
    expect(w.kind === "ds_provenance_min" && w.surfaceId).toBe("W1");
  });

  it("S1R-4: holes in sparse arrays become explicit unknown entries (dense output)", () => {
    const rows: unknown[] = [];
    rows[2] = { modelId: "c", status: "ok", provider: "p" };
    const v = buildDsProvenanceViewMin({ ...STD_INPUT(ctx), publicResults: rows });
    if (v.kind !== "ds_provenance_min" || !Array.isArray(v.l1)) throw new Error("no l1");
    expect(v.l1).toHaveLength(3);
    expect(Object.keys(v.l1)).toEqual(["0", "1", "2"]);
    expect(v.l1[0]).toEqual({ slotId: "unknown", status: "unknown", requestedModel: "unknown", answeredByProvider: "unknown", contributedRecommendation: "unknown" });
    const sparseSources: unknown[] = [];
    sparseSources[1] = "s";
    const s = dsWith((r) => {
      r.sources = sparseSources;
    });
    expect(s.l3!.sourcesListedByModels).toEqual({ list: ["unknown", "s"], count: 2 });
  });

  it("S1R-7: inherited (prototype-polluted) keys are never read as input", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.surfaceRequest = { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true };
    proto.publicAdaptiveOutput = STD_INPUT(ctx).publicAdaptiveOutput;
    try {
      expect(buildDsProvenanceViewMin(null)).toEqual({ kind: "not_built", version: 1, reason: "surface_not_in_initial_scope" });
      expect(buildDsProvenanceViewMin({})).toEqual({ kind: "not_built", version: 1, reason: "surface_not_in_initial_scope" });
    } finally {
      delete proto.surfaceRequest;
      delete proto.publicAdaptiveOutput;
    }
  });
});
