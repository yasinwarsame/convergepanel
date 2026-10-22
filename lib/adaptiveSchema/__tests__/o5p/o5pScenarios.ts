/**
 * Order 5 Contract P — deterministic scenario fixtures shared by the baseline oracle capture (run once at 2c17feee) and
 * the committed historical-parity and builder-purity tests. Synthetic data only; every model call is a jest mock.
 *
 * Claim text convention (read only by the clustering mock): "[k:<topic>]" names the proposition a claim belongs to and
 * "[p]" marks a partial position. The mock strips both before the text reaches a cell excerpt.
 */

import type { ModelId, ModelResult } from "@/lib/types";

export const ROSTER: ModelId[] = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

export const CLASSIFICATION_BASE = {
  domain: "test",
  quantExpected: false,
  timeSensitivity: "low",
  userIntent: "get_answer",
  confidence: 0.9,
  riskLevel: "professional",
  evidenceRequirement: "medium",
  freshness: "timeless",
  inputType: "text",
  verificationMethod: "cross_model_consistency",
  requestedCount: null,
  requiresClarification: false,
  rationale: "o5p fixture",
} as const;

export const TOPICS: Record<string, string> = {
  wage: "Raising the minimum wage reduces employment",
  tariff: "Tariffs protect domestic manufacturing jobs",
  rates: "Interest rates will fall next year",
  housing: "Housing prices will cool",
  anchored: "Inflation expectations remain anchored",
  productivity: "Productivity growth will accelerate",
  statute: "The state statute preempts local ordinances",
  dosing: "Weekly dosing improves adherence",
};

export type NarrativeMode = "ok" | "fail" | "mismatch" | "agreement_prose";
export interface MockMode {
  narrative: NarrativeMode;
  bias: boolean;
  coverage: boolean;
  backfill: boolean;
}

export const DEFAULT_MODE: MockMode = { narrative: "ok", bias: true, coverage: true, backfill: true };

const stripTags = (s: string) => s.replace(/\[k:[a-z]+\]\s*/g, "").replace(/\[p\]\s*/g, "").trim();
const tagOf = (s: string) => /\[k:([a-z]+)\]/.exec(s)?.[1] ?? null;

/** The Gemini connector mock: clustering, backfill, narrative, bias and coverage calls, by system prompt. */
export function geminiMockImpl(mode: MockMode) {
  return async (msg: string, _ctx: unknown, _key: unknown, opts: any) => {
    const sys = String(opts?.systemPromptOverride ?? "");
    const ok = (body: unknown) => ({ modelId: "gemini", status: "ok", rawText: JSON.stringify(body), latencyMs: 1 });
    if (sys.includes("You are reconciling claims")) {
      const groups = msg.split("\n").filter(Boolean).map((line) => {
        const key = line.slice(0, line.indexOf(":"));
        const members = JSON.parse(line.slice(line.indexOf(":") + 1)) as { claim: string; stance: string }[];
        return { key, members };
      });
      const byTopic = new Map<string, { canonicalText: string; members: { key: string; stance: string; excerpt: string }[] }>();
      for (const g of groups) {
        const first = g.members[0];
        const tag = tagOf(first.claim) ?? `own-${g.key}`;
        const canonicalText = TOPICS[tag] ?? stripTags(first.claim);
        const stance = first.claim.includes("[p]") ? "partial" : first.stance === "asserts" ? "agrees" : first.stance === "disputes" ? "disputes" : "unclear";
        if (!byTopic.has(tag)) byTopic.set(tag, { canonicalText, members: [] });
        byTopic.get(tag)!.members.push({ key: g.key, stance, excerpt: stripTags(first.claim) });
      }
      return ok({ clusters: [...byTopic.values()] });
    }
    if (sys.includes("canonical propositions raised by OTHER models")) {
      if (!mode.backfill) return ok({ answers: [] });
      const keys = msg.split("\n").filter((l) => /^q\d+:/.test(l.trim()) && l.includes(TOPICS.anchored)).map((l) => l.trim().slice(0, l.trim().indexOf(":")));
      return ok({ answers: keys.map((key) => ({ key, hasPosition: true, stance: "agrees", excerpt: "expectations look anchored (paraphrased)" })) });
    }
    if (sys.includes("narrative portion")) {
      if (mode.narrative === "fail") return { modelId: "gemini", status: "error", rawText: null, latencyMs: 1 };
      const topics = (sys.split("Disagreement topics, in order:")[1] ?? "").split("Return ONLY JSON")[0].split("\n").filter((l) => /^\d+\. /.test(l)).length;
      const n = mode.narrative === "mismatch" ? topics + 1 : topics;
      return ok({
        executiveSummary:
          mode.narrative === "agreement_prose"
            ? "Experts are divided on tariffs. ChatGPT stresses jobs while Claude stresses prices."
            : "Tariffs have mixed effects on employment. ChatGPT stresses jobs while Claude stresses prices, and Grok relies on older data.",
        whyModelsDisagree: Array.from({ length: n }, () => "Claude weighs costs while ChatGPT weighs jobs."),
        disagreementStakes: Array.from({ length: n }, (_, i) => (i % 2 ? "decision-critical" : "important")),
        certaintyAssessment: "Evidence varies by sector; Grok relies on older survey data.",
        narrativeSections: [{ title: "Context", body: "Sector data differs. Perplexity cites newer surveys than Gemini." }],
      });
    }
    if (sys.includes("auditing a multi-model AI research panel for shared biases")) {
      if (!mode.bias) return { modelId: "gemini", status: "error", rawText: null, latencyMs: 1 };
      return ok({
        biasAndBlindSpots: [
          {
            biasType: "recency bias",
            description: "ChatGPT and Grok take opposite positions on rates.",
            modelsImplicated: ["chatgpt", "grok"],
            evidence: [{ modelId: "chatgpt", excerpt: "rates will fall sharply", rationale: "Grok disputes this reading." }],
            likelyCauses: ["ChatGPT relies on 2024 data while Grok uses older data"],
            impact: "ChatGPT and Grok take opposite positions on rates.",
            mitigationSteps: ["Ask Claude to reconcile the two readings"],
          },
        ],
      });
    }
    if (sys.includes("auditing a multi-model AI research panel's coverage")) {
      if (!mode.coverage) return { modelId: "gemini", status: "error", rawText: null, latencyMs: 1 };
      return ok({
        gaps: [{ dimension: "Labor market effects", whyItMatters: "ChatGPT and Claude split on jobs, and Grok ignored it entirely.", followUpQuestion: "How do the models compare on jobs?" }],
      });
    }
    return { modelId: "gemini", status: "error", rawText: null, latencyMs: 1 };
  };
}

const claim = (topic: string, text: string, stance: "asserts" | "disputes" | "uncertain", confidence = "majority_view", extra: Record<string, unknown> = {}) => ({
  // Unique per slot after uniqueClaimIds (pass 1 must leave singletons, so the clustering mock is called).
  id: topic,
  claim: `[k:${topic}] ${text}`,
  stance,
  confidence,
  evidenceType: "empirical",
  ...extra,
});

type Slot = { modelId: ModelId; data?: unknown; raw?: string | null; status?: ModelResult["status"]; extra?: Partial<ModelResult> };

/** Claim ids become `<slot><topic>` (no shared slug tokens), so pass-1 slug matching never pre-merges across topics. */
function uniqueClaimIds(data: unknown, modelId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => uniqueClaimIds(d, modelId));
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, uniqueClaimIds(v, modelId)]));
    if (typeof o.claim === "string" && typeof o.id === "string") copy.id = `${modelId}${o.id}`;
    return copy;
  }
  return data;
}

function rows(slots: Slot[]): ModelResult[] {
  return slots.map((s) => ({
    modelId: s.modelId,
    status: s.status ?? "ok",
    rawText: s.raw !== undefined ? s.raw : JSON.stringify(uniqueClaimIds(s.data, s.modelId)),
    latencyMs: 10,
    provider: s.extra?.provider ?? { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" }[s.modelId],
    requestedModel: s.extra?.requestedModel ?? `${s.modelId}-model-1`,
    ...s.extra,
  }));
}

const generic = (keyClaims: unknown[]) => ({ summary: "Summary.", keyClaims, uncertainties: ["U."], followUps: ["F."] });

/** generic: a genuine split, an all-unclear row, an all-dispute row, a consensus row, a partial-only row and an inferred position. */
function genericMixed(): Slot[] {
  return [
    { modelId: "chatgpt", data: generic([claim("wage", "Raising wages cuts jobs.", "asserts"), claim("tariff", "Tariffs protect jobs.", "asserts"), claim("rates", "Rates may fall.", "uncertain"), claim("housing", "Housing will cool.", "disputes"), claim("anchored", "Expectations are anchored.", "asserts"), claim("productivity", "[p] Productivity may rise somewhat.", "asserts")]) },
    { modelId: "claude", data: generic([claim("wage", "Higher minimum wages reduce employment.", "asserts"), claim("tariff", "Tariffs do not protect jobs.", "disputes"), claim("rates", "Rates are hard to call.", "uncertain"), claim("housing", "Housing will not cool.", "disputes"), claim("productivity", "[p] Productivity could improve modestly.", "asserts")]) },
    { modelId: "grok", data: generic([claim("wage", "Wage floors reduce jobs.", "asserts"), claim("tariff", "Tariff effects are unclear.", "uncertain"), claim("rates", "Rate path unclear.", "uncertain"), claim("housing", "No cooling expected.", "disputes")]) },
    { modelId: "perplexity", data: generic([claim("wage", "Minimum wage hikes cut employment.", "asserts"), claim("rates", "Rates uncertain.", "uncertain")]) },
    { modelId: "gemini", data: generic([claim("wage", "Employment falls when wages rise.", "asserts"), claim("rates", "Rates could go either way.", "uncertain")]) },
  ];
}

/** generic, gate pass: broad consensus. */
function genericConsensus(): Slot[] {
  return ROSTER.map((modelId) => ({
    modelId,
    data: generic([claim("wage", `Wages and jobs (${modelId}).`, "asserts", "settled"), claim("anchored", `Expectations anchored (${modelId}).`, "asserts", "settled")]),
  }));
}

/** generic, gate fail: many speculative splits. */
function genericSplits(): Slot[] {
  const t = ["tariff", "rates", "housing", "productivity"];
  return ROSTER.map((modelId, i) => ({
    modelId,
    data: generic(t.map((topic, j) => claim(topic, `${topic} view ${modelId}.`, (i + j) % 2 ? "disputes" : "asserts", "speculative"))),
  }));
}

function contested(): Slot[] {
  const d = (settled: unknown[], disputed: unknown[], metric: number) => ({ summary: "S.", settledClaims: settled, disputedClaims: disputed, keyMetrics: [{ label: "Elasticity", value: metric, unit: "", asOf: "2026", source: "est" }], openQuestions: ["Q."] });
  const camps = { camps: [{ label: "Neoclassical", position: "Jobs fall" }, { label: "Monopsony", position: "Jobs hold" }] };
  return [
    { modelId: "chatgpt", data: d([claim("anchored", "Expectations anchored.", "asserts", "settled")], [claim("wage", "Wages cut jobs.", "asserts", "contested", camps)], -0.1) },
    { modelId: "claude", data: d([claim("anchored", "Anchored expectations.", "asserts", "settled")], [claim("wage", "Wages do not cut jobs.", "disputes", "contested", camps)], -0.1) },
    { modelId: "grok", data: d([], [claim("wage", "Jobs effect contested.", "uncertain", "contested")], -0.3) },
    { modelId: "perplexity", data: d([claim("anchored", "Expectations hold.", "asserts", "settled")], [claim("wage", "Wage floors cut jobs.", "asserts", "contested")], 0) },
  ];
}

function medical(): Slot[] {
  const d = (claims: unknown[]) => ({ summary: "S.", mechanism: "M.", evidenceByTier: claims, guidelinePositions: ["G."], redFlags: ["Chest pain"], clinicianQuestions: ["Q?"] });
  return [
    { modelId: "chatgpt", data: d([claim("dosing", "Weekly dosing improves adherence.", "asserts", "majority_view", { evidenceType: "empirical" })]) },
    { modelId: "claude", data: d([claim("dosing", "Weekly dosing does not improve adherence.", "disputes", "contested", { evidenceType: "authoritative" })]) },
    { modelId: "grok", data: d([claim("dosing", "[p] Weekly dosing may help some patients.", "asserts", "speculative", { evidenceType: "anecdotal" })]) },
  ];
}

function legal(): Slot[] {
  const d = (jurisdiction: string, issues: unknown[]) => ({ applicableRule: "R.", jurisdiction, elements: ["E."], keyAuthority: ["A."], exceptions: ["X."], unsettledIssues: issues, attorneyQuestions: ["Q?"] });
  return [
    { modelId: "chatgpt", data: d("U.S.", [claim("statute", "The statute preempts local rules.", "asserts")]) },
    { modelId: "claude", data: d("US", [claim("statute", "The statute does not preempt local rules.", "disputes")]) },
    { modelId: "grok", data: d("California", [claim("statute", "Preemption is unclear.", "uncertain")]) },
  ];
}

/** financial_valuation: same-model duplicate labels (M-5), units mismatch, non-numeric, single value. */
function financial(): Slot[] {
  const m = (label: string, value: number | null, unit = "x") => ({ label, value, unit, asOf: "2026-09", source: "est" });
  const d = (metrics: unknown[]) => ({ thesis: "T.", metrics, bullCase: "B.", bearCase: "b.", keyAssumptions: ["A."], riskFactors: ["R."] });
  return [
    { modelId: "chatgpt", data: d([m("P/E", 0), m("P/E", 10), m("Revenue", 20, "USD bn"), m("Revenue", 100, "USD bn"), m("Margin", 0.2, "ratio"), m("Beta", null, ""), m("Payout", 45, "%")]) },
    { modelId: "claude", data: d([m("P/E", 0), m("Revenue", 20, "USD bn"), m("Margin", 20, "%"), m("Beta", 1.1, "")]) },
    { modelId: "grok", data: d([m("P/E", 0.001), m("Revenue", 22, "USD bn"), m("Margin", 0.2, "ratio")]) },
  ];
}

/** procedural: disjoint pairs (M-7), identical step, single-slot step. */
function procedural(): Slot[] {
  const d = (actions: string[]) => ({ goal: "G.", prerequisites: ["P."], steps: actions.map((action, i) => ({ order: i + 1, action })), commonFailures: ["F."] });
  return [
    { modelId: "chatgpt", data: d(["Install the package", "Restart the service", "Write a config file"]) },
    { modelId: "claude", data: d(["Install the package", "Restart the service"]) },
    { modelId: "grok", data: d(["Configure firewall rules", "Restart the service"]) },
    { modelId: "perplexity", data: d(["Configure firewall rules", "Restart the service."]) },
  ];
}

function forecast(): Slot[] {
  const s = (label: string, probability: number) => ({ label, probability, narrative: "N.", leadingIndicators: ["I."] });
  const d = (scenarios: unknown[]) => ({ scenarios, baseRates: ["B."], keyUncertainties: ["K."] });
  return [
    { modelId: "chatgpt", data: d([s("Soft landing", 0.45), s("Recession", 0.3)]) },
    { modelId: "claude", data: d([s("Soft landing", 0.45), s("Recession", 0.5)]) },
    { modelId: "grok", data: d([s("Soft landing", 0.7), s("Recession", 0.1)]) },
  ];
}

const factual = (answers: string[]): Slot[] => answers.map((answer, i) => ({ modelId: ROSTER[i], data: { answer, source: "Atlas", caveat: "none" } }));

export interface Scenario {
  name: string;
  schemaId: string;
  results: () => ModelResult[];
  mode?: Partial<MockMode>;
  /** A retry context is supplied and these slots' connectors answer the retry with this data. */
  retry?: { modelId: ModelId; data: unknown }[];
}

export const SCENARIOS: Scenario[] = [
  { name: "generic-mixed", schemaId: "generic", results: () => rows(genericMixed()) },
  { name: "generic-mixed-narrative-fail", schemaId: "generic", results: () => rows(genericMixed()), mode: { narrative: "fail" } },
  { name: "generic-mixed-narrative-mismatch", schemaId: "generic", results: () => rows(genericMixed()), mode: { narrative: "mismatch" } },
  { name: "generic-mixed-agreement-prose", schemaId: "generic", results: () => rows(genericMixed()), mode: { narrative: "agreement_prose" } },
  { name: "generic-consensus", schemaId: "generic", results: () => rows(genericConsensus()) },
  { name: "generic-splits", schemaId: "generic", results: () => rows(genericSplits()) },
  { name: "generic-no-bias-no-coverage", schemaId: "generic", results: () => rows(genericMixed()), mode: { bias: false, coverage: false } },
  {
    name: "generic-substituted-and-failed",
    schemaId: "generic",
    results: () =>
      rows([
        genericMixed()[0],
        { ...genericMixed()[1], status: "substituted", extra: { provider: "deepseek", requestedModel: "deepseek-chat", substitutedFrom: "anthropic:claude-model-1", substitutionReason: "timeout" } },
        { modelId: "grok", raw: null, status: "error", extra: { errorMessage: "boom" } },
        genericMixed()[3],
        genericMixed()[4],
      ]),
  },
  {
    name: "generic-retry",
    schemaId: "generic",
    results: () => rows([genericMixed()[0], genericMixed()[1], { modelId: "grok", raw: "{not json" }, genericMixed()[3]]),
    retry: [{ modelId: "grok", data: genericMixed()[2].data }],
  },
  { name: "generic-malformed", schemaId: "generic", results: () => rows([genericMixed()[0], { modelId: "claude", raw: "{not json" }, { modelId: "grok", raw: JSON.stringify({ summary: 5, keyClaims: "bad" }) }, genericMixed()[3]]) },
  { name: "generic-all-failed", schemaId: "generic", results: () => rows(ROSTER.map((modelId) => ({ modelId, raw: null, status: "error" as const }))) },
  { name: "contested-empirical", schemaId: "contested_empirical", results: () => rows(contested()) },
  { name: "medical-health", schemaId: "medical_health", results: () => rows(medical()) },
  { name: "legal-regulatory", schemaId: "legal_regulatory", results: () => rows(legal()) },
  { name: "financial-valuation", schemaId: "financial_valuation", results: () => rows(financial()) },
  { name: "procedural", schemaId: "procedural", results: () => rows(procedural()) },
  { name: "forecast", schemaId: "forecast_speculative", results: () => rows(forecast()) },
  { name: "factual-normalizer", schemaId: "factual_lookup", results: () => rows(factual(["St. Louis", "St Louis", "St. Louis", "Kansas City"])) },
  { name: "factual-tie", schemaId: "factual_lookup", results: () => rows(factual(["Paris", "Paris", "Lyon", "Lyon"])) },
  { name: "factual-single", schemaId: "factual_lookup", results: () => rows([...factual(["Paris"]), { modelId: "claude", raw: null, status: "error" }]) },
  { name: "creative", schemaId: "creative_generative", results: () => rows([{ modelId: "chatgpt", data: { output: "A poem.", styleNotes: ["n"] } }, { modelId: "claude", data: { output: "Verse.", styleNotes: ["m"] } }]) },
  { name: "graceful-limitation", schemaId: "graceful_limitation", results: () => rows([{ modelId: "chatgpt", data: { limitation: "L.", whyItMatters: "W.", nearestValidAlternative: "N.", clarifyingQuestion: "C?" } }]) },
];

/** R1.3 seeded generator, for breadth (builder purity only). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededResults(schemaId: string, seed: number): ModelResult[] {
  const rnd = mulberry32(seed);
  const n = 3 + (seed % 3);
  const pick = <X,>(xs: X[]) => xs[Math.floor(rnd() * xs.length)];
  const topics = Object.keys(TOPICS);
  return rows(
    ROSTER.slice(0, n).map((modelId) => {
      let data: unknown;
      if (schemaId === "generic") data = generic(Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => { const t = pick(topics); return claim(t, `${t} ${pick(["holds", "fails", "varies"])}.`, pick(["asserts", "asserts", "disputes", "uncertain"]) as any, pick(["settled", "majority_view", "contested", "speculative"])); }));
      else if (schemaId === "financial_valuation") data = { thesis: "T.", metrics: [{ label: "P/E", value: pick([18, 19, 20, 25, 40]), unit: "x", asOf: "2026", source: "est" }, { label: "Growth", value: pick([0.05, 0.06, 0.12]), unit: "%", asOf: "2026", source: "est" }], bullCase: "B.", bearCase: "b.", keyAssumptions: ["A."], riskFactors: ["R."] };
      else if (schemaId === "procedural") data = { goal: "G.", prerequisites: ["P."], steps: [1, 2, 3].map((order) => ({ order, action: pick(["Install the package", "Install the dependency package", "Configure the server", "Restart the service"]) })), commonFailures: ["F."] };
      else if (schemaId === "forecast_speculative") data = { scenarios: [{ label: pick(["Soft landing", "Recession"]), probability: pick([0.4, 0.5, 0.7]), narrative: "N.", leadingIndicators: ["I."] }], baseRates: ["B."], keyUncertainties: ["K."] };
      else data = { answer: pick(["Paris", "Paris", "Lyon", "paris."]), source: "S", caveat: "C" };
      return { modelId, data };
    })
  );
}

export const SEEDED_SCHEMAS = ["generic", "financial_valuation", "procedural", "forecast_speculative", "factual_lookup"];
export const SEEDS = [11, 12, 13, 14, 15, 16];
