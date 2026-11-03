/**
 * Order B, Stage B1 — source-level pins for the two properties the owner made mandatory:
 *
 *   1. Archive immutability in ACTUAL write paths: archived cycles and report-review events are referenced only by the
 *      B1 writer module, and only through `tx.create(` (write-once). No update/set/delete on them anywhere.
 *      (Clients cannot reach them: firestore.rules has no `runs` match, so every client read and write is denied.)
 *   2. The dual-record invariant cannot drift: `reportReview` is written only by the B1 writer, and a governance
 *      record is created at exactly the two known sites (the run's own execution, and a brand-new snapshot run).
 *      If someone adds a third governance writer, this fails and the D-B7 proof must be redone.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
function scriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...scriptFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}
const FILES = [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "scripts"))];
const rel = (p: string) => relative(ROOT, p);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const WRITER = "lib/workspaces/reportReviewMutations.ts";

describe("1. archive and event history is write-once in every write path", () => {
  // B2 adds the decision writer and the assignment-audit writer (both create-only), a constants module, and a
  // read-only context reader. Each role is pinned.
  const COLLECTION_USERS = {
    constants: ["lib/workspaces/reportReviewCollections.ts"],
    writers: ["lib/workspaces/reportReviewAssignmentAudit.ts", "lib/workspaces/reportReviewDecisionMutation.ts", WRITER],
    // B3 adds the record export (read-only: it reads the cycle archives to build the decision history).
    readers: ["lib/workspaces/reportReviewContext.ts", "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route.ts"],
  };

  it("only the pinned modules reference the archive and event collections", () => {
    const users = FILES.filter((f) => /reportReviewCycles|reportReviewEvents|REPORT_REVIEW_CYCLES_COLLECTION|REPORT_REVIEW_EVENTS_COLLECTION/.test(stripComments(readFileSync(f, "utf8")))).map(rel).sort();
    expect(users).toEqual([...COLLECTION_USERS.constants, ...COLLECTION_USERS.readers, ...COLLECTION_USERS.writers].sort());
  });

  it.each(["lib/workspaces/reportReviewAssignmentAudit.ts", "lib/workspaces/reportReviewDecisionMutation.ts", WRITER])("%s writes archives/events only with tx.create (never set/update/delete)", (file) => {
    const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
    const lines = code.split("\n");
    const uses = lines.map((l, i) => [l, i] as const).filter(([l]) => /REPORT_REVIEW_(CYCLES|EVENTS)_COLLECTION\)/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const [, i] of uses) expect(lines.slice(Math.max(0, i - 1), i + 1).join("\n")).toMatch(/tx\.create\(/);
    expect(code).not.toMatch(/REPORT_REVIEW_(CYCLES|EVENTS)_COLLECTION[\s\S]{0,120}\.(update|delete|set)\(/);
  });

  it("the context reader never writes", () => {
    const code = stripComments(readFileSync(join(ROOT, "lib/workspaces/reportReviewContext.ts"), "utf8"));
    expect(code).not.toMatch(/\.(set|update|create|delete)\(|runTransaction/);
  });

  it("no client Firestore rule exposes runs or their subcollections", () => {
    const rules = readFileSync(join(ROOT, "firestore.rules"), "utf8");
    expect(rules).not.toMatch(/match\s+\/runs\//);
  });
});

describe("2. the dual-record invariant's assumptions are pinned", () => {
  it("reportReview is written only by the B1 writer", () => {
    // A Firestore write whose payload names reportReview: tx.update/set/create(ref, {…reportReview…}) or ref.update/set({…}).
    const WRITE = /\.(update|set|create)\(\s*(?:[\w.!]+(?:\([^)]*\))*\s*,\s*)?\{[^}]*?["']?\breportReview\b/;
    const DOTTED = /["']reportReview\.[\w.]+["']\s*:/;
    const writers = FILES.filter((f) => {
      const code = stripComments(readFileSync(f, "utf8"));
      return WRITE.test(code) || DOTTED.test(code);
    }).map(rel);
    // B2: the decision writer updates reportReview.humanReview (dotted payload key).
    expect(writers.sort()).toEqual(["lib/workspaces/reportReviewDecisionMutation.ts", WRITER].sort());
    // Positive control: the pattern does match the writer's real write.
    expect(WRITE.test("tx.update(pre.runRef, { reportReview: record });")).toBe(true);
    expect(WRITE.test("NextResponse.json({ ok: true, reportReview: result.record })")).toBe(false);
  });

  it("a governance record is built at exactly two call sites: the run's own initialization and a new snapshot run", () => {
    const sites = FILES.flatMap((f) => {
      const code = stripComments(readFileSync(f, "utf8"));
      return /buildAdaptiveGovernanceRecord\(\{/.test(code) ? [rel(f)] : [];
    }).sort();
    expect(sites).toEqual(["lib/adaptiveSchema/governanceInitialization.ts", "lib/firestore/teamRunSnapshots.ts"]);
    const init = FILES.filter((f) => /initializeAdaptiveGovernanceRecord\(\{/.test(stripComments(readFileSync(f, "utf8")))).map(rel);
    expect(init).toEqual(["lib/runPanelExecution.ts"]);
    const persist = FILES.filter((f) => /persistGovernanceRecord\(/.test(stripComments(readFileSync(f, "utf8")))).map(rel).sort();
    expect(persist).toEqual(["lib/adaptiveSchema/governanceInitialization.ts", "lib/firestore/runs.ts"]);
  });

  it("EVERY write that can put a governanceRecord on a run is in this reviewed allow-list (review B1-m1)", () => {
    // Whole-record writes (set/update/create payloads naming governanceRecord), dotted-path updates used as payload
    // keys ("governanceRecord.x": …, which Firestore would create on a run without a record), assignments into a
    // write payload (x.governanceRecord = …), and seed plans ({ mode: "set", data: { …governanceRecord… } }).
    const PATTERNS = [
      /\.(set|update|create)\(\s*(?:[\w.!]+(?:\([^)]*\))*\s*,\s*)?\{[^}]*\bgovernanceRecord\b/,
      /["']governanceRecord\.[\w.]+["']\s*:/,
      /\.governanceRecord\s*=[^=]/,
      /mode:\s*"set"[\s\S]{0,600}\bgovernanceRecord\b/,
    ];
    const writers = FILES.filter((f) => {
      const code = stripComments(readFileSync(f, "utf8"));
      return PATTERNS.some((p) => p.test(code));
    })
      .map(rel)
      .sort();
    // Why each is safe for the dual-record invariant (docs/workspaces/approval-b1-dual-record-proof.md §1):
    expect(writers).toEqual([
      "lib/firestore/runs.ts", // persistGovernanceRecord (G1) + dotted humanReview updates behind parseGovernanceRecord of an EXISTING record + persistAutomatedGovernanceUpdate (dotted, called only by runPanelExecution AFTER G1 in the same execution)
      "lib/firestore/teamRunSnapshots.ts", // G2: a brand-new run id, in one tx.create with its copied adaptiveOutput
      "lib/governance/adaptiveGovernanceSeedPlan.ts", // test-seeding plan: legacy-Team run docs (teamId, no workspaceId) that can never pass the report-review workspace binding
      "lib/workspaces/resubmitWorkspaceReview.ts", // dotted humanReview update behind parseGovernanceRecord of an EXISTING record
      "lib/workspaces/workspaceReviewMutations.ts", // same
      "lib/workspaces/workspaceReviewPanelMutations.ts", // same
    ]);
  });

  it("TRIPWIRE (final B1 review MINOR): EVERY occurrence of governanceRecord in every source file is counted and pinned per file", () => {
    // Deliberately maximal: every textual occurrence (reads, types, keys, string paths, FieldPath arguments, variadic
    // update arguments, constants for computed keys) in lib/, app/, components/, hooks/, scripts/ and the repository
    // root, for .ts/.tsx/.js/.mjs/.cjs. Comments are excluded. ANY change to how governanceRecord is referenced changes
    // a count and fails here; whoever updates a count must re-check docs/workspaces/approval-b1-dual-record-proof.md §1.
    const EXT = /\.(ts|tsx|js|mjs|cjs)$/;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) return [];
        return statSync(p).isDirectory() ? walk(p) : EXT.test(name) ? [p] : [];
      });
    const rootFiles = readdirSync(ROOT).filter((n) => EXT.test(n) && statSync(join(ROOT, n)).isFile()).map((n) => join(ROOT, n));
    const all = [...["lib", "app", "components", "hooks", "scripts"].flatMap((d) => walk(join(ROOT, d))), ...rootFiles];
    const counts: Record<string, number> = {};
    for (const f of all) {
      const n = (stripComments(readFileSync(f, "utf8")).match(/governanceRecord/g) ?? []).length;
      if (n > 0) counts[rel(f)] = n;
    }
    expect(counts).toEqual({
      "app/api/teams/adaptive-runs/[runId]/decision/route.ts": 3,
      "app/api/teams/adaptive-runs/[runId]/review-panel/finalize/route.ts": 2,
      "app/api/teams/adaptive-runs/[runId]/review-panel/override/route.ts": 1,
      "app/api/teams/adaptive-runs/[runId]/review-panel/route.ts": 10,
      "app/api/teams/adaptive-runs/[runId]/route.ts": 2,
      "app/api/teams/adaptive-runs/[runId]/votes/route.ts": 6,
      "app/api/teams/runs/route.ts": 4,
      "app/api/user/runs/[runId]/decision/route.ts": 3,
      "app/api/user/runs/[runId]/export/route.ts": 3,
      "app/api/user/runs/[runId]/governance/route.ts": 6,
      "app/api/user/runs/[runId]/review-history/route.ts": 2,
      "app/api/user/runs/[runId]/route.ts": 7,
      "app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts": 3,
      // B3: the report-review record export READS governanceRecord only to refuse a run holding both records (fail closed).
      "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route.ts": 4,
      "app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/finalize/route.ts": 1,
      "app/api/workspaces/[workspaceId]/runs/[runId]/route.ts": 8,
      "lib/adaptiveSchema/decisionReceiptBuilder.ts": 1,
      "lib/adaptiveSchema/dsProvenanceRouteAdapter.ts": 8,
      "lib/adaptiveSchema/dsProvenanceViewMin.ts": 7,
      "lib/adaptiveSchema/exportRunProvenance.ts": 3,
      "lib/adaptiveSchema/exportSnapshot.ts": 9,
      "lib/adaptiveSchema/governanceInitialization.ts": 3,
      "lib/adaptiveSchema/governanceRecordBuilder.ts": 1,
      "lib/adaptiveSchema/governanceRecordParser.ts": 1,
      "lib/adaptiveSchema/jsonExport.ts": 1,
      "lib/adaptiveSchema/reportStatus.ts": 1,
      "lib/adaptiveSchema/researchExport.ts": 1,
      "lib/adaptiveSchema/reviewGovernanceViewModel.ts": 5,
      "lib/firestore/runs.ts": 26,
      "lib/firestore/teamRunSnapshots.ts": 2,
      "lib/governance/adaptiveGovernanceSeedPlan.ts": 3,
      "lib/governance/adaptiveHumanReviewHistory.ts": 5,
      "lib/governance/adaptiveHumanReviewPanel.ts": 1,
      "lib/governance/adaptiveHumanReviewRequest.ts": 1,
      "lib/governance/adaptiveHumanReviewVote.ts": 1,
      "lib/governance/adaptivePanelFinalization.ts": 1,
      "lib/governance/adaptivePanelFinalizationRepair.ts": 3,
      "lib/governance/adaptivePanelOverride.ts": 2,
      "lib/governance/adaptivePanelOverrideRepair.ts": 3,
      "lib/governance/adaptiveReviewArtifactRepair.ts": 4,
      "lib/governance/adaptiveReviewDetail.ts": 2,
      "lib/governance/adaptiveRunAccess.ts": 1,
      "lib/governance/evaluateAdaptiveGovernance.ts": 7,
      "lib/governance/personalReviewInbox.ts": 3,
      "lib/governance/reportReview.ts": 3,
      "lib/governance/reviewIntegrityMetrics.ts": 2,
      "lib/governance/teamReviewLabels.ts": 1,
      "lib/governance/teamReviewQueueEnrichment.ts": 6,
      "lib/governance/teamRunListContract.ts": 1,
      "lib/governance/workspaceGovernanceSummary.ts": 4,
      "lib/runPanelExecution.ts": 4,
      "lib/runs/runReadPayload.ts": 2,
      "lib/workspaces/deriveTeamRunViewerRole.ts": 3,
      "lib/workspaces/reportReviewAssignmentAudit.ts": 2, // B2 review fix: read-only "both records ⇒ fail closed" check
      "lib/workspaces/reportReviewContext.ts": 2, // B2: read-only "both records ⇒ integrity_violation" check
      "lib/workspaces/reportReviewDecisionMutation.ts": 2, // B2: read-only "both records ⇒ integrity_violation" check
      "lib/workspaces/resubmitWorkspaceReview.ts": 5,
      "lib/workspaces/reviewContext.ts": 3,
      "lib/workspaces/reviewQueue.ts": 14, // B2: +5 reads (governed-stream query field paths; fail-closed both-records check)
      "lib/workspaces/workspaceReviewMutations.ts": 6,
      "lib/workspaces/workspaceReviewPanelMutations.ts": 13,
      "lib/workspaces/workspaceRunDetail.ts": 2
    });
  });

  it("the seed plan's run documents are legacy-Team shaped (no workspaceId), so they can never be report-review targets", () => {
    const code = stripComments(readFileSync(join(ROOT, "lib/governance/adaptiveGovernanceSeedPlan.ts"), "utf8"));
    const runDoc = code.slice(code.indexOf("function runDoc("), code.indexOf("function runDoc(") + 900);
    expect(runDoc).toMatch(/teamId: SEED_TEAM_ID/);
    expect(runDoc).not.toMatch(/workspaceId/);
  });

  it("the run-execution initializer runs only for a saved Milestone-2 adaptive output", () => {
    const code = readFileSync(join(ROOT, "lib/runPanelExecution.ts"), "utf8");
    const gate = code.indexOf("if (adaptiveOutput.persistedOutput) {");
    const saved = code.indexOf('if (adaptivePayload.persistenceStatus !== "saved") {');
    const init = code.indexOf("initializeAdaptiveGovernanceRecord({");
    expect([gate > -1, saved > gate, init > saved]).toEqual([true, true, true]);
  });

  it("the snapshot builder creates its governance record only from a copied adaptiveOutput, on a NEW run id", () => {
    const code = stripComments(readFileSync(join(ROOT, "lib/firestore/teamRunSnapshots.ts"), "utf8"));
    expect(code).toMatch(/if \(hasOwn\(source, "adaptiveOutput"\)[\s\S]{0,200}buildAdaptiveGovernanceRecord\(\{\s*runId: args\.newRunId/);
    expect(code).toMatch(/const newRunId = `run-\$\{randomUUID\(\)\}`/);
  });
});

describe("3. dark by construction", () => {
  it("the shipped switch is the compile-time constant false (enabling needs a reviewed code change)", async () => {
    const actual = jest.requireActual("@/lib/workspaces/reportReviewRollout") as { REPORT_REVIEW_ENABLED: boolean };
    expect(actual.REPORT_REVIEW_ENABLED).toBe(false);
    const src = stripComments(readFileSync(join(ROOT, "lib/workspaces/reportReviewRollout.ts"), "utf8"));
    expect(src).not.toMatch(/process\.env/);
  });

  it("lib/env.ts is untouched by B1 (Order 6 boundary suites pin it)", () => {
    expect(stripComments(readFileSync(join(ROOT, "lib/env.ts"), "utf8"))).not.toMatch(/REPORT_REVIEW/);
  });
});
