/**
 * Order 6 / S-E.1 — whole-surface wording gate for Decision Support (D-10 (b), K-1…K-6, D-9 (c)).
 *
 * Renders every surface the corrections reach, for every state in the fixture matrix, and asserts:
 *   1. the scanner (seSurfaces/dsWordingScanner.ts) finds no prohibited wording on any surface;
 *   2. each surface shows exactly the owner-approved string for its stored state (literal oracle, below);
 *   3. the D-9 disclosure appears wherever grouped options are shown;
 *   4. the scanner is not blind: each falsification (reintroduced labels, scope restricted to one component, empty
 *      extraction, model-text isolation off, a broadened exemption) makes it fail.
 *
 * Responsive variants: these components render the same text at every breakpoint (no breakpoint-only copy), and the
 * extraction has no CSS, so every responsive variant is in the scanned markup.
 */

const mockFetch = jest.fn();
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockFetch(...a) }));
// One stable auth value, as the real provider keeps `user` in state: the review pages reload on every `user` change, so
// a fresh object per render would loop load → setState → render forever.
const mockAuth = { user: { uid: "reviewer-1", getIdToken: async () => "t" }, loading: false, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockAuth }));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => {
  const { createElement } = jest.requireActual("react");
  return { __esModule: true, default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children) };
});
/**
 * The wording module is loaded once, for the whole file. Every export is a live getter: with no override it returns the
 * real export (asserted below, identity per key), and a falsification case plants an old label by setting an override
 * for the duration of one render only (`withWording`). The consumers read these exports at render time (named
 * imports, no module-scope copies — asserted below), so the real page components pick up a plant without a fresh
 * module registry. This replaces one `jest.isolateModules` registry per case, which reloaded the whole page graph.
 */
const mockWordingOverrides = new Map<string, unknown>();
jest.mock("@/lib/adaptiveSchema/dsLabelWording", () => {
  const actual = jest.requireActual("@/lib/adaptiveSchema/dsLabelWording");
  const live: Record<string, unknown> = {};
  Object.defineProperty(live, "__esModule", { value: true });
  for (const key of Object.keys(actual)) {
    Object.defineProperty(live, key, { enumerable: true, get: () => (mockWordingOverrides.has(key) ? mockWordingOverrides.get(key) : actual[key]) });
  }
  return live;
});

import { readFileSync } from "fs";
import { join } from "path";
import { conditionalGoCollisionFixture, dsFixtures, receiptFor, S, surfaceFromHtml, type Surface } from "./seSurfaces/seSurfaceHarness";
import { CLAIM_MATRIX, LEGITIMATE_MATRIX } from "./seSurfaces/scannerContract";
import { allDsSurfaces, dsPageSurface } from "./seSurfaces/seSurfaceRenderers";
import { EXEMPTIONS, FAMILIES, FIELD_LABELS, STORED_FIELDS, isStoredSplitRationale, assertNotBlind, scanSurface, usedExemptions, validateExemptions } from "./seSurfaces/dsWordingScanner";

const fixtures = dsFixtures();
const fixturesAtLoad = JSON.stringify(fixtures);
let surfaces: Awaited<ReturnType<typeof allDsSurfaces>>;

beforeAll(async () => {
  surfaces = await allDsSurfaces(fixtures, mockFetch);
});

afterEach(() => {
  mockWordingOverrides.clear();
  mockFetch.mockReset();
});

const actualWording: Record<string, unknown> = jest.requireActual("@/lib/adaptiveSchema/dsLabelWording");

/** Plant overrides for exactly one synchronous render; always restored, even when the render throws. */
function withWording<T>(overrides: Record<string, unknown>, run: () => T): T {
  if (mockWordingOverrides.size !== 0) throw new Error("wording override leaked from a previous case");
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in actualWording)) throw new Error(`not a dsLabelWording export: ${key}`);
    mockWordingOverrides.set(key, value);
  }
  try {
    return run();
  } finally {
    mockWordingOverrides.clear();
  }
}

const of = (fixture: string, kind: string) => {
  const s = surfaces.find((x) => x.fixture === fixture && x.kind === kind);
  if (!s) throw new Error(`no surface ${kind}:${fixture}`);
  return s;
};
const textOf = (s: Surface) => [...s.textNodes, ...s.attributes].join("\n");
const htmlOf = (s: Surface): string => {
  const html = (s as Surface & { html?: unknown }).html;
  if (typeof html !== "string" || html.length === 0) throw new Error(`no static markup for ${s.id}`);
  return html;
};

// ── Independent literal oracle (owner ruling 2026-10-28; D-2 template B §3.5.4) ──────────────────────────────────
const NO_DISAGREEMENT = "No disagreement identified by current grouping";
const PROVIDED = "Sources provided by models; not independently verified";
const LISTED = "Sources listed; not independently verified";
const NONE = "No sources listed";
const D9 = "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";
const counts = (m: number, k: number, n: number) =>
  `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}. These counts are not a certainty measure.`;

type Expect = { agreement: string; sources: string; badge: string | null; counts: string | null; e4: string | null; d9: boolean };
const ORACLE: Record<string, Expect> = {
  uncontested_choose_option: { agreement: NO_DISAGREEMENT, sources: PROVIDED, badge: LISTED, counts: counts(3, 3, 3), e4: `${NO_DISAGREEMENT}.`, d9: true },
  uncontested_go_with_failed_slots: { agreement: NO_DISAGREEMENT, sources: PROVIDED, badge: LISTED, counts: counts(5, 2, 2), e4: `${NO_DISAGREEMENT}.`, d9: true },
  contested_on_action: { agreement: "Split", sources: PROVIDED, badge: LISTED, counts: counts(3, 3, 1), e4: null, d9: true },
  contested_on_option: { agreement: "Split", sources: PROVIDED, badge: LISTED, counts: counts(3, 3, 3), e4: null, d9: true },
  no_recommendation: { agreement: "Not scored", sources: PROVIDED, badge: LISTED, counts: counts(2, 0, 0), e4: "No model gave a recommendation.", d9: true },
  all_models_failed: { agreement: "Not scored", sources: NONE, badge: NONE, counts: counts(3, 0, 0), e4: "No model gave a recommendation.", d9: false },
  single_model: { agreement: NO_DISAGREEMENT, sources: PROVIDED, badge: LISTED, counts: counts(1, 1, 1), e4: `${NO_DISAGREEMENT}.`, d9: true },
  merged_opposite_options: { agreement: NO_DISAGREEMENT, sources: PROVIDED, badge: LISTED, counts: counts(2, 2, 2), e4: `${NO_DISAGREEMENT}.`, d9: true },
  blank_source_list: { agreement: NO_DISAGREEMENT, sources: NONE, badge: NONE, counts: counts(2, 2, 2), e4: `${NO_DISAGREEMENT}.`, d9: true },
  no_sources: { agreement: NO_DISAGREEMENT, sources: NONE, badge: NONE, counts: counts(1, 1, 1), e4: `${NO_DISAGREEMENT}.`, d9: true },
  high_stakes_review_needed: { agreement: NO_DISAGREEMENT, sources: PROVIDED, badge: LISTED, counts: counts(1, 1, 1), e4: `${NO_DISAGREEMENT}.`, d9: true },
  legacy_no_sources_field: { agreement: NO_DISAGREEMENT, sources: "—", badge: null, counts: counts(2, 2, 2), e4: `${NO_DISAGREEMENT}.`, d9: true },
  legacy_unsourced: { agreement: NO_DISAGREEMENT, sources: NONE, badge: NONE, counts: counts(2, 2, 2), e4: `${NO_DISAGREEMENT}.`, d9: true },
  unresolved_option: { agreement: "Split", sources: PROVIDED, badge: LISTED, counts: counts(2, 2, 2), e4: null, d9: true },
  partial_option_resolution: { agreement: "Split", sources: PROVIDED, badge: LISTED, counts: counts(3, 3, 3), e4: null, d9: true },
};

/** Text immediately following a field label in TopSummaryBar's extraction. */
function fieldValue(s: Surface, label: string): string | undefined {
  const i = s.textNodes.indexOf(label);
  return i >= 0 ? s.textNodes[i + 1] : undefined;
}

const PAGE_ANCHORS = ["Model agreement", "Sources", "Options considered", "Panel detail", "Model-assigned evidence strength, not independently checked"];

/** Scan a DS surface with its fixture's own stored rationale: the only value the stored-data debt can match exactly. */
const scanDs = (s: Surface, fixtureName: string) =>
  scanSurface(s, { storedRationales: [fixtures.find((x) => x.name === fixtureName)!.result.recommendation.rationale] });

// R2-m1 (owner ruling): the stored :488 rationale is kept; screens show this instead (literal oracle).
const STORED_488 = "Models agree a specific option should be chosen but did not name one this system could confidently resolve.";
const SHOWN_488 = "The current grouping could not reliably identify the recommended option. Review the individual model recommendations before deciding.";

/** What each surface must contain to count as whole: the page sections its state renders, and its review slot. */
function anchorsFor(s: Surface & { fixture: string; kind: string }): string[] {
  const f = fixtures.find((x) => x.name === s.fixture)!;
  if (s.kind === "list_item") return [];
  if (!s.kind.startsWith("page")) return ["Decision Receipt"];
  // "Options considered" renders only when the result has options (no model produced any in all_models_failed).
  const page = PAGE_ANCHORS.filter((a) => a !== "Options considered" || f.result.options.length > 0);
  if (s.kind === "page") return [...page, "Review & Governance"];
  return [...page, f.result.humanReviewNeeded ? "Human review needed" : "System did not flag this for human review."];
}

describe("fixture matrix reproduces the states it names (real producer)", () => {
  it("covers every oracle row exactly once", () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual(Object.keys(ORACLE).sort());
  });

  it("merged_opposite_options: Approve/Disapprove are merged by the current matcher into one uncontested option (R5-P1-08)", () => {
    const f = fixtures.find((x) => x.name === "merged_opposite_options")!;
    expect(f.result.options).toHaveLength(1);
    expect(f.result.recommendation.isContested).toBe(false);
    expect(f.result.recommendation.action).toBe("choose_option");
  });

  it("blank_source_list: the stored flag says sourced while no reference survives", () => {
    const f = fixtures.find((x) => x.name === "blank_source_list")!;
    expect(f.result.sourceBacked).toBe(true);
    expect(f.result.sources).toEqual([]);
  });

  it("covers both human-review states and both source flags", () => {
    expect(new Set(fixtures.map((f) => f.result.humanReviewNeeded))).toEqual(new Set([true, false]));
    expect(new Set(fixtures.map((f) => f.result.sourceBacked))).toEqual(new Set([true, false]));
  });
});

describe("whole-surface scan: no prohibited wording on any Decision Support surface", () => {
  it("renders 5 surface kinds × every fixture, none blind", () => {
    expect(surfaces).toHaveLength(fixtures.length * 5);
    const problems = surfaces.flatMap((s) => assertNotBlind(s, anchorsFor(s), s.kind === "list_item" ? 40 : 200));
    expect(problems).toEqual([]);
  });

  it("the Team page surface carries the Team review summary in place of the personal review slot", () => {
    for (const f of fixtures) {
      expect([f.name, textOf(of(f.name, "page_team")).includes("Review & Governance")]).toEqual([f.name, false]);
      expect([f.name, textOf(of(f.name, "page")).includes("Review & Governance")]).toEqual([f.name, true]);
    }
  });

  it("the raw per-model dump is the only site that prints an unqualified rating, always after its raw field key", () => {
    // Same page, raw payload left as the bare enum: every F8 hit must be the value of a raw "evidenceStrength:" field in
    // the Model Responses dump; any other bare rating (a badge, the tally, a card) fails here.
    for (const f of fixtures) {
      for (const mode of ["personal", "team"] as const) {
        const raw = dsPageSurface(`raw:${mode}:${f.name}`, f, mode, "unwrapped");
        const bare = raw.textNodes.flatMap((t, i) => (/^(strong|moderate|weak)$/i.test(t) ? [raw.textNodes[i - 1]] : []));
        expect([f.name, mode, bare.filter((prev) => prev !== "evidenceStrength:")]).toEqual([f.name, mode, []]);
        expect([f.name, mode, scanDs(raw, f.name).filter((h) => h.family !== "F8-bare-strength")]).toEqual([f.name, mode, []]);
        const expectedRaw = f.perModel.reduce((n, p) => n + p.fields.assessments.length, 0);
        expect([f.name, mode, bare.length]).toEqual([f.name, mode, expectedRaw]);
      }
    }
  });

  it("finds zero hits across all surfaces", () => {
    expect(surfaces.flatMap((s) => scanDs(s, s.fixture))).toEqual([]);
  });

  it("the :498 stored rationale is the only debt, shown only in its stored fields, with D-9 visible beside it", () => {
    const withDebt = fixtures.filter((f) => isStoredSplitRationale(f.result.recommendation.rationale)).map((f) => f.name);
    expect(withDebt).toEqual(["contested_on_option", "partial_option_resolution"]);
    // R4 NIT: the real producer writes a single-pick tally when one model's option is unresolved.
    expect(fixtures.find((x) => x.name === "partial_option_resolution")!.result.recommendation).toMatchObject({
      action: "conditional_go",
      isContested: true,
      rationale: "Models agree an option should be chosen but disagree on which one (2 of 2 pick ⟦Option Alpha plan⟧).",
    });
    for (const s of surfaces.filter((x) => withDebt.includes(x.fixture))) {
      const where = s.textNodes.flatMap((t, i) => (t.includes("Models agree an option should be chosen") ? [s.fields?.[i] ?? null] : []));
      // Page: the rationale field; Team page: that plus the receipt summary; each receipt surface: its conclusion.
      const expected = { page: [STORED_FIELDS.rationale], page_team: [STORED_FIELDS.rationale, STORED_FIELDS.receiptConclusion] }[s.kind as "page" | "page_team"] ?? [STORED_FIELDS.receiptConclusion];
      expect([s.id, where]).toEqual([s.id, expected]);
      expect([s.id, s.textNodes.includes(D9)]).toEqual([s.id, true]);
      // The debt is real wording a reader sees: without its exact stored value, the same surface fails.
      expect([s.id, scanSurface(s).map((h) => h.family)]).toEqual([s.id, expect.arrayContaining(["F2-convergence"])]);
    }
  });

  it("R2-m1: the :488 stored rationale is kept in the record but never shown; every surface shows the qualified explanation", () => {
    const f = fixtures.find((x) => x.name === "unresolved_option")!;
    expect(f.result.recommendation).toMatchObject({ action: "conditional_go", isContested: true, rationale: STORED_488 });
    expect(f.result.recommendation.recommendedOptionId).toBeFalsy();
    for (const kind of ["page", "page_team", "list_item", "personal_review", "team_review"]) {
      const s = of(f.name, kind);
      expect([kind, textOf(s).includes("did not name one this system could confidently resolve")]).toEqual([kind, false]);
      expect([kind, s.textNodes.filter((t) => t.includes(SHOWN_488)).length]).toEqual([kind, kind === "page_team" ? 2 : 1]);
      expect([kind, s.textNodes.includes(D9)]).toEqual([kind, true]);
    }
    // Receipts: the real builder wrote the stored sentence into the conclusion; the screen shows the explanation in its place.
    expect(receiptFor(f).conclusion).toBe(`Conditional go — ${STORED_488}`);
    for (const kind of ["list_item", "personal_review", "team_review"]) expect([kind, of(f.name, kind).textNodes.includes(`Conditional go — ${SHOWN_488}`)]).toEqual([kind, true]);
  });

  it("R3 NIT (pinned limit): a model-written conditional_go rationale equal to the :488 sentence is replaced on receipts only", () => {
    const f = conditionalGoCollisionFixture(STORED_488);
    // Real producer: no split, no recommended option, the models' own sentence stored as the rationale.
    expect(f.result.recommendation).toMatchObject({ action: "conditional_go", isContested: false, rationale: STORED_488 });
    expect(f.result.recommendation.recommendedOptionId).toBeFalsy();
    // Real builder: the conclusion is byte-identical to the unresolved state's, which is why a receipt cannot tell them apart.
    expect(receiptFor(f).conclusion).toBe(`Conditional go — ${STORED_488}`);
    // Result view (sees the state): the model's sentence is shown as written, inside the rationale field.
    const page = dsPageSurface("collision", f, "personal");
    expect(page.textNodes.filter((t, i) => t === STORED_488 && page.fields?.[i] === STORED_FIELDS.rationale)).toHaveLength(1);
    expect(page.textNodes.some((t) => t.includes(SHOWN_488))).toBe(false);
    // Receipt surfaces (conclusion only): the cautionary explanation, with D-9 beside it; the stored sentence is not shown.
    const team = dsPageSurface("collision-team", f, "team");
    const receiptNodes = team.textNodes.filter((_t, i) => team.fields?.[i] === STORED_FIELDS.receiptConclusion);
    expect(receiptNodes).toEqual([`Conditional go — ${SHOWN_488}`]);
    expect(team.textNodes).toContain(D9);
  });

  it("stored-field markers cover exactly the stored text: every marked node is the fixture's presented field value", () => {
    for (const s of surfaces) {
      expect([s.id, s.fields?.length]).toEqual([s.id, s.textNodes.length]);
      const f = fixtures.find((x) => x.name === s.fixture)!;
      const presented = f.result.recommendation.rationale === STORED_488 ? SHOWN_488 : f.result.recommendation.rationale;
      for (const [i, field] of (s.fields ?? []).entries()) {
        if (field === STORED_FIELDS.rationale) expect([s.id, s.textNodes[i]]).toEqual([s.id, presented]);
        else if (field === STORED_FIELDS.receiptConclusion) expect([s.id, s.textNodes[i].endsWith(presented)]).toEqual([s.id, true]);
        else expect([s.id, field]).toEqual([s.id, null]);
      }
    }
  });

  it("every exemption is phrase-level and is actually exercised by a rendered surface", () => {
    expect(validateExemptions(EXEMPTIONS)).toEqual([]);
    expect([...usedExemptions(surfaces)].sort()).toEqual([...EXEMPTIONS].sort());
  });

  it("no provenance view content is rendered (S-2a not started)", () => {
    for (const s of surfaces) expect(textOf(s)).not.toMatch(/ds_provenance_min|not_authorized_no_policy|review_history_not_shown|useAuthorization|dsProvenance/);
  });
});

describe("literal oracle: each surface shows the approved string for its stored state", () => {
  it.each(Object.keys(ORACLE))("%s — page (personal and Team)", (name) => {
    const e = ORACLE[name];
    for (const kind of ["page", "page_team"]) {
      const s = of(name, kind);
      const all = textOf(s);
      expect([name, kind, fieldValue(s, "Model agreement")]).toEqual([name, kind, e.agreement]);
      expect([name, kind, fieldValue(s, "Sources")]).toEqual([name, kind, e.sources]);
      expect(s.textNodes).not.toContain("Consensus");
      expect(s.textNodes).not.toContain("Source grounding");
      // The badge itself, not the Sources summary value that can carry the same words: exactly one node beyond the summary's.
      const badgeNodes = (text: string) => s.textNodes.filter((t) => t === text).length - (fieldValue(s, "Sources") === text ? 1 : 0);
      if (e.badge) expect([name, kind, badgeNodes(e.badge)]).toEqual([name, kind, 1]);
      else expect([name, kind, badgeNodes(LISTED) + badgeNodes(NONE)]).toEqual([name, kind, 0]);
      if (e.counts) expect(s.textNodes).toContain(e.counts);
      if (e.e4) expect(s.textNodes).toContain(e.e4);
      else expect(all).toMatch(/recommendation is contested/);
      // The Team page also carries the receipt summary, which always shows D-9 (see the receipt checks below).
      expect([name, kind, all.includes(D9)]).toEqual([name, kind, kind === "page_team" ? true : e.d9]);
      expect(all).toContain("Based on the currently grouped recommendations. Opposing options may have been grouped together.");
    }
  });

  it("E-8: wherever a strength is rated, the caption is shown and every badge carries its qualifier", () => {
    const rated = surfaces.filter((s) => s.kind === "page" && /\((model-assigned)\)/.test(textOf(s)));
    expect(rated.length).toBeGreaterThan(0);
    for (const s of rated) {
      const fixture = fixtures.find((f) => f.name === s.fixture)!;
      if (fixture.result.criteria.length > 0 && fixture.result.options.length > 0) {
        expect(s.textNodes).toContain("Evidence-strength ratings are assigned by the models and were not independently checked.");
      }
      expect(s.textNodes.filter((t) => /^(Strong|Moderate|Weak)\b/.test(t) && !t.includes("(model-assigned)"))).toEqual([]);
    }
  });

  it.each(Object.keys(ORACLE))("%s — receipt surfaces (Team summary, review queue item, personal and Team review detail)", (name) => {
    const f = fixtures.find((x) => x.name === name)!;
    const team = textOf(of(name, "page_team"));
    const sourcesText = f.result.sourceBacked ? null : NONE;
    const teamFlags = f.result.humanReviewNeeded
      ? sourcesText ? `${sourcesText} · Human review needed` : "Human review needed"
      : sourcesText ? `${sourcesText} · System did not flag this for human review.` : "System did not flag this for human review.";
    expect(team).toContain(teamFlags);
    for (const kind of ["list_item", "personal_review", "team_review"]) {
      const s = of(name, kind);
      if (sourcesText) expect(s.textNodes).toContain(sourcesText);
      else expect(s.textNodes.filter((t) => t === NONE || t === LISTED)).toEqual([]);
      // E-6 on every DS receipt surface, never the shared "not flagged as needed" wording.
      expect([kind, s.textNodes.includes(f.result.humanReviewNeeded ? "Human review needed" : "System did not flag this for human review.")]).toEqual([kind, true]);
      expect([kind, textOf(s).includes("Human review not flagged as needed")]).toEqual([kind, false]);
    }
  });

  it.each(Object.keys(ORACLE))("%s — D-9 travels with the receipt's grouped option on every receipt surface", (name) => {
    for (const kind of ["page_team", "list_item", "personal_review", "team_review"]) {
      expect([kind, of(name, kind).textNodes.filter((t) => t === D9).length]).toEqual([kind, kind === "page_team" && ORACLE[name].d9 ? 2 : 1]);
    }
  });

  it("receipts come from the real builder: a chosen option is named in the receipt conclusion, as stored", () => {
    const f = fixtures.find((x) => x.name === "merged_opposite_options")!;
    const option = f.result.options.find((o) => o.id === f.result.recommendation.recommendedOptionId)!;
    expect(option.label).toMatch(/^⟦.*⟧$/);
    for (const kind of ["list_item", "personal_review", "team_review"]) {
      expect([kind, of(f.name, kind).textNodes.some((t) => t.startsWith(`Choose option: ${option.label}`))]).toEqual([kind, true]);
    }
  });
});

describe("falsification: the gate fails when a prohibited label is reintroduced (one module mock per E-label)", () => {
  // Each override re-plants an old E-label (or removes the D-9 text) at its real site through the shared wording module
  // (see `withWording`), re-renders the real components for that one case, and requires the gate to catch it.
  const PLANTS: [string, Record<string, unknown>, string, string[]][] = [
    ["E-1 Strong consensus", { dsModelAgreement: () => ({ text: "Strong consensus", kind: "no_disagreement" }) }, "page", ["F1-consensus-tier"]],
    ["E-2 Source grounding", { DS_SOURCES_FIELD: "Source grounding" }, "page", ["F3-source-assurance"]],
    ["E-3 Source-backed badge", { dsSourcesBadge: () => "Source-backed" }, "page", ["F3-source-assurance"]],
    ["E-3 receipt Source-backed", { dsReceiptSourcesLabel: () => "Source-backed" }, "page_team", ["F3-source-assurance"]],
    ["E-4 converged", { dsUncontestedStatement: () => "The panel's recommended actions converged — no material split." }, "page", ["F2-convergence"]],
    ["E-5 genuine agreement", { DS_GROUPING_BASIS: "The recommendation reflects only genuine agreement across contributing models' own recommended actions." }, "page", ["F2-convergence", "F7-old-e-strings"]],
    ["E-6 not required", { DS_NOT_FLAGGED_FOR_REVIEW: "Human review not required" }, "page_team", ["F4-review-necessity", "F7-old-e-strings"]],
    ["E-7 N of M converged", { dsRecommendationCounts: () => "3 of 3 models converged on this — not a certainty score." }, "page", ["F2-convergence", "F7-old-e-strings"]],
    ["E-8 bare badges", { DS_STRENGTH_LABEL: { strong: "Strong", moderate: "Moderate", weak: "Weak", contested: "Contested", unknown: "Unrated" } }, "page", ["F8-bare-strength"]],
  ];

  const PLANT_FIXTURE = "uncontested_choose_option";
  const plantSurface = (overrides: Record<string, unknown>, kind: string) =>
    withWording(overrides, () => dsPageSurface("planted", fixtures.find((x) => x.name === PLANT_FIXTURE)!, kind === "page_team" ? "team" : "personal"));

  it.each(PLANTS)("%s is caught", (_label, overrides, kind, expectedFamilies) => {
    const hits = scanSurface(plantSurface(overrides, kind));
    expect(hits.length).toBeGreaterThan(0);
    for (const fam of expectedFamilies) expect(hits.map((h) => h.family)).toContain(fam);
  });

  it("removing the D-9 disclosure is caught by the presence oracle", () => {
    expect(htmlOf(of(PLANT_FIXTURE, "page"))).toContain(D9);
    expect(plantSurface({ DS_OPTION_GROUPING_DISCLOSURE: "" }, "page").html).not.toContain(D9);
  });

  // ── Isolation of the shared module graph (owner ruling 2026-10-28: re-rendering must be proven equivalent to a fresh
  // registry). A case is isolated iff (a) with no override every export is the real one, (b) a clean render before,
  // between and after the plants is byte-identical to the beforeAll render, (c) no override, fixture mutation or fetch
  // state survives a case, and (d) results do not depend on order or repetition.
  describe("isolation of the shared module graph", () => {
    const CASES: [string, Record<string, unknown>, string][] = [
      ...PLANTS.map(([label, overrides, kind]) => [label, overrides, kind] as [string, Record<string, unknown>, string]),
      ["D-9 removed", { DS_OPTION_GROUPING_DISCLOSURE: "" }, "page"],
    ];
    const cleanHtml = (kind: string) => dsPageSurface("clean", fixtures.find((x) => x.name === PLANT_FIXTURE)!, kind === "page_team" ? "team" : "personal").html;
    const fingerprint = ([label, overrides, kind]: [string, Record<string, unknown>, string]) => {
      const s = plantSurface(overrides, kind);
      return { label, families: [...new Set(scanSurface(s).map((h) => h.family))].sort(), html: s.html };
    };

    it("(a) with no override, every export of the shared wording module is the real export", () => {
      const live = require("@/lib/adaptiveSchema/dsLabelWording") as Record<string, unknown>;
      expect(Object.keys(live).sort()).toEqual(Object.keys(actualWording).sort());
      for (const key of Object.keys(actualWording)) expect([key, live[key] === actualWording[key]]).toEqual([key, true]);
    });

    it("(a') the consumers read wording at render time, not at module load", () => {
      const consumers = ["TopSummaryBar.tsx", "DecisionSupportView.tsx", "PanelEvidenceSection.tsx", "ReceiptSourcesFlag.tsx", "DsReceiptWording.tsx"].map((f) => join(__dirname, "..", f));
      consumers.push(join(__dirname, "..", "..", "workspace", "projects", "TeamResearchReviewSummary.tsx"));
      for (const p of consumers) {
        const src = readFileSync(p, "utf8");
        expect([p, /from "@\/lib\/adaptiveSchema\/dsLabelWording"/.test(src)]).toEqual([p, true]);
        // No module-scope binding initialised from a wording export (it would freeze the value at first load).
        expect([p, src.match(/^(?:export )?(?:const|let|var) \w+\s*(?::[^=]+)?=[^\n]*\b(?:DS_[A-Z_]+|ds[A-Z]\w+)\b/gm)]).toEqual([p, null]);
        expect([p, /import \* as \w+ from "@\/lib\/adaptiveSchema\/dsLabelWording"/.test(src)]).toEqual([p, false]);
      }
    });

    it("(b) a clean render before, between and after every plant equals the beforeAll render, byte for byte", () => {
      const baseline = { page: htmlOf(of(PLANT_FIXTURE, "page")), page_team: htmlOf(of(PLANT_FIXTURE, "page_team")) };
      expect(cleanHtml("page")).toBe(baseline.page);
      for (const c of CASES) {
        const planted = fingerprint(c);
        expect([c[0], planted.html === baseline[c[2] as "page" | "page_team"]]).toEqual([c[0], false]);
        expect([c[0], cleanHtml(c[2]) === baseline[c[2] as "page" | "page_team"]]).toEqual([c[0], true]);
        expect([c[0], scanSurface(dsPageSurface("clean", fixtures.find((x) => x.name === PLANT_FIXTURE)!, c[2] === "page_team" ? "team" : "personal"))]).toEqual([c[0], []]);
      }
    });

    it("(c) a plant that throws is still restored, and nested or unknown plants are refused", () => {
      expect(() => withWording({ DS_SOURCES_FIELD: "Source grounding" }, () => { throw new Error("render failed"); })).toThrow("render failed");
      expect(mockWordingOverrides.size).toBe(0);
      expect(() => withWording({ DS_NOT_AN_EXPORT: "x" }, () => null)).toThrow("not a dsLabelWording export");
      mockWordingOverrides.clear();
      expect(() => withWording({ DS_SOURCES_FIELD: "a" }, () => withWording({ DS_SOURCES_FIELD: "b" }, () => null))).toThrow("leaked");
      expect(mockWordingOverrides.size).toBe(0);
      expect(cleanHtml("page")).toBe(htmlOf(of(PLANT_FIXTURE, "page")));
    });

    it("(d) order does not matter: forward and reverse runs give the same result per case", () => {
      const forward = CASES.map(fingerprint);
      const reverse = [...CASES].reverse().map(fingerprint).reverse();
      expect(reverse).toEqual(forward);
      // Each plant's effect is its own: every case reports exactly the families its own plant introduces, nothing another
      // case planted (the D-9 removal introduces no wording, so none).
      const expected = new Map(CASES.map(([label]) => [label, [...(PLANTS.find((pl) => pl[0] === label)?.[3] ?? [])].sort()]));
      for (const f of forward) expect([f.label, f.families]).toEqual([f.label, expected.get(f.label)]);
    });

    it("(e) repetition does not accumulate state: three full cycles are identical and leave nothing behind", () => {
      const cycles = [0, 1, 2].map(() => CASES.map(fingerprint));
      expect(cycles[1]).toEqual(cycles[0]);
      expect(cycles[2]).toEqual(cycles[0]);
      expect(mockWordingOverrides.size).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(JSON.stringify(fixtures)).toBe(fixturesAtLoad);
    });
  });
});

describe("falsification: scanner mechanics", () => {
  const planted = () =>
    withWording({ dsModelAgreement: () => ({ text: "Strong consensus", kind: "no_disagreement" }) }, () => dsPageSurface("planted", fixtures[0], "personal"));

  it("(2) restricting inspection to one component misses a page-level violation, and the not-blind guard rejects the restricted scope", () => {
    const whole = planted();
    expect(scanSurface(whole).length).toBeGreaterThan(0);
    // Only the provenance component: none is rendered yet, so the restricted extraction is empty.
    const provenanceOnly: Surface = { id: "provenance-only", textNodes: whole.textNodes.filter((t) => /provenance/i.test(t)), attributes: [] };
    expect(scanSurface(provenanceOnly)).toEqual([]);
    expect(assertNotBlind(provenanceOnly, PAGE_ANCHORS)).not.toEqual([]);
    // Only the DecisionSupportView subtree: the planted TopSummaryBar label is outside it.
    const html = (whole as Surface & { html: string }).html;
    const dsvStart = html.indexOf('<div class="space-y-3">');
    const dsvOnly = surfaceFromHtml("dsv-only", html.slice(dsvStart));
    expect(scanSurface(dsvOnly)).toEqual([]);
    expect(assertNotBlind(dsvOnly, PAGE_ANCHORS)).not.toEqual([]);
  });

  it("(3) an empty extraction finds nothing and the not-blind guard rejects it", () => {
    const empty: Surface = { id: "empty", textNodes: [], attributes: [] };
    expect(scanSurface(empty)).toEqual([]);
    expect(assertNotBlind(empty, PAGE_ANCHORS)).not.toEqual([]);
 
    // The length floor is load-bearing on its own: an extraction holding only the anchor words (nothing between them)
    // passes every anchor check and must still be rejected as too thin to be a whole page.
    const anchorsOnly: Surface = { id: "anchors-only", textNodes: [...PAGE_ANCHORS], attributes: [] };
    expect(PAGE_ANCHORS.join("\n").length).toBeLessThan(200);
    expect(assertNotBlind(anchorsOnly, PAGE_ANCHORS)).toEqual([expect.stringContaining("characters extracted")]);
  });

  it("(4) model-text isolation is load-bearing: a model quoting 'the models converged' is ignored only while isolation is on, and application text beside it is still scanned", () => {
    const quoted: Surface = { id: "quoted", textNodes: [S("Analysts say the models converged on a strong consensus.")], attributes: [] };
    expect(scanSurface(quoted)).toEqual([]);
    expect(scanSurface(quoted, { stripSentinels: false }).map((h) => h.family)).toEqual(expect.arrayContaining(["F1-consensus-tier", "F2-convergence"]));
    const beside: Surface = { id: "beside", textNodes: [`${S("model text")} Strong consensus`], attributes: [] };
    expect(scanSurface(beside).map((h) => h.family)).toContain("F1-consensus-tier");
  });

  it("(2b) a phrase split across inline elements or JSX children is still caught (joined reader-order scan)", () => {
    const split = surfaceFromHtml("split", "<p>Human review <b>not required</b></p><p>Source<em>-backed</em></p>");
    expect(split.textNodes).toEqual(["Human review", "not required", "Source", "-backed"]);
    expect(scanSurface(split, { joined: false })).toEqual([]);
    expect(scanSurface(split).map((h) => h.family).sort()).toEqual(["F3-source-assurance", "F4-review-necessity", "F7-old-e-strings"]);
    // An exempt phrase stays exempt however it is split.
    const exemptSplit: Surface = { id: "exempt-split", textNodes: ["Sources listed;", "not independently verified"], attributes: [] };
    expect(scanSurface(exemptSplit)).toEqual([]);
  });

  it("(2c) the approved field label is exempt only as an exact whole node", () => {
    expect(FIELD_LABELS).toEqual(["Model agreement"]);
    expect(scanSurface({ id: "label", textNodes: ["Model agreement"], attributes: [] })).toEqual([]);
    expect(scanSurface({ id: "label+claim", textNodes: ["Model agreement: unanimous"], attributes: [] }).map((h) => h.family)).toContain("F2-convergence");
    // Each layer holds on its own: the per-node pass alone (joined off) and the joined pass alone (via the attribute-free
    // reader-order text) both reject a label carrying a claim.
    expect(scanSurface({ id: "label+claim", textNodes: ["Model agreement: unanimous"], attributes: [] }, { joined: false }).map((h) => h.family)).toContain("F2-convergence");
    expect(scanSurface({ id: "label-in-prose", textNodes: ["Model agreement was reached."], attributes: [] }).map((h) => h.family)).toContain("F2-convergence");
    for (const s of surfaces.filter((x) => x.kind.startsWith("page"))) expect([s.id, s.textNodes.includes("Model agreement")]).toEqual([s.id, true]);
  });

  it("(2d) stored-data debt is exact: only the stored value, in its own marked field, under the producer grammar", () => {
    const d498 = "Models agree an option should be chosen but disagree on which one (2 of 3 pick A; 1 of 3 pick B).";
    const at = (nodes: [string, string | null][]): Surface => ({ id: "p", textNodes: nodes.map((n) => n[0]), attributes: [], fields: nodes.map((n) => n[1]) });
    const scan = (nodes: [string, string | null][], stored: string[] = [d498]) => scanSurface(at(nodes), { storedRationales: stored }).map((h) => h.family);
    // Accepted: the exact stored value in either stored field.
    expect(scan([[d498, STORED_FIELDS.rationale]])).toEqual([]);
    expect(scan([[`Conditional go — ${d498}`, STORED_FIELDS.receiptConclusion]])).toEqual([]);
    // Rejected: outside the field, unmarked, or in another field.
    expect(scan([[d498, null]])).toContain("F2-convergence");
    expect(scan([[d498, "something.else"]])).toContain("F2-convergence");
    // Rejected: anything appended, including a suffix that itself ends in ")." (R3 NIT).
    expect(scan([[`${d498} All models agree.`, STORED_FIELDS.rationale]])).toContain("F2-convergence");
    expect(scan([[`${d498} All sources verified and models are unanimous (consensus).`, STORED_FIELDS.rationale]])).toEqual(expect.arrayContaining(["F2-convergence", "F3-source-assurance"]));
    expect(scan([[`Conditional go — ${d498} Consensus confirmed (all models agree).`, STORED_FIELDS.receiptConclusion]])).toEqual(expect.arrayContaining(["F1-consensus-tier", "F2-convergence"]));
    const inner = "Models agree an option should be chosen but disagree on which one (none; sources verified; review not required).";
    expect(scan([[inner, STORED_FIELDS.rationale]], [inner])).toEqual(expect.arrayContaining(["F2-convergence", "F3-source-assurance", "F4-review-necessity"]));
    expect(scan([[`Models agreed — ${d498}`, STORED_FIELDS.receiptConclusion]])).toContain("F2-convergence");
    // Rejected: a changed rationale is not automatically exempt (the rendered text must equal the stored value).
    const changed = "Models agree an option should be chosen but disagree on which one (2 of 3 pick A; 1 of 3 pick C).";
    expect(scan([[changed, STORED_FIELDS.rationale]])).toContain("F2-convergence");
    // Rejected: a stored value outside the producer grammar, even when the caller passes it.
    // Valid producer forms: one pick (reachable, R4 NIT), several picks, a label containing "; ".
    for (const good of [
      "Models agree an option should be chosen but disagree on which one (2 of 2 pick A).",
      "Models agree an option should be chosen but disagree on which one (3 of 3 pick Option A).",
      "Models agree an option should be chosen but disagree on which one (1 of 3 pick A; 1 of 3 pick B; 1 of 3 pick C).",
      "Models agree an option should be chosen but disagree on which one (1 of 2 pick Plan A; phased; 1 of 2 pick B).",
    ]) {
      expect([good, isStoredSplitRationale(good)]).toEqual([good, true]);
      expect([good, scan([[good, STORED_FIELDS.rationale]], [good])]).toEqual([good, []]);
      expect([good, scan([[good, null]], [good]).length > 0]).toEqual([good, true]);
      expect([good, scan([[`${good} Unanimous (all models).`, STORED_FIELDS.rationale]], [good]).length > 0]).toEqual([good, true]);
    }
    for (const bad of [
      "Models agree an option should be chosen but disagree on which one (2 of 3 pick A).",
      "Models agree an option should be chosen but disagree on which one (0 of 2 pick A; 2 of 2 pick B).",
      "Models agree an option should be chosen but disagree on which one ().",
      "Models agree an option should be chosen but disagree on which one (2 of 3 pick A; 2 of 3 pick B).",
      "Models agree an option should be chosen but disagree on which one (2 of 3 pick A; 1 of 4 pick B).",
      // Counts sum to the last denominator, so only the shared-denominator rule rejects it.
      "Models agree an option should be chosen but disagree on which one (1 of 3 pick A; 1 of 2 pick B).",
      "Models agree an option should be chosen but disagree on which one (2 of 3 pick A; 1 of 3 pick B). Unanimous.",
      "All models agree (2 of 3 pick A; 1 of 3 pick B).",
    ]) {
      expect([bad, isStoredSplitRationale(bad)]).toEqual([bad, false]);
      expect([bad, scan([[bad, STORED_FIELDS.rationale]], [bad]).length > 0]).toEqual([bad, true]);
    }
    expect(isStoredSplitRationale(d498)).toBe(true);
    // The :488 sentence has no debt entry anywhere: inside the rationale field or a receipt conclusion it is caught.
    expect(scan([[STORED_488, STORED_FIELDS.rationale]], [STORED_488])).toContain("F2-convergence");
    expect(scan([[`Conditional go — ${STORED_488}`, STORED_FIELDS.receiptConclusion]], [STORED_488])).toContain("F2-convergence");
    // No phrase exemption exists for either sentence.
    for (const e of EXEMPTIONS) expect([e, /Models agree/.test(e)]).toEqual([e, false]);
  });

  it("(2e) on the real page, both sentences planted as application wording outside their field are caught", () => {
    const f = fixtures.find((x) => x.name === "contested_on_option")!;
    const stored498 = f.result.recommendation.rationale;
    for (const planted of [stored498, STORED_488]) {
      const s = withWording({ DS_GROUPING_BASIS: planted }, () => dsPageSurface("planted", f, "personal"));
      // The page's real stored rationale stays exempt (it is passed); only the planted application copy is caught.
      expect([planted, scanSurface(s, { storedRationales: [stored498] }).map((h) => h.family)]).toEqual([planted, expect.arrayContaining(["F2-convergence"])]);
      expect(scanSurface(dsPageSurface("clean", f, "personal"), { storedRationales: [stored498] })).toEqual([]);
    }
    // Presentation identity removed: the :488 sentence reaches every surface and is caught on each.
    const u = fixtures.find((x) => x.name === "unresolved_option")!;
    const unsub = withWording({ dsPresentedRationale: (d: { recommendation: { rationale: string } }) => d.recommendation.rationale }, () => dsPageSurface("unsub", u, "personal"));
    expect(scanSurface(unsub).map((h) => h.family)).toContain("F2-convergence");
    const unsubReceipt = withWording({ dsPresentedReceiptConclusion: (_s: unknown, c: string) => c }, () => dsPageSurface("unsub-r", u, "team"));
    expect(scanSurface(unsubReceipt).map((h) => h.family)).toContain("F2-convergence");
  });

  it("(5) a broadened exemption is rejected by the validator, and would otherwise hide a violation", () => {
    const broad = [...EXEMPTIONS, "converge"];
    expect(validateExemptions(broad)).not.toEqual([]);
    const violation: Surface = { id: "v", textNodes: ["The panel's recommended actions converged."], attributes: [] };
    expect(scanSurface(violation).length).toBeGreaterThan(0);
    expect(scanSurface(violation, { exemptions: broad })).toEqual([]);
  });

  it("(1b) every family fires on its own example", () => {
    const examples: Record<string, string> = {
      "F1-consensus-tier": "Moderate consensus",
      "F2-convergence": "All models agree",
      "F3-source-assurance": "Evidence-backed",
      "F4-review-necessity": "No human review needed",
      "F5-option-distinctness": "Opposing options are kept distinct",
      "F6-certainty": "This is certain",
      "F7-old-e-strings": "Assessment evidence strength",
    };
    for (const f of FAMILIES) expect([f.id, scanSurface({ id: f.id, textNodes: [examples[f.id]], attributes: [] }).map((h) => h.family)]).toEqual([f.id, expect.arrayContaining([f.id])]);
  });

  it("(1d) context: cautionary and approved wording is not a claim", () => {
    for (const text of [
      "The system could not confidently identify the option.",
      "We cannot confidently resolve which option was meant.",
      "No disagreement identified by current grouping.",
      "largest group recommending the same action: 2.",
      "Sources listed; not independently verified",
      "agreement on an option is not established.",
      "The current grouping could not reliably identify the recommended option. Review the individual model recommendations before deciding.",
      "System did not flag this for human review.",
    ]) expect([text, scanSurface({ id: "neg", textNodes: [text], attributes: [] })]).toEqual([text, []]);
  });

  it("(1e) claims split across nested elements are caught", () => {
    for (const html of [
      "<p>No <b>disagreement</b>.</p>",
      "<p>Sources <em><b>confirmed</b></em></p>",
      "<p>Human review <span>is <i>optional</i></span></p>",
      "<p>The models are <a>aligned</a>.</p>",
      "<p>The panel <b>confidently</b> recommends Go.</p>",
    ]) expect([html, scanSurface(surfaceFromHtml("n", html)).length > 0]).toEqual([html, true]);
  });

  describe("finite scanner contract (owner R5): CLAIM_MATRIX rejected, LEGITIMATE_MATRIX accepted", () => {
    const claims = Object.entries(CLAIM_MATRIX).flatMap(([family, texts]) => texts.map((text) => [family, text] as const));

    it.each(claims)("%s rejects %p — as a node, on the real page, and split across inline elements", (family, text) => {
      expect(scanSurface({ id: "c", textNodes: [text], attributes: [] }).map((h) => h.family)).toEqual(expect.arrayContaining([family]));
      const f = fixtures.find((x) => x.name === "uncontested_choose_option")!;
      const planted = withWording({ DS_GROUPING_BASIS: text }, () => dsPageSurface("planted", f, "personal"));
      expect(scanDs(planted, f.name).map((h) => h.family)).toEqual(expect.arrayContaining([family]));
      // Split after the first word, inside nested inline elements, through the real HTML extraction.
      const [first, ...rest] = text.split(" ");
      const html = `<p>${first} <span><b>${rest.join(" ")}</b></span></p>`;
      expect(scanSurface(surfaceFromHtml("split", html)).map((h) => h.family)).toEqual(expect.arrayContaining([family]));
      // A model quoting the same claim is model content, not application wording.
      expect(scanSurface({ id: "q", textNodes: [S(text)], attributes: [] })).toEqual([]);
    });

    it.each(LEGITIMATE_MATRIX.map((t) => [t]))("accepts %p — as a node and on the real page", (text) => {
      expect(scanSurface({ id: "n", textNodes: [text], attributes: [] })).toEqual([]);
      const f = fixtures.find((x) => x.name === "uncontested_choose_option")!;
      expect(scanDs(withWording({ DS_GROUPING_BASIS: text }, () => dsPageSurface("legit", f, "personal")), f.name)).toEqual([]);
    });

    it("quantifier and negation scope: a qualifier on the subject is accepted, a trailing negation does not qualify a positive claim", () => {
      const fam = (t: string) => scanSurface({ id: "s", textNodes: [t], attributes: [] }).map((h) => h.family);
      expect(fam("Not all sources were confirmed.")).toEqual([]);
      expect(fam("Sources were confirmed, not merely listed.")).toContain("F3-source-assurance");
      expect(fam("Only some sources were checked.")).toEqual([]);
      expect(fam("Some sources were checked, and all sources were confirmed.")).toContain("F3-source-assurance");
      expect(fam("Not all models recommended an action.")).toEqual([]);
      expect(fam("2 of 3 models recommended Go.")).toEqual([]);
      expect(fam("3 of 3 models recommended Go")).toContain("F2-convergence");
    });

    it("the matrices are literal and disjoint, and every R4 counterexample in the owner's R5 list is present", () => {
      const all = Object.values(CLAIM_MATRIX).flat();
      expect(new Set(all).size).toBe(all.length);
      for (const t of LEGITIMATE_MATRIX) expect([t, all.includes(t)]).toEqual([t, false]);
      for (const t of [
        "Human review — optional", "Human review - optional", "Human review: not required", "Human review isn't needed", "No need for human review", "Human review can be skipped",
        "Sources — confirmed", "Sources: all confirmed", "Sources (confirmed)", "Sources were cross-checked", "Sources were fact-checked",
        "All three models recommended Go", "All panel models recommended Go", "Every single model chose Option A", "All models recommend Go", "Every model picks Option A", "3 of 3 models recommended Go",
      ]) expect([t, all.includes(t)]).toEqual([t, true]);
      for (const t of ["Not all sources were confirmed.", "Only some sources were checked.", "Few sources were confirmed."]) expect([t, LEGITIMATE_MATRIX.includes(t)]).toEqual([t, true]);
    });
  });

  describe("R3 MINOR: F2 / F3 / F4 claim variants (bounded structures, not word bans)", () => {
    const CASES: { family: string; claims: string[]; legitimate: string[] }[] = [
      {
        family: "F2-convergence",
        claims: ["All models recommended Go.", "Every model chose Option A.", "All 3 models recommended Defer", "Each of the models selected Option B", "all models   recommended   no go"],
        legitimate: ["Not all models recommended an action.", "All models were dispatched.", "Each model's full response is shown below.", "3 models dispatched; 3 gave a recommendation; largest group recommending the same action: 3.", "Recommended next step: review each model's answer."],
      },
      {
        family: "F3-source-assurance",
        claims: ["Sources were independently confirmed.", "Sources: confirmed.", "References checked.", "Citations confirmed.", "Source has been validated", "References were carefully checked"],
        legitimate: ["Sources listed; not independently verified", "No sources were checked.", "Sources were not checked.", "None of the sources were confirmed.", "Source references are listed as the models gave them; none were fetched or checked", "Confirm the citations before relying on them."],
      },
      {
        family: "F4-review-necessity",
        claims: ["Human review unnecessary.", "Optional human review.", "Human review: optional.", "Review: unnecessary", "Optional review"],
        legitimate: ["Human review needed", "System did not flag this for human review.", "Human review completed: approved by a reviewer.", "Review status: Approved", "Optional: add a comment for the reviewer."],
      },
    ];

    it.each(CASES.map((c) => [c.family, c] as const))("%s: each claim is caught as a text node, and each legitimate statement is not", (_f, c) => {
      for (const text of c.claims) expect([text, scanSurface({ id: "c", textNodes: [text], attributes: [] }).map((h) => h.family)]).toEqual([text, expect.arrayContaining([c.family])]);
      for (const text of c.legitimate) expect([text, scanSurface({ id: "n", textNodes: [text], attributes: [] })]).toEqual([text, []]);
    });

    it.each(CASES.map((c) => [c.family, c] as const))("%s: each claim planted as application wording on the real page fails the gate; a model quoting it does not", (_f, c) => {
      const f = fixtures.find((x) => x.name === "uncontested_choose_option")!;
      for (const text of c.claims) {
        const planted = withWording({ DS_GROUPING_BASIS: text }, () => dsPageSurface("planted", f, "personal"));
        expect([text, scanDs(planted, f.name).map((h) => h.family)]).toEqual([text, expect.arrayContaining([c.family])]);
        expect([text, scanSurface({ id: "quoted", textNodes: [S(text)], attributes: [] })]).toEqual([text, []]);
      }
      expect(scanDs(dsPageSurface("clean", f, "personal"), f.name)).toEqual([]);
    });

    it("claims split across inline and nested elements are caught through the real extraction", () => {
      for (const [html, family] of [
        ["<p>Every <b>model</b> chose <i>Option A</i>.</p>", "F2-convergence"],
        ["<p>All <span>models <em>recommended</em></span> Go.</p>", "F2-convergence"],
        ["<p>Sources<b>:</b> <i>confirmed</i>.</p>", "F3-source-assurance"],
        ["<p><span>References</span> <span>checked</span></p>", "F3-source-assurance"],
        ["<p>Human review<b>:</b> <i>optional</i></p>", "F4-review-necessity"],
        ["<p><b>Optional</b> human review</p>", "F4-review-necessity"],
      ]) expect([html, scanSurface(surfaceFromHtml("n", html)).map((h) => h.family)]).toEqual([html, expect.arrayContaining([family])]);
    });
  });

  it("(1c) the families cover claim classes, not only the old strings", () => {
    const claims: [string, string][] = [
      ["The models agree on this option.", "F2-convergence"],
      ["The panel agreed.", "F2-convergence"],
      ["Agreement: high", "F2-convergence"],
      ["the panel's own recommendations genuinely conflicted", "F2-convergence"],
      ["Consensus", "F1-consensus-tier"],
      ["Sources verified", "F3-source-assurance"],
      ["Well-sourced recommendation", "F3-source-assurance"],
      ["This decision does not need human review", "F4-review-necessity"],
      ["A definitive answer", "F6-certainty"],
      // Owner-listed variants (R3 ruling), verbatim.
      ["No split.", "F2-convergence"],
      ["All models recommended the same action.", "F2-convergence"],
      ["The models are aligned.", "F2-convergence"],
      ["Sources checked.", "F3-source-assurance"],
      ["Sources confirmed.", "F3-source-assurance"],
      ["Human review is optional.", "F4-review-necessity"],
      ["No disagreement.", "F2-convergence"],
      ["No disagreement among models", "F2-convergence"],
      ["No split.", "F2-convergence"],
      ["All models recommended the same action", "F2-convergence"],
      ["Models aligned on Go", "F2-convergence"],
      ["The panel is aligned", "F2-convergence"],
      ["Sources checked", "F3-source-assurance"],
      ["Sources confirmed", "F3-source-assurance"],
      ["Strongly supported by sources", "F3-source-assurance"],
      ["Human review is optional", "F4-review-necessity"],
      ["Human review not flagged as needed", "F4-review-necessity"],
      ["The system could confidently resolve the option", "F6-certainty"],
      ["The panel confidently recommends Go", "F6-certainty"],
    ];
    for (const [text, family] of claims) expect([text, scanSurface({ id: "c", textNodes: [text], attributes: [] }).map((h) => h.family)]).toEqual([text, expect.arrayContaining([family])]);
  });
});

describe("wiring", () => {
  const ROOT = process.cwd();
  const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("the Team research shell passes the run's adaptive schema to the review summary", () => {
    expect(src("components/workspace/projects/TeamResearchDetailShell.tsx")).toContain(
      "teamResearchAncillaryPresentation(state.meta.review, { workspaceId, runId, canCreateExport }, state.presentation.adaptive?.schemaId ?? null)"
    );
  });

  it("the three receipt surfaces route their source flag through ReceiptSourcesFlag with the run's own schema", () => {
    expect(src("components/personalReview/PersonalReviewDetail.tsx")).toContain("<ReceiptSourcesFlag schemaId={data.schemaId} sourceBacked={data.decisionReceipt.sourceBacked} />");
    expect(src("components/teamGovernance/AdaptiveReviewDetail.tsx")).toContain(
      "<ReceiptSourcesFlag schemaId={data.review.schemaId} sourceBacked={data.review.decisionReceipt.sourceBacked} />"
    );
    expect(src("components/teamGovernance/AdaptiveReviewListItem.tsx")).toContain("<ReceiptSourcesFlag schemaId={item.schemaId} sourceBacked={item.sourceBacked} />");
  });

  it("the three receipt surfaces route review wording and the D-9 disclosure through DsReceiptWording with the run's own schema", () => {
    const personal = src("components/personalReview/PersonalReviewDetail.tsx");
    expect(personal).toContain("<ReceiptReviewFlag schemaId={data.schemaId} humanReviewNeeded={data.decisionReceipt.humanReviewNeeded} />");
    expect(personal).toContain("<ReceiptGroupingDisclosure schemaId={data.schemaId}");
    const team = src("components/teamGovernance/AdaptiveReviewDetail.tsx");
    expect(team).toContain("<ReceiptReviewFlag schemaId={data.review.schemaId} humanReviewNeeded={data.review.decisionReceipt.humanReviewNeeded} />");
    expect(team).toContain("<ReceiptGroupingDisclosure schemaId={data.review.schemaId}");
    const list = src("components/teamGovernance/AdaptiveReviewListItem.tsx");
    expect(list).toContain("<ReceiptReviewFlag schemaId={item.schemaId} humanReviewNeeded={item.humanReviewNeeded} />");
    expect(list).toContain("<ReceiptGroupingDisclosure schemaId={item.schemaId}");
  });

  it("the stored-field marker is set only on the two stored-field sites, from the wording module's constants", () => {
    const { execSync } = jest.requireActual("child_process") as typeof import("child_process");
    const hits = execSync("git grep -n data-ds-field -- components app lib ':!**/__tests__/**'", { cwd: ROOT, encoding: "utf8" }).trim().split("\n").sort();
    expect(hits.map((h) => h.replace(/:\d+:\s*/, ":"))).toEqual([
      "components/adaptive/DecisionSupportView.tsx:<p className=\"mt-2 text-sm text-slate-700\" data-ds-field={DS_FIELD_RATIONALE}>",
      "components/adaptive/DsReceiptWording.tsx:<p className={className} data-ds-field={isDecisionSupportSchema(schemaId) ? DS_FIELD_RECEIPT_CONCLUSION : undefined}>",
      "lib/adaptiveSchema/dsLabelWording.ts:* DS field carries `data-ds-field` with one of these values, and nothing else may carry it (pinned by the wiring test).",
    ]);
    const wordingSrc = src("lib/adaptiveSchema/dsLabelWording.ts");
    expect(wordingSrc).toContain('export const DS_FIELD_RATIONALE = "recommendation.rationale";');
    expect(wordingSrc).toContain('export const DS_FIELD_RECEIPT_CONCLUSION = "receipt.conclusion";');
    expect(STORED_FIELDS).toEqual({ rationale: "recommendation.rationale", receiptConclusion: "receipt.conclusion" });
  });

  it("the four receipt surfaces render their conclusion through ReceiptConclusion with the run's own schema", () => {
    expect(src("components/personalReview/PersonalReviewDetail.tsx")).toContain("<ReceiptConclusion schemaId={data.schemaId} conclusion={data.decisionReceipt.conclusion}");
    expect(src("components/teamGovernance/AdaptiveReviewDetail.tsx")).toContain("<ReceiptConclusion schemaId={data.review.schemaId} conclusion={data.review.decisionReceipt.conclusion}");
    expect(src("components/teamGovernance/AdaptiveReviewListItem.tsx")).toContain("<ReceiptConclusion schemaId={item.schemaId} conclusion={item.receiptConclusion}");
    expect(src("components/workspace/projects/TeamResearchReviewSummary.tsx")).toContain("<ReceiptConclusion schemaId={schemaId} conclusion={receipt.conclusion}");
  });

  it("no touched component reads the provenance field", () => {
    for (const p of [
      "components/adaptive/TopSummaryBar.tsx",
      "components/adaptive/DecisionSupportView.tsx",
      "components/adaptive/PanelEvidenceSection.tsx",
      "components/adaptive/ReceiptSourcesFlag.tsx",
      "components/adaptive/DsReceiptWording.tsx",
      "components/workspace/projects/TeamResearchReviewSummary.tsx",
      "lib/adaptiveSchema/dsLabelWording.ts",
    ]) {
      expect([p, /dsProvenance/.test(src(p))]).toEqual([p, false]);
    }
  });
});
