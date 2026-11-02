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
  it("only the B1 writer references the archive and event collections", () => {
    const users = FILES.filter((f) => /reportReviewCycles|reportReviewEvents|REPORT_REVIEW_CYCLES_COLLECTION|REPORT_REVIEW_EVENTS_COLLECTION/.test(stripComments(readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual([WRITER]);
  });

  it("inside the writer, every archive or event write is tx.create (never set/update/delete)", () => {
    const code = stripComments(readFileSync(join(ROOT, WRITER), "utf8"));
    const uses = code.split("\n").filter((l) => /REPORT_REVIEW_(CYCLES|EVENTS)_COLLECTION\)/.test(l));
    expect(uses.length).toBe(3); // submit event, resubmit archive, resubmit event
    // Each use is the argument line of a tx.create( call.
    const lines = code.split("\n");
    for (const u of uses) {
      const i = lines.indexOf(u);
      expect(lines.slice(Math.max(0, i - 1), i + 1).join("\n")).toMatch(/tx\.create\(/);
    }
    expect(code).not.toMatch(/REPORT_REVIEW_(CYCLES|EVENTS)_COLLECTION[\s\S]{0,120}\.(update|delete)\(/);
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
    const writers = FILES.filter((f) => WRITE.test(stripComments(readFileSync(f, "utf8")))).map(rel);
    expect(writers).toEqual([WRITER]);
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

  it("TRIPWIRE (review B1-m1 residual): every governanceRecord key, assignment or field-path token in all source files is pinned per file", () => {
    // Broad and deliberately over-inclusive: it also counts reads (DTO keys, type annotations). Any new occurrence —
    // a new writer of ANY shape (payload variables, chained refs, nested literals, variadic updates, computed keys),
    // in ANY file, including the allow-listed ones and .js/.mjs/.cjs scripts — changes a count and fails this test.
    // Whoever changes a count must re-check docs/workspaces/approval-b1-dual-record-proof.md §1 before updating it.
    const TOKEN = /\bgovernanceRecord\b\s*[:=]|\[\s*["'`]governanceRecord["'`]|["'`]governanceRecord\./g;
    const all = [...FILES, ...sourceFiles(join(ROOT, "hooks")), ...scriptFiles(join(ROOT, "scripts"))];
    const counts: Record<string, number> = {};
    for (const f of all) {
      const n = (stripComments(readFileSync(f, "utf8")).match(TOKEN) ?? []).length;
      if (n > 0) counts[rel(f)] = n;
    }
    expect(counts).toEqual({
      "app/api/teams/adaptive-runs/[runId]/review-panel/route.ts": 1,
      "app/api/teams/adaptive-runs/[runId]/votes/route.ts": 1,
      "app/api/teams/runs/route.ts": 2,
      "app/api/user/runs/[runId]/export/route.ts": 1,
      "app/api/user/runs/[runId]/governance/route.ts": 2,
      "app/api/user/runs/[runId]/route.ts": 2,
      "app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts": 1,
      "app/api/workspaces/[workspaceId]/runs/[runId]/route.ts": 3,
      "lib/adaptiveSchema/dsProvenanceRouteAdapter.ts": 4,
      "lib/adaptiveSchema/dsProvenanceViewMin.ts": 3,
      "lib/adaptiveSchema/reviewGovernanceViewModel.ts": 1,
      "lib/firestore/runs.ts": 9,
      "lib/firestore/teamRunSnapshots.ts": 1,
      "lib/governance/adaptiveGovernanceSeedPlan.ts": 1,
      "lib/governance/evaluateAdaptiveGovernance.ts": 2,
      "lib/governance/reviewIntegrityMetrics.ts": 2,
      "lib/governance/teamReviewQueueEnrichment.ts": 2,
      "lib/governance/workspaceGovernanceSummary.ts": 3,
      "lib/runPanelExecution.ts": 1,
      "lib/workspaces/deriveTeamRunViewerRole.ts": 1,
      "lib/workspaces/resubmitWorkspaceReview.ts": 2,
      "lib/workspaces/reviewQueue.ts": 5,
      "lib/workspaces/workspaceReviewMutations.ts": 2,
      "lib/workspaces/workspaceReviewPanelMutations.ts": 4,
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
