/**
 * Step 6.3 test support:
 *  - `fakeCountExecutor`: evaluates a declarative CountSpec over in-memory
 *    documents with Firestore's DOCUMENTED operator semantics — the predicate
 *    IS the boundary under test, so it must not be looser or stricter than
 *    Firestore:
 *      `==`      field present and strictly equal (`== null` matches an
 *                explicit null only, never a missing field);
 *      `in`      field present and strictly equal to a listed value;
 *      `not-in`  field present, NOT null, and not equal to any listed value
 *                (a `null` inside the list makes the query match nothing);
 *      `>`       same-type ordering — `> ""` matches non-empty strings only.
 *    It also records every spec it executes and REJECTS `in` + `not-in` in one
 *    query, exactly as Firestore does.
 *  - `oracleSummary`: classifies every document DIRECTLY from the contract's
 *    definitions (no subtraction, no residuals) — the independent answer the
 *    computed summary must equal.
 */
import type { CountExecutor, CountSpec, Family } from "@/lib/governance/workspaceGovernanceSummary";
import { SYSTEM_A_STATUSES, SYSTEM_B_HUMAN_STATUSES, SYSTEM_B_STATUSES } from "@/lib/governance/workspaceGovernanceSummary";

export type Doc = Record<string, unknown>;
export type Dataset = { runs: Doc[]; verifications: Doc[]; videoVerifications: Doc[] };

const MISSING = Symbol("missing");
function read(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return MISSING;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function matches(doc: Doc, spec: CountSpec): boolean {
  return spec.filters.every((f) => {
    const v = read(doc, f.field);
    switch (f.op) {
      case "==":
        return v !== MISSING && v === f.value;
      case "in":
        return v !== MISSING && (f.value as unknown[]).includes(v);
      case "not-in": {
        const list = f.value as unknown[];
        if (list.includes(null)) return false;
        return v !== MISSING && v !== null && !list.includes(v);
      }
      case ">":
        return typeof f.value === "string" ? typeof v === "string" && v > f.value : typeof v === typeof f.value && (v as number) > (f.value as number);
      default:
        throw new Error(`unsupported op ${String((f as { op: string }).op)}`);
    }
  });
}

export function fakeCountExecutor(data: Dataset, log: CountSpec[] = []): CountExecutor {
  return async (spec) => {
    const ops = spec.filters.map((f) => f.op);
    if (ops.includes("in") && ops.includes("not-in")) throw new Error("FAILED_PRECONDITION: 'in' and 'not-in' cannot be combined");
    log.push(spec);
    return data[spec.collection].filter((d) => matches(d, spec)).length;
  };
}

// ── oracle ───────────────────────────────────────────────────────────────

type Tally = Record<string, number>;
const inc = (t: Tally, k: string) => (t[k] = (t[k] ?? 0) + 1);

export type OracleFamily = {
  total: number;
  excludedNotComplete?: number;
  integrityAnomalies: number;
  automated: Tally; // key: storedStatus | "__other__" | "__missing__" | "__superseded__"
  human: Tally;
  reviewedMalformed: number;
};

const isContained = (d: Doc, canonical: Set<string>) =>
  Object.prototype.hasOwnProperty.call(d, "projectId") && (d.projectId === null || (typeof d.projectId === "string" && canonical.has(d.projectId)));
const nonNull = (v: unknown) => v !== MISSING && v !== null;

export function oracleSummary(data: Dataset, workspaceId: string, canonicalProjectIds: string[]) {
  const canonical = new Set(canonicalProjectIds);
  const out: Record<Family, OracleFamily> = {} as never;
  const anomalies = { adaptiveWithA: 0, researchWithB: 0 };

  const familyDocs: Record<Family, Doc[]> = {
    research_adaptive: data.runs.filter((d) => d.workspaceId === workspaceId && read(d, "adaptiveOutput.version") === 1),
    research: data.runs.filter((d) => d.workspaceId === workspaceId && read(d, "adaptiveOutput.version") !== 1),
    claim_verification: data.verifications.filter((d) => d.workspaceId === workspaceId && d.type === "claim_verification"),
    video_verification: data.videoVerifications.filter((d) => d.workspaceId === workspaceId && d.type === "video_verification"),
  };

  for (const family of Object.keys(familyDocs) as Family[]) {
    const docs = familyDocs[family];
    const research = family === "research" || family === "research_adaptive";
    const contained = docs.filter((d) => isContained(d, canonical));
    const counted = research ? contained.filter((d) => d.status === "complete") : contained;
    const f: OracleFamily = {
      total: counted.length,
      ...(research ? { excludedNotComplete: contained.length - counted.length } : {}),
      integrityAnomalies: docs.length - contained.length,
      automated: {},
      human: {},
      reviewedMalformed: 0,
    };
    for (const d of counted) {
      if (family === "research_adaptive") {
        const a = read(d, "governanceRecord.automatedGovernance.status");
        inc(f.automated, (SYSTEM_B_STATUSES as readonly unknown[]).includes(a) ? String(a) : nonNull(a) ? "__other__" : "__missing__");
        const h = read(d, "governanceRecord.humanReview.status");
        inc(f.human, (SYSTEM_B_HUMAN_STATUSES as readonly unknown[]).includes(h) ? String(h) : nonNull(h) ? "__other__" : "__missing__");
        if (nonNull(read(d, "governanceStatus"))) anomalies.adaptiveWithA += 1;
      } else {
        const st = read(d, "governanceStatus");
        const reviewedAt = read(d, "governanceReviewedAt");
        const reviewed = typeof reviewedAt === "string" && reviewedAt > "";
        const recognized = (SYSTEM_A_STATUSES as readonly unknown[]).includes(st);
        if (reviewed && recognized) {
          inc(f.automated, "__superseded__");
          inc(f.human, String(st));
        } else if (reviewed) f.reviewedMalformed += 1;
        else if (recognized) inc(f.automated, String(st));
        else if (nonNull(st)) inc(f.automated, "__other__");
        else inc(f.automated, "__missing__");
        if (family === "research" && read(d, "governanceRecord.version") === 1) anomalies.researchWithB += 1;
      }
    }
    out[family] = f;
  }
  return { families: out, anomalies };
}
