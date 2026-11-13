/**
 * Phase 0 compatibility restoration — adaptive (run-panel) decision baseline (inventory v3.4 H-1 / H-2 / H-16, rows L01
 * and L06; owner Option C, 2026-11-08).
 *
 * /api/run-panel's decision code is byte-identical to 35933c8 except for what finalizeAdaptiveRun computes, so this runs
 * the REAL finalizeAdaptiveRun for every active schema family (Decision Support included) over 2- and 3-slot executing
 * patterns (independent, all DeepSeek, partly DeepSeek, provider-less substitutes, failed + substitute, two distinct
 * substitutes) × three content variants, plus the REAL downstream decision consumers (decision receipt, governance record,
 * automated governance, Team routing in all three modes for Milestone-2 / DS families; aligned-claim status, contested,
 * certainty, the adaptive gate, the synthesis report decisions and the trust summary for the legacy claim-matrix
 * families). Gemini is mocked to a deterministic error so every LLM-dependent step takes its deterministic fallback.
 *
 * Every record's DECISION projection (the record minus the attribution-only presentation keys listed in
 * PRESENTATION_ONLY: supporter / disputer names and the narrative text that embeds them) must hash to the 35933c8 value.
 * Oracle (fixtures/phase0AdaptiveDecision.golden.json): THIS file run unchanged in a git-archive export of 35933c8 with
 * PHASE0_GOLDEN_OUT set (scratch probe familyDiff, reduced grid, promoted) — never computed from the code under test.
 */
process.env.TZ = "UTC";

jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), ADAPTIVE_VERIFICATION_ENABLED: true }));
jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: async () => ({ modelId: "gemini", status: "error", rawText: null, errorMessage: "mocked: no network in harness", latencyMs: 0 }),
}));

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildAdaptiveDecisionReceipt } from "@/lib/adaptiveSchema/decisionReceiptBuilder";
import { buildAdaptiveGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordBuilder";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { routeAdaptiveTeamReview } from "@/lib/governance/adaptiveTeamReview";
import { SCHEMA_ANSWER_SHAPE } from "@/lib/adaptiveSchema/persistedOutput";

const GOLDEN = join(__dirname, "fixtures", "phase0AdaptiveDecision.golden.json");
const GOLDEN_OUT = process.env.PHASE0_GOLDEN_OUT;
/** Attribution-only presentation (names of the executing models / narrative embedding them) — retained from b894828. */
const PRESENTATION_ONLY = /^\.synthesisReport\.(unifiedAnswer|executiveSummary)$|^\.synthesisReport\.presentation\..*\.(supporters|disputers)(\.|$)/;
function decisionProjection(rec: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (o: unknown, p: string) => {
    if (PRESENTATION_ONLY.test(p.replace(/\.\d+(?=\.|$)/g, ""))) return;
    if (o && typeof o === "object") {
      const entries = Object.entries(o as Record<string, unknown>);
      if (entries.length === 0) out[p] = Array.isArray(o) ? "[]" : "{}";
      for (const [k, v] of entries) walk(v, `${p}.${k}`);
    } else out[p] = o;
  };
  walk(rec, "");
  return out;
}
const digest = (rec: unknown) => createHash("sha256").update(JSON.stringify(decisionProjection(rec))).digest("hex");
const FIXED = "2026-11-07T12:00:00.000Z";
const SLOT_IDS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"];

type SlotExec = { status: "ok" | "substituted" | "failed"; provider?: string };
type ExecPattern = { id: string; slots: SlotExec[] };
const OK: SlotExec = { status: "ok" };
const SUB = (provider?: string): SlotExec => ({ status: "substituted", ...(provider !== undefined ? { provider } : {}) });
const FAIL: SlotExec = { status: "failed" };

// Identical to dsDiff.spec.tsx (c18) so the two grids share executing patterns.
function execPatterns(n: number): ExecPattern[] {
  const p: ExecPattern[] = [];
  const fill = (f: (i: number) => SlotExec) => Array.from({ length: n }, (_, i) => f(i));
  p.push({ id: "indep", slots: fill(() => OK) });
  p.push({ id: "collapse_all", slots: fill(() => SUB("deepseek")) });
  for (let k = 1; k < n; k++) {
    p.push({ id: `partial_${k}of${n}_tail`, slots: fill((i) => (i >= n - k ? SUB("deepseek") : OK)) });
    p.push({ id: `partial_${k}of${n}_head`, slots: fill((i) => (i < k ? SUB("deepseek") : OK)) });
  }
  for (let k = 2; k <= n; k++) p.push({ id: `unrecorded_${k}of${n}`, slots: fill((i) => (i >= n - k ? SUB(undefined) : OK)) });
  if (n >= 3) p.push({ id: "mixed_recorded_unrecorded", slots: fill((i) => (i === 0 ? OK : i === 1 ? SUB("deepseek") : SUB(undefined))) });
  if (n >= 2) p.push({ id: "mixed_unrecorded_first", slots: fill((i) => (i === 0 ? SUB(undefined) : i === 1 ? SUB("deepseek") : OK)) });
  p.push({ id: "provider_unknown_string", slots: fill((i) => (i >= n - 2 ? SUB("unknown") : OK)) });
  if (n >= 3) p.push({ id: "fail_plus_sub", slots: fill((i) => (i === 0 ? FAIL : i >= n - 2 ? SUB("deepseek") : OK)) });
  if (n >= 4) p.push({ id: "fail2_plus_sub2", slots: fill((i) => (i < 2 ? FAIL : SUB("deepseek"))) });
  p.push({ id: "fail_only", slots: fill((i) => (i === n - 1 ? FAIL : OK)) });
  if (n >= 2) p.push({ id: "two_distinct_substitutes", slots: fill((i) => (i === n - 1 ? SUB("deepseek") : i === n - 2 ? SUB("mistral") : OK)) });
  return p;
}

// Content variants: camp "A"/"B" per slot, and whether each slot also adds items unique to it.
type Camp = "A" | "B";
const VARIANTS: Record<string, { camp: (i: number, n: number) => Camp; unique: boolean }> = {
  same: { camp: () => "A", unique: false },
  last_dissent: { camp: (i, n) => (i === n - 1 ? "B" : "A"), unique: false },
  first_dissent: { camp: (i) => (i === 0 ? "B" : "A"), unique: false },
  split: { camp: (i) => (i % 2 === 1 ? "B" : "A"), unique: false },
  distinct: { camp: () => "A", unique: true },
  distinct_split: { camp: (i) => (i % 2 === 1 ? "B" : "A"), unique: true },
};

function valueFor(type: string, key: string, camp: Camp, i: number, unique: boolean, firstClaimField: boolean): unknown {
  const w = WORDS[i];
  const isSources = /sources?$/i.test(key);
  switch (type) {
    case "string":
      return camp === "A"
        ? `The established ${key} is that municipal recycling programs reduce landfill volume substantially.`
        : `A contrary ${key}: municipal recycling programs mostly shift waste costs rather than reduce volume.`;
    case "string[]": {
      const base = isSources
        ? camp === "A"
          ? [`https://example.test/${key}-shared`]
          : [`https://example.test/${key}-contrary`]
        : camp === "A"
          ? [`Shared ${key} point regarding collection frequency`, `Shared ${key} point regarding contamination rates`]
          : [`Contrary ${key} point regarding hauling contract incentives`];
      if (unique) base.push(isSources ? `https://example.test/${key}-unique-${i}` : `Unique ${key} point ${w} specific to response ${i} about ${w} district pilots`);
      return base;
    }
    case "claim[]": {
      if (!firstClaimField) return [];
      const claims: any[] = [
        { id: "curbside-reduces-tonnage", claim: "Curbside recycling reduces landfill tonnage in mid-sized cities", stance: camp === "A" ? "asserts" : "disputes", confidence: camp === "A" ? "majority_view" : "contested", evidenceType: "empirical" },
        { id: "single-stream-contamination", claim: "Single-stream collection increases contamination of paper bales", stance: "asserts", confidence: "settled", evidenceType: "empirical" },
      ];
      if (unique) claims.push({ id: `regional-pilot-${w}`, claim: `Regional pilot ${w} reported unusual glass recovery figures for one quarter`, stance: "asserts", confidence: "speculative", evidenceType: "anecdotal" });
      return claims;
    }
    case "metric[]":
      return [{ label: "Diversion rate", value: camp === "A" ? 32 : 18, unit: "percent", asOf: "2026", source: "https://example.test/metric" }];
    case "step[]":
      return camp === "A"
        ? [{ order: 1, action: "Sort materials by type before collection" }, { order: 2, action: "Rinse containers to reduce contamination" }]
        : [{ order: 1, action: "Contact the hauler to confirm accepted materials" }, { order: 2, action: "Sort materials by type before collection" }];
    case "scenario[]":
      return [{ label: "Base case", probability: camp === "A" ? 0.6 : 0.25, narrative: camp === "A" ? "Diversion keeps rising slowly" : "Diversion stalls as markets weaken", leadingIndicators: ["commodity prices"] }];
    case "enumItem[]": {
      const items: any[] =
        camp === "A"
          ? [
              { id: "alpha-composting-service", label: "Alpha Composting Service", rank: 1, rationale: "Widest coverage" },
              { id: "bravo-hauling-cooperative", label: "Bravo Hauling Cooperative", rank: 2, rationale: "Lowest cost" },
              { id: "charlie-materials-recovery", label: "Charlie Materials Recovery", rank: 3, rationale: "Best sorting" },
            ]
          : [
              { id: "delta-zero-waste-partners", label: "Delta Zero Waste Partners", rank: 1, rationale: "Strong contracts" },
              { id: "charlie-materials-recovery", label: "Charlie Materials Recovery", rank: 2, rationale: "Best sorting" },
              { id: "alpha-composting-service", label: "Alpha Composting Service", rank: 3, rationale: "Widest coverage" },
            ];
      if (unique) items.push({ id: `unique-${w}-reuse-depot`, label: `Unique ${w} Reuse Depot`, rank: 4, rationale: `Only response ${i} lists it`, sources: [`https://example.test/enum-${i}`] });
      return items;
    }
    case "comparisonCell[]": {
      const cells: any[] = [
        { subject: "Curbside", attribute: "Cost", value: camp === "A" ? "Lower per household" : "Higher per household", verdict: camp === "A" ? "better" : "worse" },
        { subject: "Drop-off", attribute: "Cost", value: "Moderate", verdict: "even" },
        { subject: "Curbside", attribute: "Participation", value: "High", verdict: "better" },
        { subject: "Drop-off", attribute: "Participation", value: "Low", verdict: "worse" },
      ];
      if (unique) cells.push({ subject: "Curbside", attribute: `Noise ${w}`, value: `Unique ${w} observation`, sources: [`https://example.test/cell-${i}`] });
      return cells;
    }
    case "distinction[]":
      return [{ concept: camp === "A" ? "Downcycling" : "Upcycling", explanation: camp === "A" ? "Material loses quality each cycle" : "Material gains value through reuse" }].concat(
        unique ? [{ concept: `Concept ${w}`, explanation: `Unique distinction ${w}` }] : []
      );
    case "processStep[]":
      return [{ number: 1, title: camp === "A" ? "Collection" : "Hauling", explanation: "Materials are gathered from households" }];
    case "checklistItem[]": {
      const items: any[] =
        camp === "A"
          ? [
              { id: "confirm-accepted-materials", label: "Confirm accepted materials list", critical: true, severity: "high" },
              { id: "schedule-collection-reminders", label: "Schedule collection day reminders", severity: "medium" },
            ]
          : [{ id: "audit-transfer-contamination", label: "Audit contamination at the transfer station", critical: true, severity: "critical", likelihood: "high", mitigation: "Add inspection" }];
      if (unique) items.push({ id: `unique-${w}-checklist-item`, label: `Unique ${w} checklist item for response ${i}`, severity: "low" });
      return items;
    }
    case "researchFinding[]": {
      const f: any[] = [
        { id: "recycling-reduces-landfill", title: "Recycling reduces landfill volume", summary: camp === "A" ? "Most studies find a substantial reduction" : "Reductions are small once hauling is counted", evidenceStrength: camp === "A" ? "moderate" : "contested", sources: [camp === "A" ? "https://example.test/f1a" : "https://example.test/f1b"] },
        { id: "contamination-lowers-bale-value", title: "Contamination lowers bale value", summary: "Paper bales lose value with contamination", evidenceStrength: "strong" },
      ];
      if (unique) f.push({ id: `unique-finding-${w}`, title: `Unique finding ${w}`, summary: `Only response ${i} reports the ${w} effect`, evidenceStrength: "weak", sources: [`https://example.test/finding-${i}`] });
      return f;
    }
    case "evidenceDimension[]": {
      const d: any[] = [
        { id: "sample-size", dimension: "Sample size", assessment: camp === "A" ? "Adequate across studies" : "Too small to generalize", strength: camp === "A" ? "strong" : "weak" },
        { id: "study-design", dimension: "Study design", assessment: "Mostly observational", strength: "moderate" },
      ];
      if (unique) d.push({ id: `dimension-${w}`, dimension: `Dimension ${w}`, assessment: `Unique assessment ${w}`, strength: "unknown" });
      return d;
    }
    default:
      return undefined;
  }
}

function slotPayload(schema: any, i: number, camp: Camp, unique: boolean) {
  const out: Record<string, unknown> = {};
  let firstClaim = true;
  for (const f of schema.fields) {
    const isFirstClaim = f.type === "claim[]" && firstClaim;
    if (f.type === "claim[]") firstClaim = false;
    const v = valueFor(f.type, f.key, camp, i, unique, isFirstClaim);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

function buildResults(schema: any, exec: ExecPattern, variantId: string) {
  const n = exec.slots.length;
  const variant = VARIANTS[variantId];
  return exec.slots.map((s, i) => {
    const modelId = SLOT_IDS[i];
    if (s.status === "failed") return { modelId, status: "failed", rawText: "Model unavailable.", errorMessage: `${modelId} failed`, latencyMs: 1, requestedModel: `${modelId}-model` };
    const base: any = { modelId, status: s.status, rawText: JSON.stringify(slotPayload(schema, i, variant.camp(i, n), variant.unique)), latencyMs: 1, requestedModel: `${modelId}-model` };
    if (s.status === "substituted") {
      if (s.provider !== undefined) base.provider = s.provider;
      base.actualModel = s.provider === "deepseek" ? "deepseek-chat" : undefined;
      base.substitutedFrom = modelId;
      base.substitutionReason = "primary_timeout";
    } else {
      base.provider = modelId === "chatgpt" ? "openai" : modelId === "claude" ? "anthropic" : modelId === "gemini" ? "google" : modelId === "grok" ? "xai" : "perplexity";
    }
    return base;
  });
}

function classificationFor(schemaId: string): any {
  return {
    queryType: schemaId,
    domain: "test",
    answerShape: (SCHEMA_ANSWER_SHAPE as any)[schemaId] ?? "generic",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "understand",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: 3,
    requiresClarification: false,
    rationale: "test",
  };
}

function sanitize<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>"));
}

const M2 = ["decision_support", "ranked_enumeration", "comparison_matrix", "definition_explanation", "causal_explanation", "checklist_taxonomy", "deep_research", "evidence_review", "bias_blindspot_audit"];
const RESULT_KEY: Record<string, string> = {
  ranked_enumeration: "rankedEnumeration",
  comparison_matrix: "comparisonMatrix",
  definition_explanation: "definitionExplanation",
  causal_explanation: "causalExplanation",
  checklist_taxonomy: "checklistTaxonomy",
  deep_research: "deepResearch",
  evidence_review: "evidenceReview",
  bias_blindspot_audit: "biasBlindspotAudit",
  decision_support: "decisionSupport",
};

it("every family record's decision projection equals 35933c8", async () => {
  const families = Object.keys(SCHEMA_REGISTRY).filter((id) => {
    const s: any = (SCHEMA_REGISTRY as any)[id];
    return s && s.implementationStatus === "active" && id !== "graceful_limitation";
  });
  const byId: Record<string, any> = {};
  for (const family of families) {
    const schema: any = (SCHEMA_REGISTRY as any)[family];
    for (const n of [2, 3]) {
      for (const exec of execPatterns(n).filter((e) => ["indep", "collapse_all", "partial_1of3_tail", "partial_1of2_tail", "unrecorded_2of2", "unrecorded_2of3", "fail_plus_sub", "two_distinct_substitutes"].includes(e.id))) {
        for (const variant of ["same", "split", "distinct"]) {
          const id = `${family}|n${n}|${exec.id}|${variant}`;
          const results = buildResults(schema, exec, variant);
          const out: any = await finalizeAdaptiveRun(schema, results as any, "How effective are municipal recycling programs?", undefined, classificationFor(family));
          const rec: any = { id, family, n, exec: exec.id, variant, adaptiveResultsOk: out.adaptiveResults.map((r: any) => r.ok) };
          if (M2.includes(family)) {
            const po = out.persistedOutput;
            rec.result = out[RESULT_KEY[family]];
            rec.meta = po?.meta ?? null;
            rec.receipt = po ? buildAdaptiveDecisionReceipt(po) : null;
            const gov: any = po ? buildAdaptiveGovernanceRecord({ runId: "run-c19", adaptiveOutput: po, now: FIXED }) : null;
            rec.governanceRecord = gov?.ok ? gov.record : gov;
            const failed = results.filter((r: any) => r.status === "failed").length;
            rec.automatedGovernance = gov?.ok
              ? evaluateAdaptiveGovernance({ governanceRecord: gov.record, policy: { policyVersion: 1, blockIfSourceBackedMissingSources: true, reviewIfAnyModelFailed: true } as any, modelFailureCount: failed, successfulModelCount: results.length - failed, evaluatedAt: FIXED })
              : null;
            rec.teamRouting = gov?.ok
              ? Object.fromEntries(["all", "flagged_only", "human_review_needed"].map((mode) => [mode, routeAdaptiveTeamReview({ humanReviewNeeded: gov.record.decisionReceipt.humanReviewNeeded, automatedGovernanceStatus: rec.automatedGovernance?.status, settings: { enabled: true, mode } as any })]))
              : null;
          } else {
            rec.alignedClaims = out.alignedClaims ?? null;
            rec.gate = out.gate ?? null;
            rec.synthesisReport = out.synthesisReport ?? null;
            rec.trustSummary = out.trustSummary ?? null;
            rec.legacyPersisted = out.persistedLegacyOutput ? { schemaId: out.persistedLegacyOutput.schemaId, hasGate: !!out.persistedLegacyOutput.gate } : null;
          }
          byId[id] = sanitize(rec);
        }
      }
    }
  }
  const digests = Object.fromEntries(Object.entries(byId).map(([id, rec]) => [id, digest(rec)]));
  expect(Object.keys(digests).length).toBe(594);
  if (GOLDEN_OUT) {
    writeFileSync(GOLDEN_OUT, JSON.stringify(digests, null, 1) + "\n");
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")).digests as Record<string, string>;
  expect(Object.keys(digests).sort()).toEqual(Object.keys(golden).sort());
  const differing = Object.keys(golden).filter((id) => digests[id] !== golden[id]);
  expect(differing).toEqual([]);
}, 600000);
