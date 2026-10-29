/**
 * Order 6 / S-2a — page-level parity for the Decision Support provenance UI.
 *
 * The REAL page shells (PersonalResearchDetailShell = P1 page, TeamResearchDetailShell = W1 page,
 * PersonalReviewDetail = reviewer inbox) render with every request they make answered by the REAL route handlers
 * (P1, W1, P2) running in this process; only I/O below the handlers is mocked (as in the S-1b.1 / S-1b.2 route
 * suites). The server flag `DS_PROVENANCE_ROUTE_VIEW_ENABLED` is the only switch: OFF, the routes omit `dsProvenance`;
 * ON, they attach the view each viewer is entitled to.
 *
 * Baseline: __fixtures__/dsProvenancePagesBaseline.9eca1e3.json was captured from the unmodified page code at main
 * 9eca1e3 (before any S-2a edit) with DS_PROVENANCE_PAGES_CAPTURE=<path>. It records, per case, the sha-256 of the
 * serialized rendered tree, the number of D-9 disclosures on the page, and the ordered request list. Never regenerate
 * it after changing page code.
 *
 * For every case and both flag states:
 *   - flag OFF: the rendered tree equals the baseline byte for byte;
 *   - flag ON: with the provenance section removed (the element marked `data-ds-provenance-section`), the tree equals
 *     the baseline byte for byte; the page shows exactly its baseline number of D-9 disclosures (Q1(a): P1 1, W1 2,
 *     inbox 1 where options exist); the request list is the baseline's (no new fetch).
 */

process.env.TZ = "UTC";

let mockFlag = false;
jest.mock("@/lib/env", () => ({
  WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_ENABLED: true,
  TEAM_WORKSPACES_CANARY_UIDS: undefined,
  TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined,
  get DS_PROVENANCE_ROUTE_VIEW_ENABLED() {
    return mockFlag;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));

const mockIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: () => {} }));
const mockTeamAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockTeamAccess(...a) }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({ validateRunWorkspaceAssociation: async () => ({ classification: "legacy" }) }));
jest.mock("@/lib/firestore/projects", () => ({
  getProject: async () => ({ status: "found", project: { id: "projAutoId0001", workspaceId: "aTeamWorkspaceAutoId12345", name: "Launch", status: "active" }, documentUpdateTime: null }),
}));
jest.mock("@/lib/workspaces/teamRunAssigneeEnrichment", () => ({ resolveRunAssigneesForPage: async () => [null] }));
const mockAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...a: unknown[]) => mockAssignment(...a),
  getAdaptiveHumanReviewPanel: async () => ({ status: "absent" }),
  getAdaptiveHumanReviewVote: async () => ({ status: "absent" }),
}));
jest.mock("@/lib/teams/teamApiAuth", () => ({ loadUserAndTeam: async () => ({ user: { email: "caller@example.test" }, team: { id: "legacy-team-1", members: [] } }) }));
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: async () => ({ status: "found", projection: { projectionVersion: 1, adaptive: true, teamId: "legacy-team-1", runId: "run-parity-1" } }),
}));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name-${u}`])),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
  REVIEWER_UNAVAILABLE_LABEL: "Reviewer unavailable",
}));
const mockRunDocs = new Map<string, Record<string, unknown>>();
let mockHistoryRows = new Map<string, unknown>();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: () => ({
        doc: (runId: string) => ({
          get: async () => ({ exists: mockRunDocs.has(runId), data: () => mockRunDocs.get(runId) }),
          collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: mockHistoryRows.has(id), data: () => mockHistoryRows.get(id) }) }) }),
        }),
      }),
    };
  },
}));

// ─── Client side ───────────────────────────────────────────────────────────
jest.mock("react-markdown", () => ({ __esModule: true, default: ({ children }: { children?: unknown }) => require("react").createElement("div", null, children as never) }));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: "full", loading: false }) }));
// One stable auth object (a fresh one per render would re-trigger the pages' load effects forever).
const mockAuth = { user: { uid: "uid-page-viewer", getIdToken: async () => "t" }, loading: false, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => mockAuth }));
const mockRequests: string[] = [];
const mockAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));

import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET as p1Get } from "@/app/api/user/runs/[runId]/route";
import { GET as p2Get } from "@/app/api/user/runs/[runId]/governance/route";
import { GET as w1Get } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/route";
import { buildPersonalReviewDecisionId } from "@/lib/governance/adaptiveHumanReviewHistory";
import PersonalResearchDetailShell from "@/components/workspace/PersonalResearchDetailShell";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import PersonalReviewDetail from "@/components/personalReview/PersonalReviewDetail";
import { CASES, D9, OWNER, PER_MODEL_ROWS, PROJECT_ID, REVIEWER, RUN_ID, TEAM_UID, WS_ID, governanceRecord, stateOutput, storedHumanReview, type PageCase } from "./dsProvenanceUi/pageCases";

const FIXED_NOW = new Date("2026-10-29T12:00:00.000Z");
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── Real routes behind the client's authedFetch ──────────────────────────

function stage(c: PageCase): void {
  const v = c.viewer;
  const output = stateOutput(c.state);
  const doc: Record<string, unknown> = {
    userId: v.runKind === "personal" ? OWNER : "creator-1",
    question: "Should we proceed?",
    selectedModels: ["chatgpt", "claude", "gemini"],
    status: "complete",
    runDocument: { perModel: c.nullPerModelRow ? [null, ...PER_MODEL_ROWS] : PER_MODEL_ROWS },
    createdAt: CREATED,
    adaptiveOutput: output,
    governanceRecord: governanceRecord(v.runKind, c.record, output),
  };
  if (v.runKind === "team") Object.assign(doc, { workspaceId: WS_ID, projectId: PROJECT_ID });
  Object.assign(doc, v.runOverrides ?? {});
  mockRunDocs.clear();
  mockRunDocs.set(RUN_ID, doc);

  mockHistoryRows = new Map();
  const hr = storedHumanReview(v.runKind, c.record);
  if (v.history === "qualifying" && typeof hr.reviewedAt === "string" && typeof hr.status === "string") {
    mockHistoryRows.set(buildPersonalReviewDecisionId(RUN_ID, hr.reviewedAt, hr.status), {
      version: 1, kind: "adaptive_human_review", runId: RUN_ID, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view",
      priorStatus: "unreviewed", newStatus: hr.status, reviewerId: hr.reviewerId, reviewedAt: hr.reviewedAt, commentPresent: false, conditionsCount: 0,
    });
  }
  mockIdentity.mockResolvedValue(v.uid === null ? { status: "unauthenticated", reason: "missing_credentials" } : { status: "authenticated", uid: v.uid, source: "session_cookie" });
  mockTeamAccess.mockResolvedValue(v.teamAccess ?? { granted: true, workspace: { id: WS_ID, type: "team" }, membership: { role: "member" }, capabilities: v.capabilities ?? [] });
  mockAssignment.mockResolvedValue(
    v.runKind === "personal"
      ? { status: "found", assignment: { version: 1, runId: RUN_ID, teamId: null, assignedReviewerUserId: REVIEWER, assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1 } }
      : v.assignedTeamReviewer
        ? { status: "found", assignment: { assignedReviewerUserId: TEAM_UID } }
        : { status: "unassigned" },
  );
}

/** As the runtime does: a handler that throws becomes a 500 (O6-OBS-5 throws inside P1/W1 after authorization). */
async function serve(url: string, init: { method?: string } = {}): Promise<Response> {
  try {
    return await route(url, init);
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function route(url: string, init: { method?: string }): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  mockRequests.push(`${method} ${url}`);
  const u = new URL(url, "http://localhost");
  const headers = { "x-vercel-id": "vid-1" };
  if (method === "GET") {
    let m = /^\/api\/user\/runs\/([^/]+)$/.exec(u.pathname);
    if (m) return p1Get(new NextRequest(`http://localhost${u.pathname}${u.search}`, { headers }), { params: Promise.resolve({ runId: decodeURIComponent(m[1]) }) });
    m = /^\/api\/user\/runs\/([^/]+)\/governance$/.exec(u.pathname);
    if (m) return p2Get(new NextRequest(`http://localhost${u.pathname}`, { headers }), { params: Promise.resolve({ runId: decodeURIComponent(m[1]) }) });
    m = /^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)$/.exec(u.pathname);
    if (m) return w1Get(new NextRequest(`http://localhost${u.pathname}${u.search}`, { headers }), { params: { workspaceId: decodeURIComponent(m[1]), runId: decodeURIComponent(m[2]) } });
  }
  // Every other request (export history, review history, …) is answered identically in both flag states.
  return new Response(JSON.stringify({ ok: false, errorCode: "not_found", message: "Not found." }), { status: 404, headers: { "content-type": "application/json" } });
}

// ─── Rendering and serialization ──────────────────────────────────────────

type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };
const SECTION_ATTR = "data-ds-provenance-section";

function withoutSection(node: Node | string): Node | string | null {
  if (typeof node === "string") return node;
  if (node.props && SECTION_ATTR in node.props) return null;
  const children = (node.children ?? []).map(withoutSection).filter((n): n is Node | string => n !== null);
  return { ...node, children: children.length ? children : null };
}

function serialize(node: Node | string | null): string {
  if (node === null) return "";
  if (typeof node === "string") return JSON.stringify(node);
  const attrs = Object.keys(node.props ?? {})
    .filter((k) => typeof node.props[k] !== "function" && node.props[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(node.props[k])}`)
    .join(" ");
  return `<${node.type}${attrs ? ` ${attrs}` : ""}>${(node.children ?? []).map(serialize).join("")}</${node.type}>`;
}

function texts(node: Node | string | null, out: string[] = []): string[] {
  if (node === null) return out;
  if (typeof node === "string") out.push(node);
  else for (const ch of node.children ?? []) texts(ch, out);
  return out;
}

/**
 * The pages format some timestamps in the process's local timezone ("Mar 4, 2026, 5:06 AM", "(Oct 2, 2026)"), which
 * differs between a laptop and CI. S-2a does not touch those, so each local date-time and local date is replaced by a
 * fixed token (the S-E.1 approach); every other character is compared exactly. The provenance section's own date uses a
 * fixed UTC format the tokens do not match.
 */
const LOCAL_DATETIME = /\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M\b/g;
const LOCAL_DATE = /\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/g;
const tokeniseDates = (s: string) => s.replace(LOCAL_DATETIME, "⟨datetime⟩").replace(LOCAL_DATE, "⟨date⟩");

export interface PageRender {
  tree: Node | null;
  dom: string;
  baselineDom: string;
  d9: number;
  requests: string[];
}

function pageElement(c: PageCase) {
  switch (c.viewer.page) {
    case "P1":
      return createElement(PersonalResearchDetailShell, { runId: RUN_ID });
    case "W1":
      return createElement(TeamResearchDetailShell, { workspaceId: WS_ID, workspaceName: "Acme Team", runId: RUN_ID, project: { id: PROJECT_ID, name: "Launch" }, showMembers: true, showAudit: false });
    case "INBOX":
      return createElement(PersonalReviewDetail, { runId: RUN_ID });
  }
}

async function renderPage(c: PageCase, flag: boolean): Promise<PageRender> {
  mockFlag = flag;
  stage(c);
  mockRequests.length = 0;
  mockAuthedFetch.mockImplementation((url: string, init?: { method?: string }) => serve(url, init));
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(pageElement(c));
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  }
  const json = r.toJSON() as Node | Node[] | null;
  act(() => r.unmount());
  const tree: Node | null = Array.isArray(json) ? { type: "#fragment", props: {}, children: json } : json;
  const stripped = tree ? withoutSection(tree) : null;
  const all = texts(tree).join("\n");
  return { tree, dom: tokeniseDates(serialize(tree)), baselineDom: tokeniseDates(serialize(stripped)), d9: all.split(D9).length - 1, requests: [...mockRequests].sort() };
}

// ─── Baseline ─────────────────────────────────────────────────────────────

type BaselineCase = { domSha256: string; domLength: number; d9: number; requests: string[] };
const BASELINE_PATH = join(__dirname, "__fixtures__", "dsProvenancePagesBaseline.9eca1e3.json");
const CAPTURE = process.env.DS_PROVENANCE_PAGES_CAPTURE;
/** Optional, capture mode only: also write each case's serialized tree (for inspecting a baseline difference). */
const DUMP_DIR = process.env.DS_PROVENANCE_PAGES_DUMP_DIR;

beforeAll(() => {
  jest.useFakeTimers({
    now: FIXED_NOW,
    doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"],
  });
});
afterAll(() => jest.useRealTimers());

if (CAPTURE) {
  it("captures the page baseline from unmodified page code", async () => {
    const cases: Record<string, BaselineCase> = {};
    for (const c of CASES) {
      const off = await renderPage(c, false);
      const on = await renderPage(c, true);
      // Unmodified pages read no `dsProvenance`: both flag states must render the same tree before capture.
      expect([c.id, on.dom, on.requests]).toEqual([c.id, off.dom, off.requests]);
      cases[c.id] = { domSha256: sha(off.dom), domLength: off.dom.length, d9: off.d9, requests: off.requests };
      if (DUMP_DIR) writeFileSync(join(DUMP_DIR, `${c.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.html`), off.dom);
    }
    writeFileSync(CAPTURE, JSON.stringify({ baseCommit: "9eca1e3420b526973b6ff872c6e04e1a390eea46", tz: process.env.TZ, now: FIXED_NOW.toISOString(), caseCount: CASES.length, cases }, null, 1) + "\n");
  }, 600_000);
} else {
  const BASELINE: { baseCommit: string; cases: Record<string, BaselineCase> } = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : { baseCommit: "", cases: {} };

  describe("page parity with the unmodified 9eca1e3 pages (real routes, real pages)", () => {
    it("the baseline covers exactly this case matrix", () => {
      expect(BASELINE.baseCommit).toBe("9eca1e3420b526973b6ff872c6e04e1a390eea46");
      expect(Object.keys(BASELINE.cases).sort()).toEqual(CASES.map((c) => c.id).sort());
    });

    it.each(CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
      const base = BASELINE.cases[c.id];
      const off = await renderPage(c, false);
      expect({ sha: sha(off.dom), d9: off.d9, requests: off.requests }).toEqual({ sha: base.domSha256, d9: base.d9, requests: base.requests });
      // Flag OFF: no section anywhere.
      expect(off.dom).toBe(off.baselineDom);
      const on = await renderPage(c, true);
      expect({ sha: sha(on.baselineDom), d9: on.d9, requests: on.requests }).toEqual({ sha: base.domSha256, d9: base.d9, requests: base.requests });
    });
  });
}
