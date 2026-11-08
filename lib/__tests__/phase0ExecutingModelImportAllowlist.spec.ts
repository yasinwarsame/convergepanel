/**
 * Phase 0 compatibility restoration — H-14 import allowlist (owner ruling O16, 2026-11-08).
 *
 * Decision modules may import executing-model (independent-voice) symbols ONLY as listed below — an explicit, narrow,
 * per-file, per-symbol allowlist with no wildcards. Any other import of an executing-model module into a decision module
 * (static, type-only, re-export, dynamic `import()` or `require`) fails, as does any listed symbol that disappears (the
 * list must be re-ruled, never silently widened). The modules that must import NO executing-model symbol at all are
 * listed with an empty allowance.
 *
 * The allowance is narrow in USE as well as in import: `MIN_INDEPENDENT_SYNTHESIS_MODELS` in verificationGate.ts feeds
 * the coverage label only (never `status`), and `executingVoiceName` in lib/consensus.ts names voices only (never a
 * cluster, a count or the ≥ 2 rule). The behavioural halves below fail on MU-imp (coverage fed into the gate status)
 * and on MU-dec-* (an executing-model reduction re-added to a decision path): the decision outputs must not depend on
 * the executing provider a row records.
 */
import { readFileSync } from "fs";
import { join, dirname, normalize } from "path";
import { computeVerificationGate, type VerificationGateInput } from "@/lib/verificationGate/verificationGate";
import { synthesizeReport } from "@/lib/consensus";
import { buildAgreementMap } from "@/lib/agreementMap";
import { computeSynthesisConsensusScoring } from "@/lib/verification/consensusScoring";
import { authoritativeSynthesisInputs, MIN_AUTHORITATIVE_SYNTHESIS_ROWS } from "@/lib/synthesis/authoritativeRunInputs";
import { buildPanelVerdict } from "@/lib/verificationGate/panelVerdict";
import type { ModelResult } from "@/lib/types";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";

const ROOT = process.cwd();

/** Executing-model (independent-voice) modules: every module the connector branch added for executing-model identity. */
const EXECUTING_MODEL_MODULES = [
  "lib/panel/independentVoices",
  "lib/panel/executingVoiceLabel",
  "lib/panel/storedDisagreementIndependence",
  "lib/panel/storedVerificationIndependence",
  "lib/governance/queueVerificationAgreement",
  "lib/adaptiveSchema/verdictIndependence",
  "lib/verification/claimConsensusPresentation",
  "lib/verification/cachedClaimProvenance",
  "components/adaptive/useRunIndependence",
] as const;

/** O16: decision module → executing-model module → the exact symbols it may import ("type X" for a type-only import). */
const ALLOWLIST: Record<string, Partial<Record<(typeof EXECUTING_MODEL_MODULES)[number], string[]>>> = {
  // executingVoiceName: attribution names in the unified-answer HTML only.
  "lib/consensus.ts": { "lib/panel/executingVoiceLabel": ["executingVoiceName"] },
  // MIN_INDEPENDENT_SYNTHESIS_MODELS: the coverage label only.
  "lib/verificationGate/verificationGate.ts": { "lib/panel/independentVoices": ["MIN_INDEPENDENT_SYNTHESIS_MODELS"] },
  // executingVoiceName: attribution names in the adaptive narrative only.
  "lib/adaptiveSchema/synthesisReport.ts": { "lib/panel/executingVoiceLabel": ["executingVoiceName"] },
  // Presentation helpers only (verdict counts / headings / recorded differences; grounding reads the stored list).
  "lib/verificationGate/panelVerdict.ts": {
    "lib/panel/executingVoiceLabel": ["executingVoiceName", "independentVoiceCount", "type ExecutingIdentityRow"],
    "lib/panel/independentVoices": ["rowsRecordExecutionIdentity", "type ClientSynthesisRow"],
    "lib/panel/storedDisagreementIndependence": [
      "classifyDisagreementAgainstRows",
      "QUALIFIED_DISAGREEMENT_TEXT",
      "rowsCollapsed",
      "type QualifiedDisagreementBasis",
    ],
  },
  // Presentation helpers only: the additive DTO keys (consensusWithheld, modelIndependence, qualifiedDisagreements,
  // singleModelAssessment); the 35933c8 base fields never read them.
  "app/api/governance/queue/route.ts": {
    "lib/panel/independentVoices": ["consensusScoreWithheldReason", "type ConsensusScoreWithheldReason", "type StoredConsensusIndependence"],
    "lib/panel/storedVerificationIndependence": ["storedVerificationConsensusIndependence"],
    "lib/governance/queueVerificationAgreement": ["buildQueueVerificationAgreement"],
    "lib/panel/storedDisagreementIndependence": [
      "classifyStoredDisagreement",
      "storedRunIndependenceContext",
      "type QualifiedDisagreementBasis",
      "type StoredRunIndependenceContext",
    ],
  },
  // No executing-model import at all.
  "lib/adaptiveSchema/orchestrate.ts": {},
  "lib/agreementMap.ts": {},
  "lib/adaptiveSchema/biasDetection.ts": {},
  "lib/verification/consensusScoring.ts": {},
  "lib/synthesis/authoritativeRunInputs.ts": {},
};

type ImportRecord = { module: string; symbols: string[]; wildcard: boolean; form: string };

function resolveSpecifier(fromFile: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith(".")) p = normalize(join(dirname(fromFile), spec));
  else return null;
  return p.replace(/\.(tsx?|jsx?)$/, "").replace(/\\/g, "/");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every import / re-export / dynamic import / require of `file`, resolved to repo paths. */
function importsOf(file: string): ImportRecord[] {
  const src = stripComments(readFileSync(join(ROOT, file), "utf8"));
  const out: ImportRecord[] = [];
  const named = (clause: string, typeOnly: boolean) =>
    clause
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const t = s.startsWith("type ") || typeOnly;
        const name = s.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        return t ? `type ${name}` : name;
      });
  const re = /\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const mod = resolveSpecifier(file, m[4]);
    if (!mod) continue;
    const typeOnly = !!m[2];
    const clause = m[3].trim();
    const brace = clause.match(/\{([\s\S]*)\}/);
    const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    const wildcard = clause.includes("*") || (outside.length > 0 && !/^type$/.test(outside));
    out.push({ module: mod, symbols: brace ? named(brace[1], typeOnly) : [], wildcard, form: m[1] });
  }
  for (const m of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    const mod = resolveSpecifier(file, m[1]);
    if (mod) out.push({ module: mod, symbols: [], wildcard: true, form: "side-effect" });
  }
  for (const m of src.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) {
    const mod = resolveSpecifier(file, m[1]);
    if (mod) out.push({ module: mod, symbols: [], wildcard: true, form: "dynamic" });
  }
  return out;
}

describe("H-14 / O16: executing-model imports into decision modules — explicit allowlist, no wildcards", () => {
  it("the allowlist itself has no wildcard entries", () => {
    for (const perModule of Object.values(ALLOWLIST)) {
      for (const syms of Object.values(perModule)) for (const s of syms ?? []) expect(s).toMatch(/^(type )?[A-Za-z_$][\w$]*$/);
    }
  });

  it.each(Object.keys(ALLOWLIST))("%s imports exactly its allowed executing-model symbols", (file) => {
    const em = importsOf(file).filter((r) => (EXECUTING_MODEL_MODULES as readonly string[]).includes(r.module));
    const actual: Record<string, string[]> = {};
    for (const r of em) {
      expect([file, r.module, r.form, r.wildcard]).toEqual([file, r.module, r.form, false]);
      actual[r.module] = [...(actual[r.module] ?? []), ...r.symbols];
    }
    const allowed = ALLOWLIST[file];
    const norm = (o: Record<string, string[] | undefined>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [...(v ?? [])].sort()]).sort(([a], [b]) => a.localeCompare(b)));
    expect(norm(actual)).toEqual(norm(allowed as Record<string, string[]>));
  });

  it("the parser sees every import form (self-check on a synthetic module)", () => {
    // A control so the allowlist cannot pass vacuously: the same parser over this spec file finds its own imports.
    const own = importsOf("lib/__tests__/phase0ExecutingModelImportAllowlist.spec.ts").map((r) => r.module);
    expect(own).toEqual(expect.arrayContaining(["lib/verificationGate/verificationGate", "lib/consensus", "lib/agreementMap"]));
  });

  it("verificationGate.ts: MIN_INDEPENDENT_SYNTHESIS_MODELS is read only by the coverage-label helper", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/verificationGate/verificationGate.ts"), "utf8"));
    const uses = [...src.matchAll(/MIN_INDEPENDENT_SYNTHESIS_MODELS/g)].map((m) => m.index!);
    const helper = src.indexOf("function reducedIndependentCoverage(");
    const helperEnd = src.indexOf("\n}\n", helper);
    expect(uses.length).toBe(2); // the import and the one comparison
    expect(uses[1]).toBeGreaterThan(helper);
    expect(uses[1]).toBeLessThan(helperEnd);
    // The status is the 35933c8 computation over the full stored signals in both branches.
    expect(src).toMatch(/const status = determineStatus\(extractMetrics\(\{ \.\.\.input, disagreements: all \}\)\);/);
    expect(src).toMatch(/const status = determineStatus\(baseline\);/);
    expect(src).not.toMatch(/stricterStatus|STATUS_SEVERITY/);
  });

  it("lib/consensus.ts: executingVoiceName is reached only through the voiceName naming helper", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/consensus.ts"), "utf8"));
    expect([...src.matchAll(/executingVoiceName\(/g)]).toHaveLength(1);
    expect(src).toMatch(/const voiceName = \(id: ModelId \| string\): string => executingVoiceName\(String\(id\), successfulResults\);/);
    expect(src).toMatch(/const successfulResults = results\.filter\(\(r\) => isUsableResult\(r\) && getModelText\(r\)\.trim\(\)\.length > 0\);/);
  });
});

// ── Behavioural half: decision outputs never depend on the executing provider a row records (MU-imp / MU-dec-*) ──────

const TEXT = (i: number) =>
  [
    "Paris is the capital of France. The city sits on the Seine. It has about two million residents.",
    "Paris is the capital of France. The city sits on the Seine. Its metro area is far larger.",
    "Lyon is the capital of France. The city sits on the Rhone. It has about half a million residents.",
    "Paris is the capital of France. The Seine crosses the city. Tourism is a major industry.",
  ][i % 4];
const SLOTS = ["chatgpt", "claude", "grok", "gemini", "perplexity"] as const;

/** Rows for a slot set, every substituted slot answered by one provider (DeepSeek) — or by its own provider. */
function rows(spec: Array<"ok" | "sub" | "failed">, providerMode: "deepseek" | "distinct" | "none"): ModelResult[] {
  return spec.map((s, i) => {
    const modelId = SLOTS[i];
    const provider = providerMode === "none" ? undefined : providerMode === "deepseek" && s === "sub" ? "deepseek" : modelId;
    return {
      modelId,
      status: s === "sub" ? "substituted" : s === "ok" ? "ok" : "failed",
      rawText: s === "failed" ? "" : TEXT(i),
      ...(provider ? { provider } : {}),
      latencyMs: 1,
    } as unknown as ModelResult;
  });
}
const SPECS: Array<Array<"ok" | "sub" | "failed">> = [
  ["sub", "sub"],
  ["sub", "sub", "ok"],
  ["sub", "sub", "sub", "sub", "ok"],
  ["ok", "ok"],
  ["ok", "failed"],
  ["sub", "failed"],
  ["sub", "sub", "failed", "ok"],
  ["ok", "ok", "ok", "sub"],
];

describe("H-14 behaviour: the executing provider never reaches a Phase 0 decision output", () => {
  it.each(SPECS.map((s) => [s.join("+"), s] as const))("%s: client report decisions (null-ness, clusters, trust summary) are provider-invariant", (_n, spec) => {
    const outs = (["deepseek", "distinct", "none"] as const).map((mode) => {
      const report = synthesizeReport(rows(spec, mode));
      return report === null ? null : { ...report.consensusAnalysis, unifiedAnswer: undefined };
    });
    expect(outs[0]).toEqual(outs[1]);
    expect(outs[0]).toEqual(outs[2]);
    // The ≥ 2 rule counts usable slots (35933c8).
    const usable = spec.filter((s) => s !== "failed").length;
    expect(outs[0] === null).toBe(usable < 2);
  });

  it.each(SPECS.map((s) => [s.join("+"), s] as const))("%s: agreement map is provider-invariant", (_n, spec) => {
    expect(buildAgreementMap(rows(spec, "deepseek"))).toEqual(buildAgreementMap(rows(spec, "distinct")));
  });

  it.each(SPECS.map((s) => [s.join("+"), s] as const))("%s: synthesis admission and scoring are provider-invariant (usable slots)", (_n, spec) => {
    const persisted = (mode: "deepseek" | "distinct" | "none") => ({
      question: "q",
      runDocument: {
        question: "q",
        perModel: rows(spec, mode).map((r: any) => ({ modelId: r.modelId, status: r.status, rawTextTruncated: r.rawText, ...(r.provider ? { provider: r.provider } : {}) })),
      },
    });
    const adm = (["deepseek", "distinct", "none"] as const).map((m) => authoritativeSynthesisInputs(persisted(m)));
    const usable = spec.filter((s) => s !== "failed").length;
    for (const a of adm) expect([a.ok, a.ok ? a.value.rows.length : 0]).toEqual([usable >= MIN_AUTHORITATIVE_SYNTHESIS_ROWS, usable >= 2 ? usable : 0]);
    const synthesis = {
      keyFindings: [{ claim: "Paris is the capital of France.", evidenceRefs: ["r1"], modelsSupporting: SLOTS.slice(0, spec.length) }],
      disagreements: [],
      biasAndBlindSpots: [],
    } as unknown as StructuredSynthesis;
    const score = (mode: "deepseek" | "distinct" | "none") =>
      computeSynthesisConsensusScoring({
        synthesis,
        results: rows(spec, mode).map((r: any) => ({ modelId: r.modelId, status: r.status, rawText: r.rawText, ...(r.provider ? { provider: r.provider } : {}) })),
        sourceBacked: true,
        runId: "r",
      });
    const noClock = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === "timestamp" ? undefined : v)));
    expect(noClock(score("deepseek"))).toEqual(noClock(score("distinct")));
    expect(noClock(score("deepseek"))).toEqual(noClock(score("none")));
  });

  it("panel verdict grounding reads the stored disagreement list whatever the rows (L13)", () => {
    const report = {
      executiveSummary: "s",
      // The stored disagreement topic carries the only source language, so grounding depends on reading it (L13).
      keyFindings: [{ claim: "Paris is the capital of France.", confidence: "High", evidenceRefs: ["r1"], modelsSupporting: ["chatgpt", "claude"] }],
      disagreements: [{ topic: "According to the census report the population figure differs", whyTheyDiffer: "w", positionsByModel: { chatgpt: "2m", claude: "2.1m" } }],
      biasAndBlindSpots: [],
      openQuestions: [],
      methodology: "m",
    } as unknown as StructuredSynthesis;
    const gate = computeVerificationGate({ keyFindings: report.keyFindings as any, disagreements: report.disagreements as any, biasAndBlindSpots: [], openQuestions: [], sourceBacked: false, questionLength: 30 });
    const g = (r: ModelResult[] | undefined, crossModel?: boolean) => buildPanelVerdict("q", report, gate, r, crossModel === undefined ? undefined : { crossModel }).grounding;
    const base = g(undefined);
    expect(base.level).toBe("source-backed");
    expect(g(rows(["sub", "sub"], "deepseek"), false)).toEqual(base);
    expect(g(rows(["sub", "sub"], "none"))).toEqual(base);
    expect(g(rows(["ok", "ok"], "distinct"))).toEqual(base);
  });

  it("MU-imp oracle: gate status is invariant to every coverage / independence input (seeded, both branches)", () => {
    let seed = 20261108;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    let nonSafe = 0;
    for (let i = 0; i < 2000; i++) {
      const nf = 1 + Math.floor(rand() * 4);
      const keyFindings = Array.from({ length: nf }, (_, k) => ({
        claim: `Claim ${k} about the founding in 17${80 + k}`,
        confidence: pick(["High", "Medium", "Low", "Mixed"] as const),
        evidenceRefs: rand() < 0.5 ? [] : ["r1"],
        modelsSupporting: SLOTS.slice(0, 1 + Math.floor(rand() * 4)),
      }));
      const nd = Math.floor(rand() * 4);
      const disagreements = Array.from({ length: nd }, (_, k) => ({
        topic: pick(["Founding date", "Which archive should be consulted first for the study", "Minor nuance"]) + ` ${k}`,
        positionsByModel: Object.fromEntries(SLOTS.slice(0, 2 + Math.floor(rand() * 3)).map((m, j) => [m, `position ${j % (1 + Math.floor(rand() * 3))}`])),
        whyTheyDiffer: rand() < 0.5 ? "short" : "A long explanation of why the models differ on this point, citing several distinct sources and years.",
      }));
      const input: VerificationGateInput = {
        keyFindings: keyFindings as any,
        disagreements,
        biasAndBlindSpots: rand() < 0.3 ? ["bias"] : [],
        openQuestions: rand() < 0.3 ? ["open?"] : [],
        trustSummary: rand() < 0.5 ? { strongConsensus: Math.floor(rand() * 3), contestedAreas: Math.floor(rand() * 3), uncertainPoints: Math.floor(rand() * 3) } : undefined,
        sourceBacked: rand() < 0.5,
        questionLength: 20 + Math.floor(rand() * 200),
      };
      const full = computeVerificationGate(input).status;
      if (full !== "SAFE_TO_EXPLORE") nonSafe++;
      for (const variant of [
        { independentModelCount: 0 },
        { independentModelCount: 1 },
        { independentModelCount: Number.NaN },
        { independentModelCount: 2 },
        { executionProvenanceUnverified: true },
        { independentModelCount: 2, independentDisagreements: disagreements.slice(0, 1) },
        { independentModelCount: 2, independentDisagreements: [] },
        { independentDisagreements: disagreements.slice(1) },
        { independentModelCount: 3, independentDisagreements: [], independenceUnverifiedDisagreements: disagreements },
      ] as Array<Partial<VerificationGateInput>>) {
        expect(computeVerificationGate({ ...input, ...variant }).status).toBe(full);
      }
    }
    // Both directions exercised: permissive (SAFE) and stricter statuses occur in the generated set.
    expect(nonSafe).toBeGreaterThan(100);
    expect(nonSafe).toBeLessThan(1900);
  });
});
