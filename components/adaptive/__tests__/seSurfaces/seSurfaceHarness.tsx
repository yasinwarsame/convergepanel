/**
 * Order 6 / S-E.1 — whole-surface wording harness (test-only).
 *
 * Builds Decision Support (DS) results through the real producer (`buildDecisionSupportResult`) with every
 * model-authored string wrapped in a sentinel ⟦…⟧, renders whole surfaces, and extracts what a reader sees: every text
 * node plus the `title`, `aria-label` and `alt` attributes. The scanner (dsWordingScanner.ts) removes sentinel spans
 * before matching, so wording a model wrote — including quoted evidence — never counts as application wording, while
 * every application string around it is still scanned.
 *
 * Version-agnostic on purpose: it renders only top-level components that exist unchanged at the S-E.1 base
 * (f207e1a), so the non-DS baseline can be captured from unmodified main with the same code.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdaptivePanelResponse from "@/components/adaptive/AdaptivePanelResponse";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { buildDecisionSupportResult, type DecisionSupportFields } from "@/lib/adaptiveSchema/decisionSupportAlignment";
import type { AdaptiveModelResult, DecisionSupportResult, QueryClassification, QueryType } from "@/lib/adaptiveSchema/types";
import type { ModelId } from "@/lib/types";

export const S = (text: string): string => `⟦${text}⟧`;
export const SENTINEL_SPAN = /⟦[^⟦⟧]*⟧/g;

export function classification(queryType: QueryType): QueryClassification {
  return {
    queryType,
    domain: "test",
    answerShape: SCHEMA_REGISTRY[queryType].renderHint,
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
    rationale: "test fixture",
  } as QueryClassification;
}

function fields(over: Partial<DecisionSupportFields> = {}): DecisionSupportFields {
  return {
    decisionQuestion: S("Which vendor should we choose?"),
    options: [],
    criteria: [],
    userProvidedCriteria: [],
    assessments: [],
    recommendationAction: "",
    recommendedOption: "none",
    recommendationRationale: S("Model rationale text."),
    recommendationCaveats: [S("Model caveat text.")],
    assumptions: [S("Model assumption text.")],
    uncertainties: [S("Model uncertainty text.")],
    risks: [{ id: "r1", label: S("Model risk text."), likelihood: "medium", impact: "high", mitigation: S("Model mitigation text.") }],
    sensitivityFindings: [S("Model sensitivity text.")],
    reversibleNextStep: S("Model next step text."),
    sources: [S("Model-listed source")],
    ...over,
  };
}

const OPT_A = S("Option Alpha plan");
const OPT_B = S("Option Bravo route");
const CRIT_1 = S("Total cost");
const CRIT_2 = S("Time to deploy");

function assessed(option: string, strengths: [string, string]): DecisionSupportFields["assessments"] {
  return [
    { id: `${option}-c1`, optionLabel: option, criterionLabel: CRIT_1, assessment: S("Model assessment text."), evidenceStrength: strengths[0] as never },
    { id: `${option}-c2`, optionLabel: option, criterionLabel: CRIT_2, assessment: S("Model assessment text."), evidenceStrength: strengths[1] as never },
  ];
}

function choose(option: string, extra: Partial<DecisionSupportFields> = {}): DecisionSupportFields {
  return fields({
    options: [OPT_A, OPT_B],
    criteria: [CRIT_1, CRIT_2],
    assessments: [...assessed(OPT_A, ["strong", "moderate"]), ...assessed(OPT_B, ["weak", "strong"])],
    recommendationAction: "choose_option",
    recommendedOption: option,
    ...extra,
  });
}

type PerModel = { modelId: ModelId; fields: DecisionSupportFields }[];
const models = (...f: DecisionSupportFields[]): PerModel => f.map((fields, i) => ({ modelId: (["chatgpt", "claude", "gemini", "grok"][i] ?? `m${i}`) as ModelId, fields }));

export type DsFixture = { name: string; result: DecisionSupportResult; perModel: PerModel };

/** The S-E.1 state matrix. Every fixture goes through the real producer; nothing is hand-assembled. */
export function dsFixtures(): DsFixture[] {
  const make = (name: string, perModel: PerModel, totalModels = perModel.length, risk?: "safety_critical"): DsFixture => ({
    name,
    perModel,
    result: buildDecisionSupportResult(perModel, totalModels, risk),
  });
  const approve = S("Approve the vendor contract");
  const disapprove = S("Disapprove the vendor contract");
  const legacy = make("legacy_no_sources_field", models(choose(OPT_A), choose(OPT_A)));
  delete (legacy.result as { sources?: unknown }).sources;
  return [
    make("uncontested_choose_option", models(choose(OPT_A), choose(OPT_A), choose(OPT_A))),
    make("uncontested_go_with_failed_slots", models(fields({ recommendationAction: "go", options: [OPT_A] }), fields({ recommendationAction: "go", options: [OPT_A] })), 5),
    make("contested_on_action", models(fields({ recommendationAction: "go", options: [OPT_A] }), fields({ recommendationAction: "defer", options: [OPT_A] }), fields({ recommendationAction: "no_go", options: [OPT_A] }))),
    make("contested_on_option", models(choose(OPT_A), choose(OPT_B), choose(OPT_A))),
    make("no_recommendation", models(fields({ options: [OPT_A, OPT_B] }), fields({ options: [OPT_A, OPT_B] }))),
    make("all_models_failed", [], 3),
    make("single_model", models(fields({ recommendationAction: "go", options: [OPT_A], criteria: [CRIT_1], assessments: assessed(OPT_A, ["strong", "weak"]).slice(0, 1) }))),
    make(
      "merged_opposite_options",
      models(
        fields({ options: [approve, disapprove], recommendationAction: "choose_option", recommendedOption: approve }),
        fields({ options: [disapprove, approve], recommendationAction: "choose_option", recommendedOption: disapprove })
      )
    ),
    make("blank_source_list", models(fields({ recommendationAction: "go", options: [OPT_A], sources: [""] }), fields({ recommendationAction: "go", options: [OPT_A], sources: ["  "] }))),
    make("no_sources", models(fields({ recommendationAction: "go", options: [OPT_A], sources: [] }))),
    make("high_stakes_review_needed", models(fields({ recommendationAction: "go", options: [OPT_A] })), 1, "safety_critical"),
    legacy,
  ];
}

/**
 * The raw per-model payloads the Model Responses section prints field by field ("evidenceStrength: strong"). Every value
 * there is what the model returned. String values are already sentinel-wrapped; the assessment's evidenceStrength is an
 * enum the producer validates, so it is wrapped here, in the raw payload only (the producer input stays a valid enum).
 * `rawStrength: "unwrapped"` keeps the bare enum, which the spec uses to prove the raw dump is the only site that
 * prints an unqualified rating.
 */
export function modelResults(fixture: DsFixture, rawStrength: "model_content" | "unwrapped"): AdaptiveModelResult[] {
  return fixture.perModel.map((p) => {
    const data = { ...p.fields };
    if (rawStrength === "model_content") {
      data.assessments = p.fields.assessments.map((a) => ({ ...a, evidenceStrength: S(String(a.evidenceStrength)) as never }));
    }
    return { modelId: p.modelId, schemaId: "decision_support", ok: true, data: data as never };
  });
}

const META = (sourceBacked: boolean, humanReviewNeeded: boolean) =>
  ({
    schemaVersion: 1,
    queryType: "decision_support",
    answerShape: "decision_support_view",
    dataBasis: "training_prior",
    freshness: "timeless",
    riskLevel: "professional",
    evidenceQuality: "not_applicable",
    uncertainties: [],
    blindSpots: [],
    humanReviewNeeded,
    sourceBacked,
    generatedAt: "2026-10-28T00:00:00.000Z",
  }) as never;

/** The DS result page body every DS page mounts (dashboard, personal research, Team research): TopSummaryBar + DecisionSupportView + ModelResponsesSection + PanelEvidenceSection + review slot. */
export function dsPageElement(fixture: DsFixture, ancillaryPresentation: unknown, rawStrength: "model_content" | "unwrapped"): ReactElement {
  return createElement(AdaptivePanelResponse, {
    schema: SCHEMA_REGISTRY.decision_support,
    classification: classification("decision_support"),
    results: modelResults(fixture, rawStrength),
    decisionSupport: fixture.result,
    meta: META(fixture.result.sourceBacked, fixture.result.humanReviewNeeded),
    question: S("A user question"),
    runId: null,
    // The prop AdaptivePanelResponse reads (ResultsDisplay maps the outer `adaptiveAncillaryPresentation` onto it).
    ...(ancillaryPresentation ? { ancillaryPresentation } : {}),
  } as never);
}

export function receiptFor(fixture: DsFixture) {
  return {
    conclusion: S("Receipt conclusion text."),
    basis: [S("Receipt basis text.")],
    assumptions: [S("Receipt assumption text.")],
    uncertainties: [S("Receipt uncertainty text.")],
    limitations: [S("Receipt limitation text.")],
    sourceBacked: fixture.result.sourceBacked,
    humanReviewNeeded: fixture.result.humanReviewNeeded,
  };
}

export type Surface = { id: string; textNodes: string[]; attributes: string[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", mdash: "—", ndash: "–", times: "×" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Every text node and every reader-visible attribute of a static render. */
export function surfaceFromHtml(id: string, html: string): Surface {
  const attributes = [...html.matchAll(/\s(?:title|aria-label|alt)="([^"]*)"/g)].map((m) => decode(m[1]));
  const textNodes = html
    .split(/<[^>]*>/)
    .map((t) => decode(t).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
  return { id, textNodes, attributes };
}

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

/** The same extraction for a react-test-renderer tree (effects-driven surfaces). */
export function surfaceFromTree(id: string, tree: TreeNode | TreeNode[] | null): Surface {
  const textNodes: string[] = [];
  const attributes: string[] = [];
  const walk = (node: TreeNode | string | null) => {
    if (node === null) return;
    if (typeof node === "string") {
      const t = node.replace(/\s+/g, " ").trim();
      if (t) textNodes.push(t);
      return;
    }
    for (const key of ["title", "aria-label", "alt"]) {
      const v = node.props?.[key];
      if (typeof v === "string") attributes.push(v);
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const n of Array.isArray(tree) ? tree : [tree]) walk(n);
  return { id, textNodes, attributes };
}

export function renderStatic(id: string, element: ReactElement): Surface & { html: string } {
  const html = renderToStaticMarkup(element);
  return { ...surfaceFromHtml(id, html), html };
}

/** Text a reader sees, sentinel spans included, one node per line. */
export function surfaceText(surface: Surface): string {
  return [...surface.textNodes, ...surface.attributes].join("\n");
}
