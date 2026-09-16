/**
 * TEAM-RESEARCH-PARITY-R3-P0 §I/§M/§N/§O/§P/§R — structural guarantees of the
 * adaptive ancillary boundary. Comments are stripped before every assertion
 * so a doc comment can never satisfy (or break) one.
 */
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PANEL = code("components/adaptive/AdaptivePanelResponse.tsx");
const BAR = code("components/adaptive/TopSummaryBar.tsx");
const RESULTS = code("components/ResultsDisplay.tsx");
const VIEW = code("components/research/PersistedResearchResultView.tsx");
const CONTRACT = code("components/adaptive/adaptiveAncillaryPresentation.ts");

describe("centralized review & governance decision (§G/§R)", () => {
  it("ReviewGovernanceSection is mounted in exactly ONE place: inside the delegated-policy helper", () => {
    const mounts = PANEL.match(/<ReviewGovernanceSection\b/g) ?? [];
    expect(mounts).toHaveLength(1);
    const helperStart = PANEL.indexOf("const renderReviewGovernance = ");
    const helperEnd = PANEL.indexOf(";", PANEL.indexOf("<ReviewGovernanceSection", helperStart));
    expect(helperStart).toBeGreaterThan(-1);
    expect(PANEL.indexOf("<ReviewGovernanceSection")).toBeGreaterThan(helperStart);
    expect(PANEL.indexOf("<ReviewGovernanceSection")).toBeLessThan(helperEnd);
    expect(PANEL.slice(helperStart, helperEnd)).toMatch(/ancillary\.kind === "delegated_read_only" \? \(ancillary\.reviewGovernanceSurface \?\? null\) :/);
  });

  it("every one of the ten schema-branch governance positions goes through the helper — no branch bypasses it", () => {
    const calls = PANEL.match(/\{renderReviewGovernance\(\{/g) ?? [];
    expect(calls).toHaveLength(10);
  });

  it("TopSummaryBar receives the same resolved policy object", () => {
    expect(PANEL).toMatch(/<TopSummaryBar[\s\S]*?ancillaryPresentation=\{ancillary\}/);
  });
});

describe("TopSummaryBar export ownership (§F)", () => {
  it("the Personal export button and export history each appear exactly once, and only on the non-delegated side of one decision", () => {
    expect(BAR.match(/<AdaptiveExportButton\b/g) ?? []).toHaveLength(1);
    expect(BAR.match(/<AdaptiveExportHistorySection\b/g) ?? []).toHaveLength(1);
    expect(BAR).toMatch(/const exportControl = ancillary\.kind === "delegated_read_only" \? \(ancillary\.exportSurface \?\? null\) : <AdaptiveExportButton runId=\{runId\} \/>;/);
    expect(BAR).toMatch(/const exportHistory = ancillary\.kind === "delegated_read_only" \? null : <AdaptiveExportHistorySection runId=\{runId\} \/>;/);
  });
});

describe("route neutrality (§I/§O)", () => {
  it.each([
    ["AdaptivePanelResponse", PANEL],
    ["TopSummaryBar", BAR],
    ["ResultsDisplay", RESULTS],
    ["PersistedResearchResultView", VIEW],
    ["adaptiveAncillaryPresentation", CONTRACT],
  ])("%s hard-codes no Workspace, Team, review or Project route", (_name, source) => {
    expect(source).not.toMatch(/\/workspace\/reviews/);
    expect(source).not.toMatch(/\/workspace\/team/);
    expect(source).not.toMatch(/\/workspace\/research/);
    expect(source).not.toMatch(/\/projects\//);
  });

  it("PersistedResearchResultView names no API route and no authorization concept", () => {
    expect(VIEW).not.toMatch(/\/api\//);
    expect(VIEW).not.toMatch(/membership|capabilit|assignee|workspaceId/i);
  });
});

describe("no role-based presentation mode (§P)", () => {
  it.each([
    ["AdaptivePanelResponse", PANEL],
    ["TopSummaryBar", BAR],
    ["ResultsDisplay", RESULTS],
    ["PersistedResearchResultView", VIEW],
  ])("%s never reads a viewer role to choose ancillary presentation", (_name, source) => {
    expect(source).not.toMatch(/viewerRole/);
    expect(source).not.toMatch(/team_member|team_reviewer|personal_reviewer/);
  });

  it("ResultsDisplay and PersistedResearchResultView only FORWARD the caller's policy, never construct one", () => {
    expect(RESULTS).toMatch(/ancillaryPresentation=\{adaptiveAncillaryPresentation\}/);
    expect(VIEW).toMatch(/adaptiveAncillaryPresentation=\{adaptiveAncillaryPresentation\}/);
    for (const source of [RESULTS, VIEW, PANEL, BAR]) expect(source).not.toMatch(/kind: "delegated_read_only"/);
  });
});

describe("Personal callers keep the default (§M/§N)", () => {
  it("the live composer passes no ancillary policy to ResultsDisplay", () => {
    const page = code("app/page.tsx");
    expect(page).toMatch(/<ResultsDisplay/);
    expect(page).not.toMatch(/adaptiveAncillaryPresentation|ancillaryPresentation|delegated_read_only/);
  });

  it("the Personal durable report passes no ancillary policy to PersistedResearchResultView", () => {
    const shell = code("components/workspace/PersonalResearchDetailShell.tsx");
    expect(shell).toMatch(/<PersistedResearchResultView/);
    expect(shell).not.toMatch(/adaptiveAncillaryPresentation|ancillaryPresentation|delegated_read_only/);
  });

  it("the Personal default is the resolver's fallback", () => {
    expect(CONTRACT).toMatch(/return policy \?\? PERSONAL_DEFAULT_ANCILLARY_PRESENTATION;/);
    expect(CONTRACT).toMatch(/PERSONAL_DEFAULT_ANCILLARY_PRESENTATION[^=]*= Object\.freeze\(\{ kind: "personal_default" as const \}\)/);
  });
});
