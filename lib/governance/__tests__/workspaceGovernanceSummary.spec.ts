/**
 * Step 6.3 — computeWorkspaceGovernanceSummary against the contract.
 *
 * The computed summary (exact counts + derived arithmetic) must equal an
 * INDEPENDENT per-document oracle on an adversarial dataset, and every query
 * shape the code produces must stay inside the contract's operator set.
 */
import {
  canonicalProjectIdsFromListing,
  computeWorkspaceGovernanceSummary,
  containmentSpecs,
  GovernanceSummaryInconsistentError,
  IN_BATCH_SIZE,
  OTHER_RECORDED,
  type CountSpec,
  type Family,
  type WorkspaceGovernanceSummary,
} from "@/lib/governance/workspaceGovernanceSummary";
import { reconcileGovernanceSummary } from "@/lib/governance/workspaceGovernanceSummaryPresentation";
import { fakeCountExecutor, matches, oracleSummary, type Dataset, type Doc } from "./governanceSummaryFakes";

const W = "ws-1";
const P1 = "proj-active";
const P2 = "proj-archived";
const CANON = [P1, P2];

let n = 0;
const run = (over: Doc): Doc => ({ id: `r${++n}`, workspaceId: W, projectId: null, status: "complete", ...over });
const claim = (over: Doc): Doc => ({ id: `c${++n}`, workspaceId: W, projectId: null, type: "claim_verification", ...over });
const video = (over: Doc): Doc => ({ id: `v${++n}`, workspaceId: W, projectId: null, type: "video_verification", ...over });
const ADAPTIVE = { adaptiveOutput: { version: 1 } };
const gr = (automated?: unknown, human?: unknown) => ({
  governanceRecord: {
    version: 1,
    ...(automated === undefined ? {} : { automatedGovernance: { status: automated } }),
    ...(human === undefined ? {} : { humanReview: { status: human } }),
  },
});
const REV = { governanceReviewedAt: "2026-10-01T00:00:00.000Z" };

/** Every edge the contract names, for each System A family. */
function systemARecords(make: (o: Doc) => Doc): Doc[] {
  return [
    make({ governanceStatus: "approved" }),
    make({ governanceStatus: "approved", projectId: P1 }),
    make({ governanceStatus: "needs_review", projectId: P2 }), // archived Project: contained
    make({ governanceStatus: "blocked" }),
    make({ governanceStatus: "approved", ...REV }), // human approved → superseded
    make({ governanceStatus: "needs_review", ...REV }), // human changes_requested
    make({ governanceStatus: "blocked", ...REV, projectId: P1 }),
    make({ governanceStatus: "garbage" }), // __other_recorded__
    make({ governanceStatus: "garbage", ...REV }), // reviewed malformed (other)
    make({ ...REV }), // reviewed malformed (missing)
    make({ governanceStatus: null, ...REV }), // reviewed malformed (null)
    make({}), // missing
    make({ governanceStatus: null }), // null → missing
    make({ governanceStatus: "approved", governanceReviewedAt: "" }), // empty reviewedAt is NOT reviewed
    make({ governanceStatus: "approved", projectId: "proj-foreign" }), // integrity
    make({ governanceStatus: "approved", projectId: "proj-malformed" }), // integrity (malformed Project not canonical)
    (() => {
      const d = make({ governanceStatus: "approved" });
      delete d.projectId; // missing projectId → integrity
      return d;
    })(),
    make({ governanceStatus: "approved", projectId: 42 }), // malformed projectId → integrity
  ];
}

function dataset(): Dataset {
  n = 0;
  return {
    runs: [
      ...systemARecords((o) => run(o)),
      run({ governanceStatus: "approved", status: "running" }), // incomplete research
      run({ status: "queued" }),
      run({ ...gr(), governanceStatus: "approved" }), // research run carrying a governanceRecord → overlap
      // research_adaptive (System B)
      run({ ...ADAPTIVE, ...gr("passed", "approved") }),
      run({ ...ADAPTIVE, ...gr("flagged", "pending"), projectId: P1 }),
      run({ ...ADAPTIVE, ...gr("blocked", "rejected") }),
      run({ ...ADAPTIVE, ...gr("not_evaluated", "unreviewed") }),
      run({ ...ADAPTIVE, ...gr("error", "changes_requested") }),
      run({ ...ADAPTIVE, ...gr("weird", "weird-human") }),
      run({ ...ADAPTIVE, ...gr(null, null) }),
      run({ ...ADAPTIVE, ...gr() }), // record without statuses → missing both
      run({ ...ADAPTIVE }), // no governanceRecord at all → missing both
      run({ ...ADAPTIVE, ...gr("passed", "approved_with_conditions"), governanceStatus: "approved" }), // overlap
      run({ ...ADAPTIVE, ...gr("passed", "approved"), status: "running" }), // incomplete adaptive
      run({ ...ADAPTIVE, ...gr("passed", "approved"), projectId: "proj-foreign" }), // integrity
      // other Workspace — never counted
      run({ workspaceId: "ws-other", governanceStatus: "approved" }),
    ],
    verifications: [
      ...systemARecords((o) => claim(o)),
      { id: "x1", workspaceId: W, projectId: null, type: "something_else", governanceStatus: "approved" }, // other type
      claim({ workspaceId: "ws-other", governanceStatus: "approved" }),
    ],
    videoVerifications: [...systemARecords((o) => video(o)), video({ workspaceId: "ws-other", governanceStatus: "blocked" })],
  };
}

async function compute(data: Dataset, log: CountSpec[] = [], projects = CANON) {
  return computeWorkspaceGovernanceSummary({ workspaceId: W, canonicalProjectIds: projects, count: fakeCountExecutor(data, log), now: () => new Date("2026-10-09T00:00:00.000Z") });
}

const row = (s: WorkspaceGovernanceSummary, family: Family, axis: "automated" | "human", pick: (r: WorkspaceGovernanceSummary["rows"][number]) => boolean) =>
  s.rows.filter((r) => r.family === family && r.axis === axis && pick(r)).reduce((a, r) => a + r.count, 0);

describe("the fake follows Firestore's documented semantics (the predicate is the boundary)", () => {
  const spec = (op: CountSpec["filters"][number]["op"], value: unknown, field = "f"): CountSpec => ({ collection: "runs", filters: [{ field, op, value }] });
  it("== null matches an explicit null, never a missing field", () => {
    expect(matches({ f: null }, spec("==", null))).toBe(true);
    expect(matches({}, spec("==", null))).toBe(false);
  });
  it("not-in excludes missing and null, and a null in the list matches nothing", () => {
    expect(matches({}, spec("not-in", ["a"]))).toBe(false);
    expect(matches({ f: null }, spec("not-in", ["a"]))).toBe(false);
    expect(matches({ f: "b" }, spec("not-in", ["a"]))).toBe(true);
    expect(matches({ f: "b" }, spec("not-in", ["a", null]))).toBe(false);
  });
  it('> "" matches non-empty strings only', () => {
    expect(matches({ f: "x" }, spec(">", ""))).toBe(true);
    expect(matches({ f: "" }, spec(">", ""))).toBe(false);
    expect(matches({ f: 5 }, spec(">", ""))).toBe(false);
    expect(matches({}, spec(">", ""))).toBe(false);
  });
  it("dotted paths resolve nested fields", () => {
    expect(matches({ a: { b: 1 } }, spec("==", 1, "a.b"))).toBe(true);
    expect(matches({ a: {} }, spec("==", 1, "a.b"))).toBe(false);
  });
  it("rejects in + not-in in one query, as Firestore does", async () => {
    await expect(fakeCountExecutor({ runs: [], verifications: [], videoVerifications: [] })({ collection: "runs", filters: [{ field: "a", op: "in", value: [1] }, { field: "b", op: "not-in", value: [2] }] })).rejects.toThrow(/cannot be combined/);
  });
});

describe("computed summary equals the independent per-document oracle", () => {
  it("every family total, exclusion, integrity anomaly, automated bucket, human decision and anomaly matches", async () => {
    const data = dataset();
    const s = await compute(data);
    const o = oracleSummary(data, W, CANON);

    for (const family of ["research", "research_adaptive", "claim_verification", "video_verification"] as Family[]) {
      const t = s.totals.find((x) => x.family === family)!;
      const of = o.families[family];
      expect([family, t.total, t.excludedNotComplete, t.integrityAnomalies]).toEqual([family, of.total, of.excludedNotComplete, of.integrityAnomalies]);
      const auto = (k: string) => of.automated[k] ?? 0;
      if (family === "research_adaptive") {
        for (const x of ["passed", "flagged", "blocked", "not_evaluated", "error"]) expect(row(s, family, "automated", (r) => r.storedStatus === x)).toBe(auto(x));
        expect(row(s, family, "automated", (r) => r.storedStatus === OTHER_RECORDED)).toBe(auto("__other__"));
        expect(row(s, family, "automated", (r) => r.subReason === "missing")).toBe(auto("__missing__"));
        for (const h of ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]) expect(row(s, family, "human", (r) => r.storedStatus === h)).toBe(of.human[h] ?? 0);
        expect(row(s, family, "human", (r) => r.storedStatus === OTHER_RECORDED)).toBe(of.human.__other__ ?? 0);
        expect(row(s, family, "human", (r) => r.subReason === "missing")).toBe(of.human.__missing__ ?? 0);
      } else {
        for (const x of ["approved", "needs_review", "blocked"]) {
          expect(row(s, family, "automated", (r) => r.storedStatus === x)).toBe(auto(x));
          expect(row(s, family, "human", (r) => r.storedStatus === x)).toBe(of.human[x] ?? 0);
        }
        expect(row(s, family, "automated", (r) => r.subReason === "superseded_by_human_decision")).toBe(auto("__superseded__"));
        expect(row(s, family, "automated", (r) => r.storedStatus === OTHER_RECORDED)).toBe(auto("__other__"));
        expect(row(s, family, "automated", (r) => r.subReason === "missing")).toBe(auto("__missing__"));
        const malformed = s.anomalies.filter((a) => a.kind === "reviewed_status_malformed" && a.family === family).reduce((a, x) => a + x.count, 0);
        expect(malformed).toBe(of.reviewedMalformed);
        expect(t.automatedDenominator).toBe(of.total - of.reviewedMalformed);
      }
    }
    const overlap = (family: Family) => s.anomalies.filter((a) => a.kind === "family_overlap" && a.family === family).reduce((a, x) => a + x.count, 0);
    expect(overlap("research_adaptive")).toBe(o.anomalies.adaptiveWithA);
    expect(overlap("research")).toBe(o.anomalies.researchWithB);
    // Non-vacuity: the dataset really exercises every edge.
    expect(o.families.research.reviewedMalformed).toBe(3);
    expect(o.families.research.integrityAnomalies).toBe(4);
    expect(o.families.research.excludedNotComplete).toBe(2);
    expect(o.anomalies.adaptiveWithA).toBe(1);
    expect(o.anomalies.researchWithB).toBe(1);
  });

  it("the response reconciles: every total decomposes into its rows and anomalies", async () => {
    expect(reconcileGovernanceSummary(await compute(dataset()))).toEqual([]);
  });
});

describe("targeted contract properties", () => {
  it("reviewed rows with an unknown, missing or null status never enter any automated bucket or human decision", async () => {
    n = 0;
    const data: Dataset = { runs: [], verifications: [claim({ governanceStatus: "garbage", ...REV }), claim({ ...REV }), claim({ governanceStatus: null, ...REV })], videoVerifications: [] };
    const s = await compute(data);
    expect(s.rows.filter((r) => r.family === "claim_verification").every((r) => r.count === 0)).toBe(true);
    expect(s.anomalies).toContainEqual({ kind: "reviewed_status_malformed", family: "claim_verification", count: 3 });
    expect(s.totals.find((t) => t.family === "claim_verification")).toMatchObject({ total: 3, automatedDenominator: 0 });
  });

  it("human-reviewed System A states never count as automated cleared / attention / blocked", async () => {
    n = 0;
    const data: Dataset = { runs: [], verifications: [], videoVerifications: [video({ governanceStatus: "approved", ...REV }), video({ governanceStatus: "blocked", ...REV }), video({ governanceStatus: "needs_review", ...REV })] };
    const s = await compute(data);
    for (const outcome of ["cleared", "needs_attention", "blocked"]) expect(row(s, "video_verification", "automated", (r) => r.normalizedOutcome === outcome)).toBe(0);
    expect(row(s, "video_verification", "automated", (r) => r.subReason === "superseded_by_human_decision")).toBe(3);
    expect(s.rows.filter((r) => r.family === "video_verification" && r.axis === "human").map((r) => [r.humanDecision, r.count])).toEqual([
      ["approved", 1],
      ["changes_requested", 1],
      ["blocked", 1],
    ]);
  });

  it("incomplete research runs are excluded from the denominator and counted separately", async () => {
    n = 0;
    const data: Dataset = { runs: [run({ governanceStatus: "approved" }), run({ status: "running", governanceStatus: "approved" }), run({ status: "error" })], verifications: [], videoVerifications: [] };
    const t = (await compute(data)).totals.find((x) => x.family === "research")!;
    expect([t.total, t.excludedNotComplete]).toEqual([1, 2]);
  });

  it("missing, malformed, foreign and non-canonical Project bindings never enter ordinary outcomes", async () => {
    n = 0;
    const bad = [run({ governanceStatus: "approved", projectId: "proj-foreign" }), run({ governanceStatus: "approved", projectId: 7 }), run({ governanceStatus: "approved", projectId: "" })];
    const missing = run({ governanceStatus: "approved" });
    delete missing.projectId;
    const s = await compute({ runs: [...bad, missing], verifications: [], videoVerifications: [] });
    const t = s.totals.find((x) => x.family === "research")!;
    expect([t.total, t.integrityAnomalies]).toEqual([0, 4]);
    expect(row(s, "research", "automated", () => true)).toBe(0);
  });

  it("other Workspaces and other verification types are never counted", async () => {
    n = 0;
    const s = await compute({
      runs: [run({ workspaceId: "ws-other", governanceStatus: "approved" })],
      verifications: [{ id: "x", workspaceId: W, projectId: null, type: "other", governanceStatus: "approved" }],
      videoVerifications: [],
    });
    expect(s.totals.every((t) => t.total === 0 && t.integrityAnomalies === 0)).toBe(true);
  });
});

describe("query shapes stay inside the contract", () => {
  it("every executed spec: workspace-scoped, only ==/in/not-in/>, never in+not-in, never null in not-in, never !=", async () => {
    const log: CountSpec[] = [];
    await compute(dataset(), log);
    expect(log.length).toBeGreaterThan(0);
    for (const spec of log) {
      expect(spec.filters[0]).toEqual({ field: "workspaceId", op: "==", value: W });
      const ops = spec.filters.map((f) => f.op);
      for (const op of ops) expect(["==", "in", "not-in", ">"]).toContain(op);
      expect(ops.includes("in") && ops.includes("not-in")).toBe(false);
      for (const f of spec.filters) if (f.op === "not-in") expect((f.value as unknown[]).includes(null)).toBe(false);
      for (const f of spec.filters) if (f.op === "in") expect((f.value as unknown[]).length).toBeLessThanOrEqual(IN_BATCH_SIZE);
      for (const f of spec.filters) if (f.op === ">") expect(f).toEqual({ field: "governanceReviewedAt", op: ">", value: "" });
    }
  });

  it("not-in predicates decompose into explicit-null + per-Project equality branches; others batch Projects with in", () => {
    const ids = Array.from({ length: 65 }, (_, i) => `p${i}`);
    const notIn = containmentSpecs("runs", [{ field: "governanceStatus", op: "not-in", value: ["approved"] }], ids);
    expect(notIn).toHaveLength(1 + 65);
    expect(notIn.every((s) => s.filters.some((f) => f.field === "projectId" && f.op === "=="))).toBe(true);
    const eq = containmentSpecs("runs", [{ field: "governanceStatus", op: "==", value: "approved" }], ids);
    expect(eq).toHaveLength(1 + 3);
    expect(eq.slice(1).map((s) => (s.filters.find((f) => f.field === "projectId")!.value as string[]).length)).toEqual([30, 30, 5]);
    // The branches are disjoint and cover exactly the canonical set + explicit null.
    const covered = eq.slice(1).flatMap((s) => s.filters.find((f) => f.field === "projectId")!.value as string[]);
    expect(new Set(covered).size).toBe(65);
    expect(eq[0].filters).toContainEqual({ field: "projectId", op: "==", value: null });
  });

  it("an empty canonical Project set queries the explicit-null branch only", () => {
    expect(containmentSpecs("runs", [], [])).toEqual([{ collection: "runs", filters: [{ field: "projectId", op: "==", value: null }] }]);
  });
});

describe("canonical Project set (contract §4 point 1)", () => {
  const wellFormed = (d: unknown) => (d as { ok?: boolean }).ok === true;
  it("keeps only well-formed Projects whose embedded id equals the document id and whose workspaceId is W; active and archived both kept", () => {
    expect(
      canonicalProjectIdsFromListing(
        W,
        [
          { id: "a", data: { ok: true, id: "a", workspaceId: W, status: "active" } },
          { id: "b", data: { ok: true, id: "b", workspaceId: W, status: "archived" } },
          { id: "c", data: { ok: false, id: "c", workspaceId: W } },
          { id: "d", data: { ok: true, id: "not-d", workspaceId: W } },
          { id: "e", data: { ok: true, id: "e", workspaceId: "ws-other" } },
        ],
        wellFormed
      )
    ).toEqual(["a", "b"]);
  });
});

describe("inconsistent counts are refused, never returned", () => {
  it("a negative residual (a write between queries) throws GovernanceSummaryInconsistentError", async () => {
    let calls = 0;
    // Total query returns 0 but a status query returns 1 → negative residual.
    const exec = async (spec: CountSpec) => {
      calls += 1;
      return spec.filters.some((f) => f.field === "governanceStatus" && f.op === "==") ? 1 : 0;
    };
    await expect(computeWorkspaceGovernanceSummary({ workspaceId: W, canonicalProjectIds: [], count: exec })).rejects.toBeInstanceOf(GovernanceSummaryInconsistentError);
    expect(calls).toBeGreaterThan(0);
  });
});
