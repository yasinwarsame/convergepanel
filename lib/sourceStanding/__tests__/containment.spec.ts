/**
 * Order 4 Slice 2a.1 — Source Standing cannot influence governance, consensus,
 * evidence quality / sourceBacked, exports or Personal workflows.
 *
 * Two kinds of evidence, as neither alone is enough:
 *   1. STATIC, transitive: walking the real import graph from each consumer's
 *      entry points never reaches `lib/sourceStanding/` (with a positive
 *      control proving the walker does reach it from Review Context).
 *   2. DYNAMIC: the nearest real integration functions produce identical output
 *      with the flag ON and standing recorded for every cited URL (ACCEPTED or
 *      DISPUTED) as with the flag OFF and no standing — and they never read
 *      the Source Standing store (access trap on the fake Firestore).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { Timestamp } from "firebase-admin/firestore";
import { FakeDb } from "./fakeStandingFirestore";

let mockFlag = false;
jest.mock("@/lib/env", () => ({
  ...jest.requireActual("@/lib/env"),
  get SOURCE_AUTHORITY_METADATA_ENABLED() {
    return mockFlag;
  },
}));
let mockDb: FakeDb;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockDb;
  },
}));
jest.mock("server-only", () => ({}));

import { sourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";
import { evaluateAdaptiveGovernance } from "@/lib/governance/evaluateAdaptiveGovernance";
import { getDefaultGovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { buildAdaptiveDecisionReceipt } from "@/lib/adaptiveSchema/decisionReceiptBuilder";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { computeConsensusScoring } from "@/lib/verification/consensusScoring";

const root = join(__dirname, "..", "..", "..");

// ───────────────────────────── 1. static, transitive ─────────────────────────────

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null; // package import
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Every repo file transitively imported (static, dynamic `import()`, `require`, re-exports) from `entries`. */
function transitiveImports(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = entries.map((e) => join(root, e));
  while (stack.length) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const r = resolveImport(f, m[1]);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}
const reachesStanding = (files: Set<string>) => [...files].map((f) => relative(root, f)).filter((f) => f.startsWith("lib/sourceStanding/"));

function routeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name === "__tests__") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(route|page)\.tsx?$/.test(name)) out.push(relative(root, p));
    }
  };
  if (existsSync(join(root, dir))) walk(join(root, dir));
  return out;
}

describe("static containment — transitive import graph", () => {
  it("positive control: the walker DOES reach lib/sourceStanding from the Team Review Context route", () => {
    const files = transitiveImports(["app/api/workspaces/[workspaceId]/runs/[runId]/review-context/route.ts"]);
    expect(reachesStanding(files)).toEqual(expect.arrayContaining(["lib/sourceStanding/reviewContextStanding.ts", "lib/sourceStanding/standingFirestore.ts"]));
  });

  const GROUPS: Record<string, string[]> = {
    "governance evaluation / routing / thresholds": [
      "lib/governance/evaluateAdaptiveGovernance.ts",
      "lib/governance/evaluateGovernance.ts",
      "lib/governance/evaluateAndStore.ts",
      "lib/governance/researchConsensusSummary.ts",
      "lib/governance/governanceInputFromDocs.ts",
    ],
    "consensus scoring": ["lib/verification/consensusScoring.ts"],
    "Decision Receipt / sourceBacked / evidence quality": ["lib/adaptiveSchema/decisionReceiptBuilder.ts", "lib/adaptiveSchema/governanceRecord.ts"],
    "exports (snapshot, JSON/PDF/DOCX renderers, every export route)": [
      "lib/adaptiveSchema/exportSnapshot.ts",
      "lib/adaptiveSchema/researchExport.ts",
      "lib/adaptiveSchema/exportContentDerivation.ts",
      "lib/pdf/renderAdaptiveResearchPdf.ts",
      "lib/docx/renderAdaptiveResearchDocx.ts",
      "app/api/user/runs/[runId]/export/route.ts",
      "app/api/user/runs/[runId]/exports/route.ts",
      "app/api/user/runs/[runId]/exports/[exportId]/route.ts",
      "app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts",
      "app/api/workspaces/[workspaceId]/runs/[runId]/exports/route.ts",
      "app/api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]/route.ts",
      "app/api/teams/audit-export/route.ts",
    ],
    "panel / verification / synthesis pipelines": ["app/api/run-panel/route.ts", "app/api/verify-claim/route.ts", "app/api/verify-video/route.ts", "app/api/synthesize-panel/route.ts"],
    "Personal API routes (every app/api/user/** route)": routeFilesUnder("app/api/user"),
  };

  it.each(Object.entries(GROUPS))("%s never (transitively) imports lib/sourceStanding", (_g, entries) => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect({ e, exists: existsSync(join(root, e)) }).toEqual({ e, exists: true });
    expect(reachesStanding(transitiveImports(entries))).toEqual([]);
  });

  it("the only Source Authority management route is the Team Workspace one (no Personal / global variant)", () => {
    const all = [...routeFilesUnder("app/api"), ...routeFilesUnder("app")].filter((f) => /source-authority|sourceAuthority|source-standing/i.test(f));
    expect([...new Set(all)]).toEqual(["app/api/workspaces/[workspaceId]/source-authority/route.ts"]);
  });

  it("no Personal page/route file imports lib/sourceStanding (Personal workspace + user surfaces)", () => {
    // Personal research/project pages live under app/workspace/{research,projects} (Team ones under app/workspace/team).
    const personal = [...routeFilesUnder("app/workspace/research"), ...routeFilesUnder("app/workspace/projects"), "app/workspace/page.tsx", ...routeFilesUnder("app/api/user")];
    expect(personal.length).toBeGreaterThan(0);
    expect(reachesStanding(transitiveImports(personal))).toEqual([]);
  });
});

// ───────────────────────────── 2. dynamic equality ─────────────────────────────

const CITED = ["https://www.sec.gov/cgi-bin/browse-edgar", "https://en.wikipedia.org/wiki/Inflation", "https://www.reuters.com/world/x", "NIST glossary"];
const NOW = "2026-10-01T00:00:00.000Z";

function seedStanding(workspaceId: string, status: "ACCEPTED" | "DISPUTED") {
  for (const raw of CITED) {
    const identity = sourceIdentityV1(raw);
    if (!identity) continue;
    mockDb.put(`workspaces/${workspaceId}/sourceAuthority/${identity.idHash}`, {
      schemaVersion: 1,
      workspaceId,
      identity,
      status,
      reasonCode: status === "ACCEPTED" ? "primary_document" : "inaccurate_or_unreliable_for_workspace",
      revision: 1,
      updatedAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1)),
      updatedByUid: "admin-1",
    });
  }
}

function adaptiveOutput(): any {
  return {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    classification: { queryType: "comparison_matrix", domain: "test", answerShape: "comparison_grid", quantExpected: false, timeSensitivity: "low", userIntent: "get_answer", confidence: 0.9, riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, rationale: "t" },
    meta: { schemaVersion: 1, queryType: "comparison_matrix", answerShape: "comparison_grid", dataBasis: "mixed", freshness: "timeless", riskLevel: "professional", evidenceQuality: "moderate", uncertainties: [], blindSpots: [], humanReviewNeeded: false, generatedAt: NOW, sourceBacked: true },
    generatedAt: NOW,
    result: { subjects: [], attributes: [], cells: [{ subject: "A", attribute: "x", value: "v", sources: CITED }], totalModels: 2, lowConfidenceSubjects: [], lowConfidenceAttributes: [], hasVerifiedSourceData: false },
  };
}
function governanceRecord(): any {
  return {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: { conclusion: "The panel recommends option A.", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: CITED, sourceBacked: true, humanReviewNeeded: false },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Every decision-semantic output that must be independent of Source Standing. */
function computeAll() {
  return JSON.stringify({
    governance: evaluateAdaptiveGovernance({ governanceRecord: governanceRecord(), policy: { ...getDefaultGovernancePolicy(), blockIfSourceBackedMissingSources: true }, modelFailureCount: 0, successfulModelCount: 2, evaluatedAt: NOW }),
    receipt: buildAdaptiveDecisionReceipt(adaptiveOutput()),
    consensus: computeConsensusScoring({
      mode: "verification",
      modelRows: [
        { status: "ok", verdict: "accurate", confidence: "high" },
        { status: "ok", verdict: "inaccurate", confidence: "medium" },
      ],
      aggregateVerdict: "disputed",
    }),
    exportSnapshot: buildExportSnapshot({ question: "q", selectedModels: ["chatgpt", "claude"] as any, runDocument: {}, milestone2: { output: adaptiveOutput(), governanceRecord: governanceRecord(), reviewRouting: "in_queue" } } as any),
  });
}

describe("dynamic equality — standing never changes decision semantics or exports", () => {
  beforeEach(() => {
    mockDb = new FakeDb();
    mockFlag = false;
  });

  it("flag OFF + no standing  ==  flag ON + every cited URL ACCEPTED  ==  flag ON + every cited URL DISPUTED, with zero Source Standing reads", () => {
    const baseline = computeAll();
    mockFlag = true;
    seedStanding("ws-1", "ACCEPTED");
    mockDb.reads = [];
    const accepted = computeAll();
    mockDb = new FakeDb();
    seedStanding("ws-1", "DISPUTED");
    mockDb.reads = [];
    const disputed = computeAll();
    expect(accepted).toBe(baseline);
    expect(disputed).toBe(baseline);
    expect(mockDb.reads).toEqual([]); // access trap: none of these paths touched the store
  });

  it("non-vacuity: the fixture really exercises source-sensitive semantics (sourceBacked, sources, governance outcome, consensus label)", () => {
    const all = JSON.parse(computeAll());
    expect(all.governance.status).toBeDefined();
    expect(all.exportSnapshot.reportSnapshot.milestone2.decisionReceipt.sourceBacked).toBe(true);
    expect(all.exportSnapshot.reportSnapshot.milestone2.decisionReceipt.sources).toEqual(CITED);
    expect(all.receipt.sources).toEqual(CITED);
    expect(all.consensus.confidenceLabel).toMatch(/High|Medium|Low/);
    expect(JSON.stringify(all)).not.toMatch(/"standing"|SourceStanding|sourceAuthority/);
  });
});
