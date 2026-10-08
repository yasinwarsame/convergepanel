/**
 * Step 6.3 — Workspace governance summary (contract: docs/governance-workspace-summary-contract.md).
 *
 * Every number is an exact Firestore aggregation `count()` over persisted
 * predicates, expressed here as a DECLARATIVE `CountSpec` and executed through
 * an injected `CountExecutor`. Nothing in this module reads an artifact
 * document, applies a `limit`, paginates, samples, writes, schedules or
 * backfills. The only document read is the Workspace's Project listing, used
 * to build the validated canonical Project set (contract §4) — performed by the
 * caller and passed in.
 *
 * Contract map:
 *   §3 families + partition  → FAMILIES, `research` = all runs − adaptive runs
 *   §4 containment           → `containedCount` (null branch + Project in-batches,
 *                              or per-Project equality branches when the
 *                              predicate carries `not-in`), `integrityAnomalies`
 *   §5 completion            → research `status == "complete"` + excludedNotComplete
 *   §6 automated axis        → System A (disjoint §6.5 arithmetic) / System B
 *   §7 human axis            → System B stored statuses / System A exact derivation
 *   §9 response              → rows + totals + anomalies, all decomposable
 *
 * Pure apart from the injected executor. The real executor is
 * `firestoreCountExecutor` (server-only module `workspaceGovernanceSummaryFirestore.ts`).
 */

export type CountCollection = "runs" | "verifications" | "videoVerifications";
export type CountFilter = { field: string; op: "==" | "in" | "not-in" | ">"; value: unknown };
export type CountSpec = { collection: CountCollection; filters: CountFilter[] };
export type CountExecutor = (spec: CountSpec) => Promise<number>;

export type Family = "research" | "research_adaptive" | "claim_verification" | "video_verification";
export type SourceSystem = "A" | "B";
export type NormalizedOutcome = "cleared" | "needs_attention" | "blocked" | "not_evaluated" | "error" | "not_recorded" | "unmapped";

export const OTHER_RECORDED = "__other_recorded__";

/** Firestore `in` value limit: Project ids are split into disjoint batches of at most this size. */
export const IN_BATCH_SIZE = 30;

export const SYSTEM_A_STATUSES = ["approved", "needs_review", "blocked"] as const;
export const SYSTEM_B_STATUSES = ["passed", "flagged", "blocked", "not_evaluated", "error"] as const;
export const SYSTEM_B_HUMAN_STATUSES = ["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"] as const;

const A_OUTCOME: Record<(typeof SYSTEM_A_STATUSES)[number], NormalizedOutcome> = {
  approved: "cleared",
  needs_review: "needs_attention",
  blocked: "blocked",
};
const B_OUTCOME: Record<(typeof SYSTEM_B_STATUSES)[number], NormalizedOutcome> = {
  passed: "cleared",
  flagged: "needs_attention",
  blocked: "blocked",
  not_evaluated: "not_evaluated",
  error: "error",
};
/** §7 — the exact System A human derivation (the review route stores changes_requested as needs_review). */
const A_HUMAN: Record<(typeof SYSTEM_A_STATUSES)[number], string> = {
  approved: "approved",
  blocked: "blocked",
  needs_review: "changes_requested",
};

const F_GOV_A = "governanceStatus";
const F_GOV_B = "governanceRecord.automatedGovernance.status";
const F_HUMAN_B = "governanceRecord.humanReview.status";
const REVIEWED: CountFilter = { field: "governanceReviewedAt", op: ">", value: "" };
const COMPLETE: CountFilter = { field: "status", op: "==", value: "complete" };
const ADAPTIVE: CountFilter = { field: "adaptiveOutput.version", op: "==", value: 1 };
const HAS_GOV_RECORD: CountFilter = { field: "governanceRecord.version", op: "==", value: 1 };

export type GovernanceSummaryRow = {
  family: Family;
  sourceSystem: SourceSystem;
  axis: "automated" | "human";
  storedField: string;
  storedStatus: string | null;
  normalizedOutcome?: NormalizedOutcome;
  humanDecision?: string;
  subReason?: "superseded_by_human_decision" | "missing";
  count: number;
};

export type GovernanceSummaryTotal = {
  family: Family;
  sourceSystem: SourceSystem;
  total: number;
  automatedDenominator: number;
  excludedNotComplete?: number;
  integrityAnomalies: number;
};

export type GovernanceSummaryAnomaly =
  | { kind: "family_overlap"; family: Family; field: string; count: number }
  | { kind: "reviewed_status_malformed"; family: Family; count: number };

export type WorkspaceGovernanceSummary = {
  workspaceId: string;
  generatedAt: string;
  scope: {
    bindingField: "workspaceId";
    projectContainment: "null_or_canonical_workspace_project";
    shapeValidationApplied: false;
    researchCompletion: "status_complete";
    teamWorkspaceOnly: true;
  };
  totals: GovernanceSummaryTotal[];
  rows: GovernanceSummaryRow[];
  anomalies: GovernanceSummaryAnomaly[];
};

export class GovernanceSummaryInconsistentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceSummaryInconsistentError";
  }
}

// ── containment (§4) ───────────────────────────────────────────────────────

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Exact count of records matching `filters` whose projectId is explicitly null
 * or a canonical Project. A predicate carrying `not-in` cannot also carry an
 * `in` (Firestore prohibits the combination), so it is decomposed into
 * per-Project equality branches; otherwise Projects are batched with `in`.
 * All branches are disjoint, so their counts sum exactly.
 */
export function containmentSpecs(collection: CountCollection, filters: CountFilter[], canonicalProjectIds: readonly string[]): CountSpec[] {
  const specs: CountSpec[] = [{ collection, filters: [...filters, { field: "projectId", op: "==", value: null }] }];
  if (filters.some((f) => f.op === "not-in")) {
    for (const id of canonicalProjectIds) specs.push({ collection, filters: [...filters, { field: "projectId", op: "==", value: id }] });
  } else {
    for (const batch of chunk(canonicalProjectIds, IN_BATCH_SIZE)) specs.push({ collection, filters: [...filters, { field: "projectId", op: "in", value: batch }] });
  }
  return specs;
}

/** At most this many count() queries in flight at once (latency without flooding Firestore). */
export const MAX_CONCURRENT_COUNTS = 16;

/** Bounded concurrency: queues specs so no more than `limit` executor calls run at once. */
export function limitConcurrency(exec: CountExecutor, limit: number): CountExecutor {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return (spec) =>
    new Promise<number>((resolve, reject) => {
      const start = () => {
        active += 1;
        exec(spec).then(resolve, reject).finally(release);
      };
      if (active < limit) start();
      else queue.push(start);
    });
}

/** Memoizes identical specs (the research partition reuses adaptive terms). */
function memoized(exec: CountExecutor): CountExecutor {
  const cache = new Map<string, Promise<number>>();
  return (spec) => {
    const key = JSON.stringify(spec);
    let hit = cache.get(key);
    if (!hit) {
      hit = exec(spec);
      cache.set(key, hit);
    }
    return hit;
  };
}

type Counter = {
  /** Exact contained count for the family, under extra predicates. */
  contained(extra: CountFilter[]): Promise<number>;
  /** Exact raw (uncontained) count for the family — integrity-anomaly arithmetic only. */
  raw(extra: CountFilter[]): Promise<number>;
};

function baseCounter(exec: CountExecutor, collection: CountCollection, base: CountFilter[], projectIds: readonly string[]): Counter {
  const sum = async (specs: CountSpec[]) => (await Promise.all(specs.map(exec))).reduce((a, b) => a + b, 0);
  return {
    contained: (extra) => sum(containmentSpecs(collection, [...base, ...extra], projectIds)),
    raw: (extra) => exec({ collection, filters: [...base, ...extra] }),
  };
}

/** §3 partition: `research` = all Workspace runs − adaptive runs, predicate by predicate. */
function differenceCounter(all: Counter, minus: Counter): Counter {
  return {
    contained: async (extra) => {
      const [a, m] = await Promise.all([all.contained(extra), minus.contained(extra)]);
      return a - m;
    },
    raw: async (extra) => {
      const [a, m] = await Promise.all([all.raw(extra), minus.raw(extra)]);
      return a - m;
    },
  };
}

// ── per-system arithmetic ──────────────────────────────────────────────────

function nonNegative(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new GovernanceSummaryInconsistentError(`${label} = ${value}`);
  return value;
}

type FamilyResult = { total: GovernanceSummaryTotal; rows: GovernanceSummaryRow[]; anomalies: GovernanceSummaryAnomaly[] };

async function completionAndIntegrity(family: Family, counter: Counter, completion: CountFilter[]) {
  const [containedAll, rawAll, completed] = await Promise.all([counter.contained([]), counter.raw([]), completion.length ? counter.contained(completion) : Promise.resolve(null)]);
  const total = completed ?? containedAll;
  return {
    total: nonNegative(`${family}.total`, total),
    integrityAnomalies: nonNegative(`${family}.integrityAnomalies`, rawAll - containedAll),
    excludedNotComplete: completion.length ? nonNegative(`${family}.excludedNotComplete`, containedAll - total) : undefined,
  };
}

/** §6.5 — System A disjoint arithmetic + §7 System A human derivation. */
async function systemA(family: Family, counter: Counter, completion: CountFilter[]): Promise<FamilyResult> {
  const R = [...SYSTEM_A_STATUSES];
  const c = (extra: CountFilter[]) => counter.contained([...completion, ...extra]);

  const [head, rawList, reviewedList, allOtherRecorded, reviewedOther, reviewedTotal] = await Promise.all([
    completionAndIntegrity(family, counter, completion),
    Promise.all(R.map((x) => c([{ field: F_GOV_A, op: "==", value: x }]))),
    Promise.all(R.map((x) => c([{ field: F_GOV_A, op: "==", value: x }, REVIEWED]))),
    c([{ field: F_GOV_A, op: "not-in", value: R }]),
    c([{ field: F_GOV_A, op: "not-in", value: R }, REVIEWED]),
    c([REVIEWED]),
  ]);
  const rawRecognized: Record<string, number> = Object.fromEntries(R.map((x, i) => [x, rawList[i]]));
  const reviewedRecognized: Record<string, number> = Object.fromEntries(R.map((x, i) => [x, reviewedList[i]]));

  const sumReviewedRecognized = R.reduce((a, x) => a + reviewedRecognized[x], 0);
  const sumRawRecognized = R.reduce((a, x) => a + rawRecognized[x], 0);
  const reviewedMalformed = nonNegative(`${family}.reviewedMalformed`, reviewedTotal - sumReviewedRecognized);
  const reviewedMissing = nonNegative(`${family}.reviewedMissing`, reviewedMalformed - reviewedOther);
  const allMissing = nonNegative(`${family}.allMissing`, head.total - sumRawRecognized - allOtherRecorded);
  const automatedOtherRecorded = nonNegative(`${family}.automatedOtherRecorded`, allOtherRecorded - reviewedOther);
  const automatedMissing = nonNegative(`${family}.automatedMissing`, allMissing - reviewedMissing);
  const superseded = sumReviewedRecognized;

  const rows: GovernanceSummaryRow[] = [];
  for (const x of R) {
    rows.push({
      family,
      sourceSystem: "A",
      axis: "automated",
      storedField: F_GOV_A,
      storedStatus: x,
      normalizedOutcome: A_OUTCOME[x],
      count: nonNegative(`${family}.automated.${x}`, rawRecognized[x] - reviewedRecognized[x]),
    });
  }
  rows.push({ family, sourceSystem: "A", axis: "automated", storedField: F_GOV_A, storedStatus: null, normalizedOutcome: "not_recorded", subReason: "superseded_by_human_decision", count: superseded });
  rows.push({ family, sourceSystem: "A", axis: "automated", storedField: F_GOV_A, storedStatus: OTHER_RECORDED, normalizedOutcome: "unmapped", count: automatedOtherRecorded });
  rows.push({ family, sourceSystem: "A", axis: "automated", storedField: F_GOV_A, storedStatus: null, normalizedOutcome: "not_recorded", subReason: "missing", count: automatedMissing });
  for (const x of R) {
    rows.push({ family, sourceSystem: "A", axis: "human", storedField: F_GOV_A, storedStatus: x, humanDecision: A_HUMAN[x], count: reviewedRecognized[x] });
  }

  return {
    total: {
      family,
      sourceSystem: "A",
      total: head.total,
      automatedDenominator: head.total - reviewedMalformed,
      ...(head.excludedNotComplete !== undefined ? { excludedNotComplete: head.excludedNotComplete } : {}),
      integrityAnomalies: head.integrityAnomalies,
    },
    rows,
    anomalies: reviewedMalformed > 0 ? [{ kind: "reviewed_status_malformed", family, count: reviewedMalformed }] : [],
  };
}

/** §6.2/§6.4 System B automated axis + §7 System B human axis. */
async function systemB(family: Family, counter: Counter, completion: CountFilter[]): Promise<FamilyResult> {
  const c = (extra: CountFilter[]) => counter.contained([...completion, ...extra]);
  const rows: GovernanceSummaryRow[] = [];

  type AxisCounts = { recognized: number[]; other: number };
  const countAxis = async (field: string, vocabulary: readonly string[]): Promise<AxisCounts> => {
    const [recognized, other] = await Promise.all([Promise.all(vocabulary.map((x) => c([{ field, op: "==", value: x }]))), c([{ field, op: "not-in", value: [...vocabulary] }])]);
    return { recognized, other };
  };
  const [head, autoCounts, humanCounts] = await Promise.all([
    completionAndIntegrity(family, counter, completion),
    countAxis(F_GOV_B, SYSTEM_B_STATUSES),
    countAxis(F_HUMAN_B, SYSTEM_B_HUMAN_STATUSES),
  ]);

  const axis = (field: string, vocabulary: readonly string[], kind: "automated" | "human", counts: AxisCounts) => {
    let recognized = 0;
    for (const [i, x] of vocabulary.entries()) {
      const n = counts.recognized[i];
      recognized += n;
      rows.push(
        kind === "automated"
          ? { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: x, normalizedOutcome: B_OUTCOME[x as keyof typeof B_OUTCOME], count: n }
          : { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: x, humanDecision: x, count: n }
      );
    }
    const other = counts.other;
    const missing = nonNegative(`${family}.${kind}.missing`, head.total - recognized - other);
    rows.push(kind === "automated" ? { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: OTHER_RECORDED, normalizedOutcome: "unmapped", count: other } : { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: OTHER_RECORDED, humanDecision: OTHER_RECORDED, count: other });
    rows.push(kind === "automated" ? { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: null, normalizedOutcome: "not_recorded", subReason: "missing", count: missing } : { family, sourceSystem: "B", axis: kind, storedField: field, storedStatus: null, subReason: "missing", count: missing });
  };
  axis(F_GOV_B, SYSTEM_B_STATUSES, "automated", autoCounts);
  axis(F_HUMAN_B, SYSTEM_B_HUMAN_STATUSES, "human", humanCounts);

  return {
    total: {
      family,
      sourceSystem: "B",
      total: head.total,
      automatedDenominator: head.total,
      ...(head.excludedNotComplete !== undefined ? { excludedNotComplete: head.excludedNotComplete } : {}),
      integrityAnomalies: head.integrityAnomalies,
    },
    rows,
    anomalies: [],
  };
}

/** §3 overlap anomalies — counted, disclosed, never assigned to either family. */
async function overlapAnomalies(allRuns: Counter, adaptive: Counter): Promise<GovernanceSummaryAnomaly[]> {
  const complete = [COMPLETE];
  // Adaptive runs carrying any non-null System A governanceStatus.
  const [aOther, aRecognized, allWithRecord, adaptiveWithRecord] = await Promise.all([
    adaptive.contained([...complete, { field: F_GOV_A, op: "not-in", value: [...SYSTEM_A_STATUSES] }]),
    Promise.all(SYSTEM_A_STATUSES.map((x) => adaptive.contained([...complete, { field: F_GOV_A, op: "==", value: x }]))),
    // Non-adaptive runs carrying a governanceRecord.
    allRuns.contained([...complete, HAS_GOV_RECORD]),
    adaptive.contained([...complete, HAS_GOV_RECORD]),
  ]);
  const adaptiveWithA = aOther + aRecognized.reduce((a, b) => a + b, 0);
  const researchWithB = allWithRecord - adaptiveWithRecord;
  const out: GovernanceSummaryAnomaly[] = [];
  if (adaptiveWithA > 0) out.push({ kind: "family_overlap", family: "research_adaptive", field: F_GOV_A, count: adaptiveWithA });
  if (nonNegative("research.overlap", researchWithB) > 0) out.push({ kind: "family_overlap", family: "research", field: "governanceRecord", count: researchWithB });
  return out;
}

export type ComputeWorkspaceGovernanceSummaryArgs = {
  workspaceId: string;
  /** The VALIDATED canonical Project set (contract §4) — see `canonicalProjectIdsFromListing`. */
  canonicalProjectIds: readonly string[];
  count: CountExecutor;
  now?: () => Date;
};

export async function computeWorkspaceGovernanceSummary(args: ComputeWorkspaceGovernanceSummaryArgs): Promise<WorkspaceGovernanceSummary> {
  const exec = memoized(limitConcurrency(args.count, MAX_CONCURRENT_COUNTS));
  const ws: CountFilter = { field: "workspaceId", op: "==", value: args.workspaceId };
  const projects = [...args.canonicalProjectIds];

  const allRuns = baseCounter(exec, "runs", [ws], projects);
  const adaptive = baseCounter(exec, "runs", [ws, ADAPTIVE], projects);
  const research = differenceCounter(allRuns, adaptive);
  const claims = baseCounter(exec, "verifications", [ws, { field: "type", op: "==", value: "claim_verification" }], projects);
  const videos = baseCounter(exec, "videoVerifications", [ws, { field: "type", op: "==", value: "video_verification" }], projects);

  const [results, overlaps] = await Promise.all([
    Promise.all([systemA("research", research, [COMPLETE]), systemB("research_adaptive", adaptive, [COMPLETE]), systemA("claim_verification", claims, []), systemA("video_verification", videos, [])]),
    overlapAnomalies(allRuns, adaptive),
  ]);

  return {
    workspaceId: args.workspaceId,
    generatedAt: (args.now ?? (() => new Date()))().toISOString(),
    scope: {
      bindingField: "workspaceId",
      projectContainment: "null_or_canonical_workspace_project",
      shapeValidationApplied: false,
      researchCompletion: "status_complete",
      teamWorkspaceOnly: true,
    },
    totals: results.map((r) => r.total),
    rows: results.flatMap((r) => r.rows),
    anomalies: [...results.flatMap((r) => r.anomalies), ...overlaps],
  };
}

/**
 * Contract §4 point 1 — the canonical Project set: only Project documents that
 * satisfy the `getProject()` invariants (well-formed, embedded id equals the
 * document id, workspaceId equals the addressed Workspace). Active and archived
 * are both valid. `isWellFormed` is injected (the real one is
 * `isWellFormedProjectV1`) so this stays pure.
 */
export function canonicalProjectIdsFromListing(
  workspaceId: string,
  docs: ReadonlyArray<{ id: string; data: unknown }>,
  isWellFormed: (data: unknown) => boolean
): string[] {
  return docs
    .filter((d) => {
      if (!isWellFormed(d.data)) return false;
      const data = d.data as { id?: unknown; workspaceId?: unknown };
      return data.id === d.id && data.workspaceId === workspaceId;
    })
    .map((d) => d.id)
    .sort();
}
