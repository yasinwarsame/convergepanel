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

import { undoCriticalContrastClasses } from "./criticalContrastSlice";
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
import { scanSurface } from "./seSurfaces/dsWordingScanner";
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

/** Optional per-render rewrite of a route's JSON body (isolation tests only); null in every parity and oracle case. */
let mockRewrite: ((path: string, body: Record<string, unknown>) => Record<string, unknown>) | null = null;

/** As the runtime does: a handler that throws becomes a 500 (O6-OBS-5 throws inside P1/W1 after authorization). */
async function serve(url: string, init: { method?: string } = {}): Promise<Response> {
  let res: Response;
  try {
    res = await route(url, init);
  } catch {
    return new Response("Internal Server Error", { status: 500 });
  }
  if (!mockRewrite || res.status !== 200) return res;
  const body = mockRewrite(new URL(url, "http://localhost").pathname, await res.json());
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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
      // Order 6 critical-contrast slice: the baseline predates it; compare with its class changes reversed.
      expect({ sha: sha(undoCriticalContrastClasses(off.dom).markup), d9: off.d9, requests: off.requests }).toEqual({ sha: base.domSha256, d9: base.d9, requests: base.requests });
      // Flag OFF: no section anywhere.
      expect(off.dom).toBe(off.baselineDom);
      const on = await renderPage(c, true);
      expect({ sha: sha(undoCriticalContrastClasses(on.baselineDom).markup), d9: on.d9, requests: on.requests }).toEqual({ sha: base.domSha256, d9: base.d9, requests: base.requests });
    });
  });

  describe("flag ON: the section shows exactly the approved text for this viewer and record (literal oracle)", () => {
    it.each(CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
      const off = await renderPage(c, false);
      expect(sections(off.tree)).toHaveLength(0);
      const on = await renderPage(c, true);
      const found = sections(on.tree);
      const expected = expectedSection(c);
      if (expected === null) {
        expect(found).toHaveLength(0);
        return;
      }
      expect(found).toHaveLength(1);
      expect(texts(found[0]).map((t) => t.trim()).filter(Boolean)).toEqual(expected);
      // The real S-E.1 scanner: the section itself has no hit (its D-2 sentence included), and the whole page has
      // exactly the hits it had with the flag off.
      const rationale = (stateOutput(c.state).result as unknown as { recommendation?: { rationale?: string } }).recommendation?.rationale;
      const scan = (nodes: string[]) => scanSurface({ id: c.id, textNodes: nodes, attributes: [] }, { storedRationales: rationale ? [rationale] : [] }).map((h) => h.family);
      expect(scan(texts(found[0]))).toEqual([]);
      expect(scan(texts(on.tree))).toEqual(scan(texts(off.tree)));
      // Placement (OD-6): directly after Panel Evidence on P1/W1, directly after the Decision Receipt on the inbox.
      const previous = previousSibling(on.tree!, found[0]);
      expect(previous && texts(previous).map((t) => t.trim()).find(Boolean)).toBe(c.viewer.page === "INBOX" ? "Decision Receipt" : "Panel Evidence");
      // Collapsed by default: the toggle reports collapsed and the panel is hidden.
      const button = find(found[0], (n) => n.type === "button")!;
      const panel = find(found[0], (n) => n.props?.role === "region")!;
      expect([button.props["aria-expanded"], button.props["aria-controls"], panel.props.id, panel.props.hidden]).toEqual([false, panel.props.id, button.props["aria-controls"], true]);
    });
  });
}

describe("view isolation: a page never borrows another route's view (OD-4)", () => {
  const inbox = CASES.find((c) => c.id === "inbox.rev.identity|uncontested_choose_option|awc")!;
  const p1 = CASES.find((c) => c.id === "p1.owner|uncontested_choose_option|awc")!;
  afterEach(() => {
    mockRewrite = null;
  });

  it("the inbox with no P2 view renders no section, although its report response carries a P1 view", async () => {
    let p1ViewSeen = false;
    mockRewrite = (path, body) => {
      if (path.endsWith("/governance")) {
        const { dsProvenance: _dropped, ...rest } = body;
        return rest;
      }
      p1ViewSeen = p1ViewSeen || "dsProvenance" in body;
      return body;
    };
    const on = await renderPage(inbox, true);
    expect(p1ViewSeen).toBe(true);
    expect(sections(on.tree)).toHaveLength(0);
  });

  it("the P1 page with no P1 view renders no section, although its governance response carries a P2 view", async () => {
    let p2ViewSeen = false;
    mockRewrite = (path, body) => {
      if (path.endsWith("/governance")) {
        p2ViewSeen = p2ViewSeen || "dsProvenance" in body;
        return body;
      }
      const { dsProvenance: _dropped, ...rest } = body;
      return rest;
    };
    const on = await renderPage(p1, true);
    expect(p2ViewSeen).toBe(true);
    expect(sections(on.tree)).toHaveLength(0);
  });
});

// ─── Flag-ON oracle (independent of the mapper and the builder) ───────────

function sections(tree: Node | null): Node[] {
  const out: Node[] = [];
  const walk = (n: Node | string) => {
    if (typeof n === "string") return;
    if (n.props && SECTION_ATTR in n.props) out.push(n);
    for (const ch of n.children ?? []) walk(ch);
  };
  if (tree) walk(tree);
  return out;
}

/** The element sibling immediately before `target` in its parent; null when it is the first child or not in the tree. */
function previousSibling(root: Node, target: Node): Node | null {
  const search = (node: Node): { found: boolean; prev: Node | null } => {
    const kids = (node.children ?? []).filter((k): k is Node => typeof k !== "string");
    const i = kids.indexOf(target);
    if (i >= 0) return { found: true, prev: i > 0 ? kids[i - 1] : null };
    for (const k of kids) {
      const r = search(k);
      if (r.found) return r;
    }
    return { found: false, prev: null };
  };
  return search(root).prev;
}

function find(node: Node, pred: (n: Node) => boolean): Node | null {
  if (pred(node)) return node;
  for (const ch of node.children ?? []) {
    if (typeof ch === "string") continue;
    const hit = find(ch, pred);
    if (hit) return hit;
  }
  return null;
}

const TEAM_SCOPED_VIA = new Set(["multi_reviewer_panel", "multi_reviewer_owner_override"]);
const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const utcMinute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * The section's text, in order, from the stored fixture alone: the owner-approved strings (written out here), the
 * stored result's own sources and counts, and the D-11(A) ceilings for this viewer (transcribed from the S-1b.1 and
 * S-1b.2 route oracles). Null: no section (denied, O6-OBS-5 500).
 */
function expectedSection(c: PageCase): string[] | null {
  const v = c.viewer;
  if (v.denied || c.nullPerModelRow) return null;
  const result = stateOutput(c.state).result as unknown as Record<string, any>;
  const hr = storedHumanReview(v.runKind, c.record);
  const decided = ["approved", "approved_with_conditions", "changes_requested", "rejected"].includes(hr.status as string);
  const lines = ["Provenance and review details", "+", "Recorded evidence and review details"];

  let reviewedAtAllowed: boolean;
  let conditionsAllowed: boolean;
  if (v.page === "INBOX") {
    const identity = hr.reviewerId === REVIEWER || (v.history === "qualifying" && !TEAM_SCOPED_VIA.has(hr.decidedVia as string) && nonEmpty(hr.reviewerId) && nonEmpty(hr.reviewedAt));
    reviewedAtAllowed = identity && nonEmpty(hr.reviewerId) && (!("decidedVia" in hr) || hr.decidedVia === "single_reviewer");
    conditionsAllowed = false;
  } else {
    const personalProven = v.history === "qualifying" && !TEAM_SCOPED_VIA.has(hr.decidedVia as string) && nonEmpty(hr.reviewerId) && nonEmpty(hr.reviewedAt);
    const content = v.page === "W1" || v.key === "p1.owner" || personalProven;
    reviewedAtAllowed = content;
    conditionsAllowed = content;

    lines.push("Sources");
    const listed = Array.isArray(result.sources) ? (result.sources as string[]).filter((x) => x.trim() !== "") : null;
    if (listed === null) lines.push("Unknown");
    else if (listed.length === 0) lines.push("No sources listed");
    else lines.push("Sources listed; not independently verified", ...listed);
    if (Array.isArray(result.assessments) && result.assessments.length > 0) {
      lines.push("Model-assigned strength", "Evidence-strength ratings are assigned by the models and were not independently checked.");
    }
    const m = result.totalModels, k = result.recommendation?.totalModelsWithRecommendation, n = result.recommendation?.supportCount;
    if (isCount(m) && isCount(k) && isCount(n) && k <= m && n <= k) {
      lines.push("Model recommendations", `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}.`, "These counts are not a certainty measure.");
    }
    lines.push("Review status", result.humanReviewNeeded ? "Flagged for human review" : "System did not flag this for human review.");
  }
  if (decided) {
    if (v.page === "INBOX") lines.push("Review status");
    lines.push("Review recorded");
    if (reviewedAtAllowed && typeof hr.reviewedAt === "string") lines.push("Reviewed at", utcMinute(hr.reviewedAt));
    const conds = Array.isArray(hr.conditions) ? (hr.conditions as string[]).filter((x) => x.trim() !== "") : [];
    if (conditionsAllowed && conds.length > 0) lines.push("Review conditions", ...conds);
  }
  lines.push("Use authorization", "Not authorized for use");
  return lines;
}
