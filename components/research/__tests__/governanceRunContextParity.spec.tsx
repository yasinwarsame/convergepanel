/**
 * Step 6.1 — Personal and Team render the SAME governance context from
 * equivalent persisted data.
 *
 * One run document goes through the REAL shared read builder twice — as the
 * Personal route calls it (owner) and as the Team route calls it (team_member,
 * `mayReadDecisionContent: true`) — then through the REAL shared interpreter and
 * the REAL shared view. Only `ResultsDisplay` is stubbed; it has its own suites.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("@/components/ResultsDisplay", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "results-display" }),
}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "u" }, authReady: true }) }));
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: () => {
    throw new Error("the shared result view must never fetch");
  },
}));

import PersistedResearchResultView from "@/components/research/PersistedResearchResultView";
import { interpretPersistedRunReadPayload, type PersistedResearchPresentation } from "@/lib/research/persistedRunPresentation";
import { buildRunReadPayload, type RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { FIXTURE_RUN_ID, deepResearchAdaptiveOutput, fullTeamRunData, governanceRecord } from "@/lib/runs/__tests__/runReadFixtures";

const REVIEWED_AT = "2026-10-05T12:00:00.000Z";
const GENERATED_AT = "2026-10-01T09:00:00.000Z";

function runData(over: { freshness?: string; policyVersion?: number | undefined; humanReview?: Record<string, unknown> } = {}) {
  const output = deepResearchAdaptiveOutput();
  return fullTeamRunData({
    adaptiveOutput: { ...output, generatedAt: GENERATED_AT, classification: { ...output.classification, freshness: over.freshness ?? "live" } },
    governanceRecord: governanceRecord("approved", {
      automatedGovernance: { status: "passed", reasons: [], ...("policyVersion" in over ? (over.policyVersion === undefined ? {} : { policyVersion: over.policyVersion }) : { policyVersion: 7 }) },
      humanReview: over.humanReview ?? { status: "approved", reviewedAt: REVIEWED_AT },
    }),
  });
}

async function presentationFor(data: Record<string, unknown>, viewerRole: RunReadViewerRole, mayReadDecisionContent: boolean): Promise<PersistedResearchPresentation> {
  const payload = await buildRunReadPayload({ mayReadDecisionContent, runId: FIXTURE_RUN_ID, data, viewerRole, resolveReviewRouting: async () => "unknown" });
  // Round-trip through JSON exactly as the HTTP response does.
  const interpreted = interpretPersistedRunReadPayload(JSON.parse(JSON.stringify(payload)), FIXTURE_RUN_ID);
  if (interpreted.kind !== "ready") throw new Error(`expected ready, got ${interpreted.kind}`);
  return interpreted.presentation;
}
const personal = (data: Record<string, unknown>) => presentationFor(data, "owner", true);
const team = (data: Record<string, unknown>) => presentationFor(data, "team_member", true);

async function renderLines(presentation: PersistedResearchPresentation) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(PersistedResearchResultView, { presentation }));
  });
  const container = r.root.findAll((n) => n.props?.["data-testid"] === "governance-run-context" && typeof n.type === "string");
  const items = r.root
    .findAll((n) => typeof n.type === "string" && typeof n.props?.["data-testid"] === "string" && n.props["data-testid"].startsWith("governance-run-context-"))
    .map((n) => ({ id: n.props["data-testid"] as string, text: (n.children as string[]).join("") }));
  return { containers: container.length, items };
}

it("Personal and Team derive an identical context from the same persisted run", async () => {
  const data = runData();
  const p = await personal(data);
  const t = await team(data);
  expect(p.governanceContext).toEqual({ policyVersion: 7, decidedAt: REVIEWED_AT, timeSensitiveGeneratedAt: GENERATED_AT });
  expect(t.governanceContext).toEqual(p.governanceContext);
});

it("Personal and Team render the same three lines", async () => {
  const data = runData();
  const pl = await renderLines(await personal(data));
  const tl = await renderLines(await team(data));
  expect(pl.containers).toBe(1);
  expect(pl.items.map((i) => i.id)).toEqual(["governance-run-context-policy", "governance-run-context-decided", "governance-run-context-time_sensitive"]);
  expect(pl.items[0].text).toBe("Evaluated under policy v7");
  expect(pl.items[1].text).toMatch(/^Decided .+ \(.+\)$/);
  expect(pl.items[2].text).toMatch(/^Time-sensitive question · generated .+$/);
  expect(tl.items).toEqual(pl.items);
});

it("with nothing persisted to show, no governance-context element renders at all", async () => {
  const data = runData({ freshness: "timeless", policyVersion: undefined, humanReview: { status: "unreviewed" } });
  for (const presentation of [await personal(data), await team(data)]) {
    const { containers, items } = await renderLines(presentation);
    expect(containers).toBe(0);
    expect(items).toEqual([]);
  }
});

it("a personal reviewer who may not read the decision content sees no decision time (the builder withheld it)", async () => {
  const p = await presentationFor(runData(), "personal_reviewer", false);
  expect(p.governanceContext).toEqual({ policyVersion: 7, decidedAt: null, timeSensitiveGeneratedAt: GENERATED_AT });
  const { items } = await renderLines(p);
  expect(items.map((i) => i.id)).toEqual(["governance-run-context-policy", "governance-run-context-time_sensitive"]);
});
