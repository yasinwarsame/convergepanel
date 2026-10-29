/**
 * Order 6 / S-2a — the strict client reading of a route's `dsProvenance` view (dsProvenanceClientView.ts).
 *
 * Views come from the REAL route adapters (buildDsProvenanceRouteView / buildDsProvenanceP2View) over real producer
 * outputs and the sealed golden governance records; every malformed variant is derived from such a view by one change.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildDsProvenanceP2View, buildDsProvenanceRouteView } from "@/lib/adaptiveSchema/dsProvenanceRouteAdapter";
import { buildRunReadPayload } from "@/lib/runs/runReadPayload";
import { dsOutput, dsStates } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { d2Sentence, formatReviewedAtUtc, readDsProvenanceForPage, type RecordedDsCounts } from "@/lib/research/dsProvenanceClientView";

const GOLDENS = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/fixtures/dsProvenanceViewMin.goldens.json"), "utf-8"));
const record = (key: string) => JSON.parse(JSON.stringify(GOLDENS.fixtures.governance[key].record));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const output = (name: string) => dsOutput(dsStates().find((s) => s.name === name)!);
const PER_MODEL = [{ modelId: "chatgpt", status: "ok", rawTextTruncated: "A", latencyMs: 1, wasTruncated: false, provider: "openai", requestedModel: "gpt-5" }];

async function p1View(state = "uncontested_choose_option", rec = "L5P:PERSONAL_SELF_AWC") {
  const out = output(state);
  const governanceRecord = record(rec);
  const payload = await buildRunReadPayload({
    runId: "r1",
    data: { status: "complete", question: "Q", adaptiveOutput: out, governanceRecord, runDocument: { perModel: PER_MODEL } },
    viewerRole: "owner",
    mayReadDecisionContent: true,
    resolveReviewRouting: async () => "in_queue",
  } as never);
  const view = buildDsProvenanceRouteView({ enabled: true, surfaceRequest: { surfaceId: "P1", path: "personal", role: "owner", mayReadDecisionContent: true }, payload, governanceRecord });
  const result = out.result as unknown as Record<string, any>;
  const recorded: RecordedDsCounts = { totalModels: result.totalModels, totalModelsWithRecommendation: result.recommendation?.totalModelsWithRecommendation, supportCount: result.recommendation?.supportCount };
  return { view: clone(view) as Record<string, any>, recorded, result };
}
function p2View(rec = "R12P2:decidedVia_single_reviewer", mayReadDecisionReviewer = true) {
  const view = buildDsProvenanceP2View({ enabled: true, surfaceRequest: { surfaceId: "P2", role: "personal_reviewer", mayReadDecisionReviewer }, storedAdaptiveOutput: output("uncontested_choose_option"), governanceRecord: record(rec) });
  return clone(view) as Record<string, any>;
}

describe("well-formed views map to the approved display model", () => {
  it("P1: sources, strength, counts, review and use authorization", async () => {
    const { view, recorded, result } = await p1View();
    expect(readDsProvenanceForPage(view, "P1", recorded)).toEqual({
      surface: "P1",
      sources: { kind: "listed", items: result.sources },
      strength: true,
      counts: d2Sentence(result.totalModels, result.recommendation.totalModelsWithRecommendation, result.recommendation.supportCount),
      reviewNeeded: "not_flagged",
      reviewRecorded: true,
      reviewedAt: "2026-10-24 15:09 UTC",
      conditions: ["COND-RITA-PERSONAL"],
      notAuthorizedForUse: true,
    });
  });

  it("P2: review state and use authorization only (no L1–L3)", () => {
    expect(readDsProvenanceForPage(p2View(), "P2")).toEqual({
      surface: "P2", sources: null, strength: false, counts: null, reviewNeeded: null, reviewRecorded: true, reviewedAt: "2026-10-25 20:06 UTC", conditions: [], notAuthorizedForUse: true,
    });
  });

  it("reduced P2 (no reviewer identity): no review date", () => {
    expect(readDsProvenanceForPage(p2View("R12T:approved", false), "P2")?.reviewedAt).toBeNull();
  });

  it("Q2: a pending review shows no review-recorded line", async () => {
    const { view, recorded } = await p1View("uncontested_choose_option", "R12P:unreviewed_writer");
    const d = readDsProvenanceForPage(view, "P1", recorded)!;
    expect([d.reviewRecorded, d.reviewedAt, d.conditions]).toEqual([false, null, []]);
  });

  it("blank recorded conditions are not shown", async () => {
    const { view, recorded } = await p1View();
    view.humanReview.conditions = ["", "   ", "Confirm the SLA."];
    expect(readDsProvenanceForPage(view, "P1", recorded)!.conditions).toEqual(["Confirm the SLA."]);
  });

  it("humanReviewNeeded true / unknown", async () => {
    const { view, recorded } = await p1View("high_stakes_review_needed");
    expect(readDsProvenanceForPage(view, "P1", recorded)!.reviewNeeded).toBe("flagged");
    view.l2.humanReviewNeeded = "unknown";
    expect(readDsProvenanceForPage(view, "P1", recorded)!.reviewNeeded).toBeNull();
  });
});

describe("Q4: sources", () => {
  const withList = async (list: unknown, count: unknown = Array.isArray(list) ? list.length : list) => {
    const { view, recorded } = await p1View();
    view.l3.sourcesListedByModels = { list, count };
    return readDsProvenanceForPage(view, "P1", recorded)?.sources;
  };
  it("a recorded list → listed; known empty or only blank → none; not recorded → unknown", async () => {
    expect(await withList(["a", "", "  ", "b"])).toEqual({ kind: "listed", items: ["a", "b"] });
    expect(await withList([])).toEqual({ kind: "none" });
    expect(await withList(["", "  "])).toEqual({ kind: "none" });
    expect(await withList("unknown")).toEqual({ kind: "unknown" });
    // The builder's stand-in for a non-string entry is never shown as a source, and never makes a list "empty".
    expect(await withList(["unknown"])).toEqual({ kind: "unknown" });
    expect(await withList(["x", "unknown"])).toEqual({ kind: "listed", items: ["x"] });
  });
  it("the legacy output without `sources` → unknown (never \"No sources listed\")", async () => {
    const { view, recorded } = await p1View("legacy_no_sources_field");
    expect(readDsProvenanceForPage(view, "P1", recorded)!.sources).toEqual({ kind: "unknown" });
  });
  it("a count that disagrees with the list rejects the view", async () => {
    expect(await withList(["a"], 2)).toBeUndefined();
    expect(await withList("unknown", 0)).toBeUndefined();
  });
});

describe("Q5: counts only when every number is supported", () => {
  it("omitted when a count is unknown, the sentence differs, the numbers are inconsistent, or they differ from the recorded result", async () => {
    const { view, recorded } = await p1View();
    const counts = (v: Record<string, any>, r: RecordedDsCounts | null = recorded) => readDsProvenanceForPage(v, "P1", r)?.counts;
    expect(counts(view)).toMatch(/^3 models dispatched; 3 gave a recommendation; largest group recommending the same action: 3\.$/);
    expect(counts(view, null)).toBeNull();
    expect(counts(view, { ...recorded, supportCount: 2 })).toBeNull();
    const v1 = clone(view); v1.l2.largestAgreeingGroup = "unknown"; expect(counts(v1)).toBeNull();
    const v2 = clone(view); v2.l2.denominatorStatement = "3 models dispatched; 3 gave a recommendation; 3 agreed."; expect(counts(v2)).toBeNull();
    const v3 = clone(view); v3.l2.largestAgreeingGroup = 4; v3.l2.denominatorStatement = d2Sentence(3, 3, 4); expect(counts(v3, { ...recorded, supportCount: 4 })).toBeNull();
  });
  it("R1 MINOR-1: a contested result (largest group smaller than the recommending count) keeps its exact row", async () => {
    const { view, recorded, result } = await p1View("contested_on_action");
    expect([result.totalModels, result.recommendation.totalModelsWithRecommendation, result.recommendation.supportCount]).toEqual([3, 3, 1]);
    const counts = (r: RecordedDsCounts) => readDsProvenanceForPage(view, "P1", r)?.counts;
    expect(counts(recorded)).toBe("3 models dispatched; 3 gave a recommendation; largest group recommending the same action: 1.");
    // Each recorded field is compared with its own count: a recorded value equal to a DIFFERENT count is a mismatch.
    expect(counts({ ...recorded, supportCount: 3 })).toBeNull();
    expect(counts({ ...recorded, totalModelsWithRecommendation: 1 })).toBeNull();
    expect(counts({ ...recorded, totalModels: 1 })).toBeNull();
    // The sentence must be the template for exactly these counts, in this order.
    const swapped = clone(view);
    swapped.l2.denominatorStatement = d2Sentence(3, 1, 3);
    expect(readDsProvenanceForPage(swapped, "P1", recorded)?.counts).toBeNull();
  });

  it("the builder label for the largest group is never part of the display model", async () => {
    const { view, recorded } = await p1View();
    expect(JSON.stringify(readDsProvenanceForPage(view, "P1", recorded))).not.toContain("largest group of models");
  });
});

describe("reviewedAt: valid ISO instants only, formatted in UTC", () => {
  it.each([
    ["2026-10-02T00:00:00.000Z", "2026-10-02 00:00 UTC"],
    ["2026-10-02T23:30:00-05:00", "2026-10-03 04:30 UTC"],
    ["2026-10-02T01:05+03:00", "2026-10-01 22:05 UTC"],
  ])("%s → %s", (iso, shown) => expect(formatReviewedAtUtc(iso)).toBe(shown));
  it("uses UTC fields only (the local-time getters are never consulted)", () => {
    const spies = (["getFullYear", "getMonth", "getDate", "getHours", "getMinutes"] as const).map((m) => jest.spyOn(Date.prototype, m).mockReturnValue(7));
    try {
      expect(formatReviewedAtUtc("2026-10-02T23:30:00-05:00")).toBe("2026-10-03 04:30 UTC");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
  it.each(["2026-02-30T10:00:00Z", "2026-04-31T00:00:00Z", "2025-02-29T00:00:00Z", "2026-10-02T24:00:00Z", "2026-10-02T10:60:00Z", "2026-10-02T10:00:60Z", "2026-10-02T10:00:00+24:00", "2026-00-10T00:00:00Z"])(
    "R1 NIT-1: calendar-impossible %j → not shown (never rolled into another date)",
    (bad) => expect(formatReviewedAtUtc(bad)).toBeNull(),
  );
  it("a leap day in a leap year is a real date", () => expect(formatReviewedAtUtc("2028-02-29T12:00:00Z")).toBe("2028-02-29 12:00 UTC"));
  it.each(["2026-10-02", "2026-13-45T00:00:00Z", "yesterday", "", "2026-10-02T00:00:00", "Thu, 02 Oct 2026 00:00:00 GMT"])("%j → not shown", (bad) => expect(formatReviewedAtUtc(bad)).toBeNull());
});

describe("fail closed: anything outside the route-view schema renders nothing", () => {
  const variants: [string, (v: Record<string, any>) => void][] = [
    ["extra top-level key", (v) => (v.extra = 1)],
    ["missing l2", (v) => delete v.l2],
    ["kind not_built", (v) => (v.kind = "not_built")],
    ["version 2", (v) => (v.version = 2)],
    ["surfaceId W1 on a P1 page", (v) => (v.surfaceId = "W1")],
    ["useAuthorization other", (v) => (v.useAuthorization = "authorized")],
    ["useAuthorization missing", (v) => delete v.useAuthorization],
    ["humanReviewUnavailable", (v) => { delete v.humanReview; v.humanReviewUnavailable = true; }],
    ["review state none", (v) => (v.humanReview = { state: "none" })],
    ["R1 NIT-2: humanReviewUnavailable beside humanReview", (v) => (v.humanReviewUnavailable = true)],
    ["unknown decision", (v) => (v.humanReview.decision = "approved_by_magic")],
    ["unknown decidedVia", (v) => (v.humanReview.decidedVia = "committee")],
    ["reviewedAt object", (v) => (v.humanReview.reviewedAt = { at: "x" })],
    ["conditions string", (v) => (v.humanReview.conditions = "c")],
    ["extra review key", (v) => (v.humanReview.reviewerId = "uid-x")],
    ["L4 text altered", (v) => (v.l4.option_clustering_unverified_text += " ")],
    ["L4 flag false", (v) => (v.l4.sources_unchecked = false)],
    ["L4 extra key", (v) => (v.l4.verified = true)],
    ["slot status unknown enum", (v) => (v.l1[0].status = "verified")],
    ["slot extra key", (v) => (v.l1[0].rawResponse = "x")],
    ["l1 string", (v) => (v.l1 = "slots")],
    ["l2 label altered", (v) => (v.l2.largestAgreeingGroupLabel = "models in agreement")],
    ["l2 count object", (v) => (v.l2.dispatchedModels = { n: 3 })],
    ["l2 rules changed", (v) => (v.l2.rules.optionMatcher = "v2")],
    ["l3 strength value object", (v) => (v.l3.modelSelfReportedEvidenceStrength[0].evidenceStrength = { s: 1 })],
    ["l3 sources array of objects", (v) => (v.l3.sourcesListedByModels = { list: [{ url: "x" }], count: 1 })],
    ["l3 sourceCheck evaluated", (v) => (v.l3.sourceCheck = "evaluated")],
    ["l3 freshness evaluated", (v) => (v.l3.freshness = "evaluated")],
  ];
  it.each(variants)("%s", async (_label, mutate) => {
    const { view, recorded } = await p1View();
    expect(readDsProvenanceForPage(view, "P1", recorded)).not.toBeNull();
    mutate(view);
    expect(readDsProvenanceForPage(view, "P1", recorded)).toBeNull();
  });

  it("non-objects, arrays and a throwing getter render nothing and never throw", async () => {
    for (const raw of [undefined, null, 0, "ds", [], [{}], true]) expect(readDsProvenanceForPage(raw, "P1")).toBeNull();
    const { view } = await p1View();
    const hostile = new Proxy(view, { get: () => { throw new Error("boom"); } });
    expect(readDsProvenanceForPage(hostile, "P1")).toBeNull();
  });

  it("view/page isolation: a P1 view on the inbox, a P2 view on a P1 or W1 page", async () => {
    const { view, recorded } = await p1View();
    expect(readDsProvenanceForPage(view, "P2")).toBeNull();
    expect(readDsProvenanceForPage(view, "W1", recorded)).toBeNull();
    const p2 = p2View();
    expect(readDsProvenanceForPage(p2, "P1")).toBeNull();
    expect(readDsProvenanceForPage(p2, "W1")).toBeNull();
  });

  it("P2 ceiling: a P2 view carrying decidedVia or conditions is not one the route sends", () => {
    const a = p2View(); a.humanReview.decidedVia = "single_reviewer";
    const b = p2View(); b.humanReview.conditions = ["c"];
    const c = p2View(); c.l2 = {};
    for (const v of [a, b, c]) expect(readDsProvenanceForPage(v, "P2")).toBeNull();
  });
});
