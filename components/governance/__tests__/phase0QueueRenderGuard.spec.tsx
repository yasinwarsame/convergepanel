/**
 * Phase 0 compatibility restoration — P0-H4 (inventory v3.4 A.7.1, row H30; lands with L15 per H-9).
 *
 * The governance-queue DTO is the 35933c8 DTO again (stored score / evidence quality; every stored research disagreement
 * line), with the executing-model information as additive keys. GovernanceDashboard therefore withholds at render time:
 *  - a row with `consensusWithheld` shows the reason — never the number, its colour or an evidence-quality chip;
 *  - a research row's "Key disagreements" / "Where synthesis flags disagreements" omit every line the route lists in
 *    `qualifiedDisagreements` (shown under their own heading instead).
 * Driven through the REAL queue GET handler and the REAL FragmentRow; no decision or DTO field is read differently.
 */
const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({ resolveGovernanceRequestUser: (...a: any[]) => mockedResolveGovernanceRequestUser(...a) }));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...a: any[]) => mockedResolveVisibleUserIds(...a),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));
let runRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    const rowsFor = name === "runs" ? () => runRows : () => [];
    const q: any = { where: () => q, orderBy: () => q, limit: () => q, select: () => q, get: async () => ({ docs: rowsFor().map((r) => ({ id: r.id, data: () => r.data })) }) };
    if (name === "runs" || name === "verifications" || name === "videoVerifications") return q;
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import {
  FragmentRow,
  QUALIFIED_DISAGREEMENTS_HEADING,
  queuePresentedEvidenceQuality,
  queuePresentedScore,
  queueResearchDisagreementLines,
} from "@/components/governance/GovernanceDashboard";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/panel/independentVoices";

const row = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...extra });
const deepseek = { provider: "deepseek" };
const FOUNDING = { topic: "Founding date", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "ChatGPT says 1789, Claude says 1792" };
const VS_GROK = { topic: "Founder", positionsByModel: { chatgpt: "A merchant", grok: "A banker" }, whyTheyDiffer: "Different sources" };
const run = (id: string, perModel: unknown[] | undefined, disagreements: unknown[]) => ({
  id,
  data: {
    userId: "owner-a",
    question: id,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    createdAt: new Date(),
    synthesisConsensusSummary: { overallConsensusScore: 90, lowEvidenceClaims: 0, aggregateSupportRatio: 1 },
    policyConsensusSummary: { evidenceQuality: "strong" },
    synthesizedStructuredReport: { keyFindings: [{ claim: "Founded in the 1790s." }], disagreements },
    structuredSynthesis: { keyFindings: ["Founded in the 1790s."], disagreements },
    ...(perModel ? { runDocument: { perModel } } : {}),
  },
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});
afterEach(() => jest.restoreAllMocks());

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
  expect(res.status).toBe(200);
  return Object.fromEntries((await res.json()).runs.map((r: any) => [r.runId, r]));
}

/** Renders the REAL FragmentRow; the colour callback reports the score it was given. */
function render(r: Record<string, unknown>): { html: string; colourArg: unknown } {
  const noop = () => {};
  let colourArg: unknown = "not-called";
  const html = renderToStaticMarkup(
    createElement(
      "table",
      null,
      createElement(
        "tbody",
        null,
        createElement(FragmentRow as never, {
          row: r,
          chip: { wrap: "", label: "Review" },
          mh: { text: "", cls: "", title: "" },
          ev: { text: "", cls: "" },
          exp: true,
          firstReason: "",
          more: "",
          consensusColor: (s: unknown) => {
            colourArg = s;
            return "";
          },
          expanded: new Set<string>(),
          setExpanded: noop,
          reviewBusyKey: null,
          onApprove: noop,
          onBlock: noop,
          onChanges: noop,
        } as never)
      )
    )
  )
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'");
  return { html, colourArg };
}
const section = (html: string, heading: string) => {
  const i = html.indexOf(heading);
  return i < 0 ? null : html.slice(i, html.indexOf("</ul>", i));
};

describe("P0-H4: GovernanceDashboard withholds what the 35933c8 DTO carries but the executing models do not support", () => {
  it("two DeepSeek substitutions: stored score in the DTO, reason on screen; no number, no score colour, no evidence chip", async () => {
    runRows = [run("ds", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek)], [FOUNDING])];
    const r = (await rows())["ds"];
    expect([r.consensusScore, r.evidenceQuality, r.consensusWithheld]).toEqual([90, "strong", "insufficient_independent_models"]);
    expect([queuePresentedScore(r), queuePresentedEvidenceQuality(r)]).toEqual([null, null]);
    const { html, colourArg } = render(r);
    expect(colourArg).toBeNull();
    expect(html).toContain(CONSENSUS_WITHHELD_TEXT.insufficient_independent_models);
    expect(html).not.toMatch(/>90</);
    // The stored line is in the DTO but shown only as a recorded difference, never under the disagreement headings.
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792"]);
    expect(section(html, "Key disagreements")).toBeNull();
    expect(section(html, "Where synthesis flags disagreements")).toBeNull();
    expect(section(html, QUALIFIED_DISAGREEMENTS_HEADING)).toContain("Founding date: ChatGPT says 1789, Claude says 1792");
  });

  it("DeepSeek×2 + Grok: only the genuine DeepSeek-vs-Grok line is presented as a disagreement", async () => {
    runRows = [run("mixed", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek), row("grok", "ok")], [FOUNDING, VS_GROK])];
    const r = (await rows())["mixed"];
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792", "Founder: Different sources"]);
    expect(queueResearchDisagreementLines(r.disagreements, r)).toEqual(["Founder: Different sources"]);
    expect(queueResearchDisagreementLines(r.disagreementPoints, r)).toEqual(["Founder"]);
    const { html, colourArg } = render(r);
    expect(colourArg).toBe(90);
    const key = section(html, "Key disagreements")!;
    expect(key).toContain("Founder: Different sources");
    expect(key).not.toContain("Founding date");
    const flags = section(html, "Where synthesis flags disagreements")!;
    expect(flags).toContain("Founder");
    expect(flags).not.toContain("Founding date");
  });

  it("control: two independent models — score, colour and every stored line presented exactly as stored", async () => {
    runRows = [run("two", [row("chatgpt", "ok"), row("claude", "ok")], [FOUNDING])];
    const r = (await rows())["two"];
    expect([queuePresentedScore(r), queuePresentedEvidenceQuality(r)]).toEqual([90, "strong"]);
    const { html, colourArg } = render(r);
    expect(colourArg).toBe(90);
    expect(section(html, "Key disagreements")).toContain("Founding date: ChatGPT says 1789, Claude says 1792");
    expect(section(html, QUALIFIED_DISAGREEMENTS_HEADING)).toBeNull();
  });

  it("the queue table's evidence chip reads the presented evidence quality (source wiring)", () => {
    const src = readFileSync(join(process.cwd(), "components/governance/GovernanceDashboard.tsx"), "utf8");
    expect(src).toContain("const ev = evidenceChip(queuePresentedEvidenceQuality(row));");
    expect(src).not.toContain("evidenceChip(row.evidenceQuality)");
    expect(src).toContain("consensusColor(queuePresentedScore(row))");
  });
});
