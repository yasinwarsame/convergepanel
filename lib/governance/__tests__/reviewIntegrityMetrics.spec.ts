/**
 * Order 3 — Review Integrity Metrics v1, pure domain.
 *
 * The computed metrics are compared with an ORACLE that classifies every
 * document directly from the contract (no subtraction, no residuals), over the
 * Step 6.3 fake whose operator semantics are Firestore's own (`==`/`in` never
 * match a missing field; `not-in` excludes missing AND null; `in` + `not-in`
 * rejected). This wrapper also enforces Firestore's 30-disjunction limit, as
 * the emulator characterization showed real Firestore does.
 */
import { fakeCountExecutor, matches, type Dataset, type Doc } from "./governanceSummaryFakes";
import type { CountExecutor, CountSpec } from "@/lib/governance/workspaceGovernanceSummary";
import {
  computeReviewIntegrityMetrics,
  DECISION_PATHS,
  F_DECIDED_VIA,
  F_HUMAN_STATUS,
  REVIEW_STATES,
  ReviewIntegrityInconsistentError,
  TERMINAL_REVIEW_STATES,
  type ReviewIntegrityMetricsV1,
} from "@/lib/governance/reviewIntegrityMetrics";

const W = "ws-1";
const NOW = () => new Date("2026-10-11T00:00:00.000Z");
const CANON = ["P1", "P2"];

function strictExecutor(runs: Doc[], log: CountSpec[] = []): CountExecutor {
  const inner = fakeCountExecutor({ runs, verifications: [], videoVerifications: [] } as Dataset);
  return async (spec) => {
    const disjunctions = spec.filters.filter((f) => f.op === "in").reduce((a, f) => a * (f.value as unknown[]).length, 1);
    if (disjunctions > 30) throw new Error("3 INVALID_ARGUMENT: Too many disjunctions after normalization, the maximum is 30");
    log.push(spec);
    return inner(spec);
  };
}

const compute = (runs: Doc[], canonicalProjectIds: readonly string[] = CANON, log: CountSpec[] = []) =>
  computeReviewIntegrityMetrics({ workspaceId: W, canonicalProjectIds, count: strictExecutor(runs, log), now: NOW });

// ── oracle: direct classification, document by document ──────────────────
const MISSING = Symbol("missing");
function read(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return MISSING;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
function oracle(runs: Doc[], canonical: readonly string[]): Omit<ReviewIntegrityMetricsV1, "generatedAt"> {
  const fam = runs.filter((d) => d.workspaceId === W && read(d, "adaptiveOutput.version") === 1 && d.status === "complete");
  const contained = fam.filter((d) => Object.prototype.hasOwnProperty.call(d, "projectId") && (d.projectId === null || (typeof d.projectId === "string" && canonical.includes(d.projectId))));
  const st = (d: Doc) => read(d, F_HUMAN_STATUS);
  const states = REVIEW_STATES.map((s) => ({ status: s, count: contained.filter((d) => st(d) === s).length }));
  const otherOrMissing = contained.filter((d) => !(REVIEW_STATES as readonly unknown[]).includes(st(d))).length;
  const terminalDocs = contained.filter((d) => (TERMINAL_REVIEW_STATES as readonly unknown[]).includes(st(d)));
  const paths = DECISION_PATHS.map((p) => ({ path: p, count: terminalDocs.filter((d) => read(d, F_DECIDED_VIA) === p).length }));
  const pathOther = terminalDocs.filter((d) => !(DECISION_PATHS as readonly unknown[]).includes(read(d, F_DECIDED_VIA))).length;
  const n = (s: string) => states.find((x) => x.status === s)!.count;
  const panel = paths[1].count;
  const override = paths[2].count;
  return {
    version: 1,
    workspaceId: W,
    scope: { family: "research_adaptive", sourceSystem: "B", completion: "complete_only", timeRange: "all_recorded", projectContainment: "null_or_canonical_workspace_project", teamWorkspaceOnly: true },
    totals: {
      completedAdaptiveResearch: contained.length,
      terminalHumanDecisions: terminalDocs.length,
      nonTerminalRecognized: n("unreviewed") + n("pending"),
      otherOrMissingReviewState: otherOrMissing,
      projectIntegrityAnomalies: fam.length - contained.length,
    },
    reviewStates: [...states, { status: "other_or_missing", count: otherOrMissing }],
    decisionPaths: [...paths, { path: "other_or_missing", count: pathOther }],
    multiReviewer: { explicitDecisionCount: panel + override, panelFinalizationCount: panel, ownerOverrideCount: override },
  };
}
const withoutTime = (m: ReviewIntegrityMetricsV1) => {
  const { generatedAt, ...rest } = m;
  expect(generatedAt).toBe("2026-10-11T00:00:00.000Z");
  return rest;
};

// ── fixtures ──────────────────────────────────────────────────────────────
const ABSENT = Symbol("absent");
const NO_RECORD = Symbol("no_record");
function run(opts: { projectId?: unknown; status?: unknown; path?: unknown; extra?: Doc } = {}): Doc {
  const { projectId = null, status = ABSENT, path = ABSENT, extra = {} } = opts;
  const doc: Doc = { workspaceId: W, status: "complete", adaptiveOutput: { version: 1 }, ...extra };
  if (projectId !== ABSENT) doc.projectId = projectId;
  if (status !== NO_RECORD) {
    const hr: Doc = {};
    if (status !== ABSENT) hr.status = status;
    if (path !== ABSENT) hr.decidedVia = path;
    doc.governanceRecord = { version: 1, humanReview: hr };
  }
  return doc;
}
const statesOf = (m: ReviewIntegrityMetricsV1) => Object.fromEntries(m.reviewStates.map((r) => [r.status, r.count]));
const pathsOf = (m: ReviewIntegrityMetricsV1) => Object.fromEntries(m.decisionPaths.map((p) => [p.path, p.count]));

/** Every project × status × path combination, plus documents outside the family. */
function matrix(): Doc[] {
  const docs: Doc[] = [];
  for (const projectId of [null, "P1", "P2", "P9-foreign", "PX-unknown", ABSENT])
    for (const status of [...REVIEW_STATES, "bogus", 7, null, ABSENT, NO_RECORD])
      for (const path of [ABSENT, null, ...DECISION_PATHS, "weird", 3]) docs.push(run({ projectId, status, path }));
  docs.push(run({ extra: { workspaceId: "ws-other" }, status: "approved", path: "multi_reviewer_panel" }));
  docs.push(run({ extra: { status: "running" }, status: "approved", path: "multi_reviewer_panel" }));
  docs.push(run({ extra: { adaptiveOutput: { version: 2 } }, status: "approved", path: "multi_reviewer_panel" }));
  docs.push({ workspaceId: W, status: "complete", projectId: null, governanceRecord: { version: 1, humanReview: { status: "approved", decidedVia: "multi_reviewer_panel" } } });
  return docs;
}

describe("whole contract against the oracle", () => {
  it("the full project × status × path matrix (with out-of-family noise) equals direct classification", async () => {
    const docs = matrix();
    const m = await compute(docs);
    expect(withoutTime(m)).toEqual(oracle(docs, CANON));
    // Non-vacuity: every bucket is populated.
    expect(m.totals.completedAdaptiveResearch).toBeGreaterThan(0);
    expect(m.totals.projectIntegrityAnomalies).toBeGreaterThan(0);
    for (const r of m.reviewStates) expect(r.count).toBeGreaterThan(0);
    for (const p of m.decisionPaths) expect(p.count).toBeGreaterThan(0);
  });

  it("empty Workspace → every count 0, a valid response (21 count queries with no Projects)", async () => {
    const log: CountSpec[] = [];
    const m = await compute([], [], log);
    expect(withoutTime(m)).toEqual(oracle([], []));
    expect(log).toHaveLength(21);
  });
});

describe("review states", () => {
  it.each(REVIEW_STATES)("a run recorded as %s counts in exactly that row", async (s) => {
    const m = await compute([run({ status: s })]);
    expect(statesOf(m)).toEqual({ ...Object.fromEntries(REVIEW_STATES.map((x) => [x, x === s ? 1 : 0])), other_or_missing: 0 });
  });

  it("unknown, numeric, explicit-null, absent status and no governance record → other or missing; never terminal (mutation D)", async () => {
    const docs = [run({ status: "bogus" }), run({ status: 7 }), run({ status: null }), run({ status: ABSENT }), run({ status: NO_RECORD })];
    const m = await compute(docs);
    expect(m.totals.otherOrMissingReviewState).toBe(5);
    expect(m.totals.terminalHumanDecisions).toBe(0);
    expect(m.totals.nonTerminalRecognized).toBe(0);
    expect(m.totals.completedAdaptiveResearch).toBe(5);
    // Positive control: one recognized terminal status does count.
    expect((await compute([...docs, run({ status: "rejected" })])).totals.terminalHumanDecisions).toBe(1);
  });

  it("terminal = approved + approved_with_conditions + changes_requested + rejected; non-terminal = unreviewed + pending", async () => {
    const docs = [...REVIEW_STATES.flatMap((s, i) => Array.from({ length: i + 1 }, () => run({ status: s })))];
    const m = await compute(docs);
    expect(m.totals.terminalHumanDecisions).toBe(3 + 4 + 5 + 6);
    expect(m.totals.nonTerminalRecognized).toBe(1 + 2);
  });

  it("MUTATION I: the other-recorded query lists exactly the six recognized statuses — never null (a null makes Firestore's not-in match nothing)", async () => {
    const log: CountSpec[] = [];
    await compute([], CANON, log);
    const notIn = log.flatMap((s) => s.filters).filter((f) => f.op === "not-in");
    expect(notIn.length).toBeGreaterThan(0);
    for (const f of notIn) {
      expect(f.field).toBe(F_HUMAN_STATUS);
      expect(f.value).toEqual([...REVIEW_STATES]);
    }
    // And the residual is arithmetic: no `status == null` query is ever issued.
    expect(log.flatMap((s) => s.filters).some((f) => f.value === null && f.field !== "projectId")).toBe(false);
  });

  it("other recorded and missing are separated by the not-in query: an unknown status alone is reported, a missing one alone is reported", async () => {
    // Both land in the public other_or_missing row; the internal split must still reconcile on its own.
    expect((await compute([run({ status: "bogus" })])).totals.otherOrMissingReviewState).toBe(1);
    expect((await compute([run({ status: ABSENT })])).totals.otherOrMissingReviewState).toBe(1);
  });
});

describe("decision paths", () => {
  it.each(TERMINAL_REVIEW_STATES.flatMap((t) => DECISION_PATHS.map((p) => [t, p] as const)))("%s via %s → that path, once", async (t, p) => {
    const m = await compute([run({ status: t, path: p })]);
    expect(pathsOf(m)).toEqual({ ...Object.fromEntries(DECISION_PATHS.map((x) => [x, x === p ? 1 : 0])), other_or_missing: 0 });
  });

  it("MUTATION A: a terminal decision with NO decidedVia is 'path not recorded', never single-reviewer", async () => {
    const m = await compute([run({ status: "approved", path: ABSENT })]);
    expect(pathsOf(m).other_or_missing).toBe(1);
    expect(pathsOf(m).single_reviewer).toBe(0);
    // Positive control: an explicitly recorded single_reviewer IS counted.
    expect(pathsOf(await compute([run({ status: "approved", path: "single_reviewer" })])).single_reviewer).toBe(1);
  });

  it("explicit null, unknown string and numeric decidedVia → path not recorded or unrecognized", async () => {
    const m = await compute([run({ status: "approved", path: null }), run({ status: "rejected", path: "weird" }), run({ status: "changes_requested", path: 3 })]);
    expect(pathsOf(m)).toEqual({ single_reviewer: 0, multi_reviewer_panel: 0, multi_reviewer_owner_override: 0, other_or_missing: 3 });
  });

  it("MUTATION H: a known decidedVia on a NON-terminal or unrecognized status is never a decision path", async () => {
    const stale = [
      run({ status: "pending", path: "multi_reviewer_panel" }),
      run({ status: "unreviewed", path: "multi_reviewer_owner_override" }),
      run({ status: "bogus", path: "multi_reviewer_panel" }),
      run({ status: ABSENT, path: "single_reviewer" }),
    ];
    const m = await compute(stale);
    expect(m.totals.terminalHumanDecisions).toBe(0);
    expect(pathsOf(m)).toEqual({ single_reviewer: 0, multi_reviewer_panel: 0, multi_reviewer_owner_override: 0, other_or_missing: 0 });
    expect(m.multiReviewer).toEqual({ explicitDecisionCount: 0, panelFinalizationCount: 0, ownerOverrideCount: 0 });
    // Positive control: the same path on a terminal status counts.
    expect((await compute([...stale, run({ status: "approved", path: "multi_reviewer_panel" })])).multiReviewer.panelFinalizationCount).toBe(1);
  });

  it("every path query carries BOTH status == <terminal> and decidedVia == <known path>; decidedVia never uses not-in", async () => {
    const log: CountSpec[] = [];
    await compute([], CANON, log);
    const pathSpecs = log.filter((s) => s.filters.some((f) => f.field === F_DECIDED_VIA));
    expect(pathSpecs.length).toBe(12 * 2); // 4 terminal × 3 paths × (null branch + one Project batch)
    for (const s of pathSpecs) {
      const p = s.filters.filter((f) => f.field === F_DECIDED_VIA);
      const t = s.filters.filter((f) => f.field === F_HUMAN_STATUS);
      expect(p).toHaveLength(1);
      expect(p[0].op).toBe("==");
      expect(DECISION_PATHS).toContain(p[0].value);
      expect(t).toHaveLength(1);
      expect(t[0].op).toBe("==");
      expect(TERMINAL_REVIEW_STATES).toContain(t[0].value);
    }
  });

  it("MUTATION B: owner overrides are counted against explicit multi-reviewer decisions only (1 of 3, not 1 of 10)", async () => {
    const docs = [
      ...Array.from({ length: 5 }, () => run({ status: "approved", path: ABSENT })),
      run({ status: "approved", path: "single_reviewer" }),
      run({ status: "rejected", path: "single_reviewer" }),
      run({ status: "approved", path: "multi_reviewer_panel" }),
      run({ status: "changes_requested", path: "multi_reviewer_panel" }),
      run({ status: "approved_with_conditions", path: "multi_reviewer_owner_override" }),
    ];
    const m = await compute(docs);
    expect(m.totals.terminalHumanDecisions).toBe(10);
    expect(m.multiReviewer).toEqual({ explicitDecisionCount: 3, panelFinalizationCount: 2, ownerOverrideCount: 1 });
    expect(pathsOf(m)).toEqual({ single_reviewer: 2, multi_reviewer_panel: 2, multi_reviewer_owner_override: 1, other_or_missing: 5 });
  });
});

describe("Project containment (Step 6.3 semantics)", () => {
  it("MUTATION C: only projectId null or a canonical Project counts; missing field, unknown and foreign Projects are integrity exclusions", async () => {
    const docs = [
      run({ projectId: null, status: "approved" }),
      run({ projectId: "P1", status: "approved" }),
      run({ projectId: ABSENT, status: "approved" }),
      run({ projectId: "PX-unknown", status: "approved" }),
      run({ projectId: "P9-foreign", status: "approved" }),
    ];
    const m = await compute(docs);
    expect(m.totals.completedAdaptiveResearch).toBe(2);
    expect(m.totals.terminalHumanDecisions).toBe(2);
    expect(m.totals.projectIntegrityAnomalies).toBe(3);
  });

  it("a Project absent from the canonical set (malformed or foreign listing entry) is excluded even when runs reference it", async () => {
    const docs = [run({ projectId: "P1", status: "approved" }), run({ projectId: "P2", status: "approved" })];
    const m = await compute(docs, ["P1"]);
    expect(m.totals.completedAdaptiveResearch).toBe(1);
    expect(m.totals.projectIntegrityAnomalies).toBe(1);
  });

  it("partially complete adaptive runs never enter the denominator", async () => {
    const m = await compute([run({ status: "approved", extra: { status: "running" } }), run({ status: "approved", extra: { status: "error" } }), run({ status: "approved" })]);
    expect(m.totals.completedAdaptiveResearch).toBe(1);
    expect(m.totals.projectIntegrityAnomalies).toBe(0);
  });
});

describe("query envelope and legality", () => {
  const projects = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);
  it.each([
    [0, 21],
    [1, 41],
    [30, 70],
  ])("%i canonical Projects → exactly %i count() queries, each legal (≤ 30 disjunctions, no in + not-in)", async (n, expected) => {
    const log: CountSpec[] = [];
    await compute([], projects(n), log);
    expect(log).toHaveLength(expected);
    expect(new Set(log.map((s) => JSON.stringify(s))).size).toBe(expected);
    for (const s of log) {
      const ops = s.filters.map((f) => f.op);
      expect(ops.includes("in") && ops.includes("not-in")).toBe(false);
      expect(s.collection).toBe("runs");
      // The family predicate is on every query.
      expect(s.filters.slice(0, 3)).toEqual([
        { field: "workspaceId", op: "==", value: W },
        { field: "adaptiveOutput.version", op: "==", value: 1 },
        { field: "status", op: "==", value: "complete" },
      ]);
    }
  });

  it("at most 16 count() queries are in flight at once", async () => {
    let active = 0;
    let peak = 0;
    const exec: CountExecutor = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return 0;
    };
    await computeReviewIntegrityMetrics({ workspaceId: W, canonicalProjectIds: projects(30), count: exec, now: NOW });
    expect(peak).toBe(16);
  });

  it("the fake's predicate is the real boundary (spot check against direct matching)", () => {
    const doc = run({ status: "approved", path: ABSENT });
    expect(matches(doc, { collection: "runs", filters: [{ field: F_DECIDED_VIA, op: "not-in", value: [...DECISION_PATHS] }] })).toBe(false);
    expect(matches(doc, { collection: "runs", filters: [{ field: F_DECIDED_VIA, op: "==", value: null }] })).toBe(false);
  });
});

describe("MUTATION E: reconciliation — an irreconcilable result is refused, never returned", () => {
  /** Real counts, with one query's answer replaced. */
  const tamper = (docs: Doc[], pick: (s: CountSpec) => boolean, value: (real: number) => number): CountExecutor => {
    const real = strictExecutor(docs);
    return async (s) => (pick(s) ? value(await real(s)) : real(s));
  };
  const docs = [run({ status: "approved", path: "multi_reviewer_panel" }), run({ status: "pending" }), run({ projectId: "P1", status: "rejected" })];
  const isNullBranch = (s: CountSpec) => s.filters.some((f) => f.field === "projectId" && f.value === null);
  const has = (s: CountSpec, field: string, value?: unknown) => s.filters.some((f) => f.field === field && (value === undefined || f.value === value));
  const cases: Array<[string, (s: CountSpec) => boolean, (n: number) => number]> = [
    ["recognized states exceed the total (missing < 0)", (s) => isNullBranch(s) && has(s, F_HUMAN_STATUS, "pending") && !has(s, F_DECIDED_VIA), (n) => n + 5],
    ["raw total below the contained total (anomalies < 0)", (s) => !has(s, "projectId"), () => 0],
    ["a path cell exceeds its own status count", (s) => isNullBranch(s) && has(s, F_DECIDED_VIA, "multi_reviewer_owner_override") && has(s, F_HUMAN_STATUS, "approved"), (n) => n + 1],
    ["a negative count", (s) => isNullBranch(s) && has(s, F_HUMAN_STATUS, "approved") && !has(s, F_DECIDED_VIA), () => -1],
    ["a non-integer count", (s) => isNullBranch(s) && s.filters.length === 4, () => 1.5],
  ];
  it.each(cases)("%s → ReviewIntegrityInconsistentError", async (_label, pick, value) => {
    await expect(computeReviewIntegrityMetrics({ workspaceId: W, canonicalProjectIds: CANON, count: tamper(docs, pick, value), now: NOW })).rejects.toBeInstanceOf(ReviewIntegrityInconsistentError);
  });
  it("positive control: the untampered counts reconcile", async () => {
    await expect(compute(docs)).resolves.toMatchObject({ totals: { completedAdaptiveResearch: 3, terminalHumanDecisions: 2 } });
  });
});
