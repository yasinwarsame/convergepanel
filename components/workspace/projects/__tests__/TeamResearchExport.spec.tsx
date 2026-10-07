/**
 * TEAM_EXPORT_E3 — the Team research export UI.
 *
 * Stop condition: every export control appears exactly when the corresponding
 * server rule would permit its action; no raw uid is rendered; the Team page
 * never calls a Personal export route.
 *
 * The REAL components render under react-test-renderer; only identity, plan and
 * the network are faked, and every request URL is recorded.
 */

process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";

let mockPlan: string | null = "full";
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "viewer-uid" }, authReady: true }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({ plan: mockPlan, loading: false }) }));
const calls: Array<{ url: string; method: string; body?: unknown }> = [];
let respond: (url: string, method: string) => { ok: boolean; status: number; body?: unknown } = () => ({ ok: true, status: 200, body: {} });
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const r = respond(url, init.method);
    return { ok: r.ok, status: r.status, json: async () => r.body, headers: { get: () => "" }, blob: async () => ({}) };
  },
}));
const saved: string[] = [];
jest.mock("@/components/adaptive/exportHistoryFormat", () => {
  const actual = jest.requireActual("@/components/adaptive/exportHistoryFormat");
  return { ...actual, saveResponseAsDownload: async (_res: unknown, name: string) => void saved.push(name) };
});

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  TEAM_EXPORT_GENERATOR_UNAVAILABLE,
  TeamExportRefreshProvider,
  TeamResearchExportButton,
  TeamResearchExportHistory,
  isTeamExportDownloadable,
  teamExportGeneratorLabel,
} from "@/components/workspace/projects/TeamResearchExport";

const WS = "ws 1";
const RUN = "run/1";
const BASE = `/api/workspaces/${encodeURIComponent(WS)}/runs/${encodeURIComponent(RUN)}`;
const PERSONAL = /\/api\/user\//;
const RAW_UID = "uid-SENTINEL-CREATOR-1234";

const row = (exportId: string, artifactStatus: string, over: Record<string, unknown> = {}) => ({
  exportId,
  reportVersion: Number(exportId.replace(/\D/g, "")) || 1,
  format: "pdf",
  artifactStatus,
  createdAt: "2026-09-02T11:00:00.000Z",
  governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
  generatedBy: { displayName: "Dana Reviewer", maskedEmail: "da***@x.example" },
  ...over,
});

function textOf(r: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(r.toJSON());
}
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props?.["data-testid"] === id && typeof n.type === "string");

async function mount(element: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(TeamExportRefreshProvider, null, element));
  });
  return r;
}
async function openHistory(r: TestRenderer.ReactTestRenderer) {
  const details = byTestId(r, "team-export-history")[0];
  await act(async () => {
    details.props.onToggle({ currentTarget: { open: true } });
  });
}

beforeEach(() => {
  calls.length = 0;
  saved.length = 0;
  mockPlan = "full";
  respond = () => ({ ok: true, status: 200, body: {} });
});

afterEach(() => {
  // The Team page never calls a Personal export route — checked after EVERY test.
  expect(calls.filter((c) => PERSONAL.test(c.url))).toEqual([]);
});

describe("export action — shown exactly when E1 would permit it", () => {
  it.each([
    [true, "full", true],
    [true, "lite", true],
    [true, "free", false],
    [false, "full", false],
    [false, "lite", false],
    [false, "free", false],
  ])("canCreateExport=%s, plan=%s -> button shown: %s", async (canCreateExport, plan, shown) => {
    mockPlan = plan;
    const r = await mount(createElement(TeamResearchExportButton, { workspaceId: WS, runId: RUN, canCreateExport }));
    expect(byTestId(r, "team-export-create")).toHaveLength(shown ? 1 : 0);
  });

  it("posts to the Team E1 route for THIS Workspace and run, with the chosen format", async () => {
    const r = await mount(createElement(TeamResearchExportButton, { workspaceId: WS, runId: RUN, canCreateExport: true }));
    await act(async () => {
      byTestId(r, "team-export-create")[0].props.onClick();
    });
    expect(calls).toEqual([{ url: `${BASE}/export`, method: "POST", body: { format: "pdf" } }]);
    expect(saved).toEqual([`convergepanel-export-${RUN}.pdf`]);
  });

  it("shows the server's refusal message (e.g. plan or capability) instead of a download", async () => {
    respond = () => ({ ok: false, status: 403, body: { ok: false, errorCode: "plan_not_entitled", message: "SERVER-REFUSAL-MESSAGE" } });
    const r = await mount(createElement(TeamResearchExportButton, { workspaceId: WS, runId: RUN, canCreateExport: true }));
    await act(async () => {
      byTestId(r, "team-export-create")[0].props.onClick();
    });
    expect(textOf(r)).toContain("SERVER-REFUSAL-MESSAGE");
    expect(saved).toEqual([]);
  });

  it("a successful export reloads an already-open history", async () => {
    respond = (url) => (url.includes("/exports") ? { ok: true, status: 200, body: { exports: [row("exp-1", "ready")], hasMore: false, nextCursor: null } } : { ok: true, status: 200 });
    const r = await mount(
      createElement("div", null,
        createElement(TeamResearchExportButton, { workspaceId: WS, runId: RUN, canCreateExport: true }),
        createElement(TeamResearchExportHistory, { workspaceId: WS, runId: RUN }))
    );
    await openHistory(r);
    const listCalls = () => calls.filter((c) => c.url.startsWith(`${BASE}/exports`) && c.method === "GET").length;
    expect(listCalls()).toBe(1);
    await act(async () => {
      byTestId(r, "team-export-create")[0].props.onClick();
    });
    expect(listCalls()).toBe(2);
  });
});

describe("history — E2-A for every reader, downloads only where E2-B serves", () => {
  const LIST = [
    row("exp-4", "ready"),
    row("exp-3", "superseded", { generatedBy: { displayName: null, maskedEmail: "ma***@x.example" } }),
    // No frozen generator AND a raw uid present: the only row where a uid fallback could surface.
    row("exp-2", "failed", { generatedBy: undefined, createdBy: RAW_UID }),
    row("exp-1", "generating", { createdBy: RAW_UID }),
  ];

  async function mountHistory() {
    respond = (url, method) =>
      method === "GET" && url === `${BASE}/exports` ? { ok: true, status: 200, body: { exports: LIST, hasMore: false, nextCursor: null } } : { ok: true, status: 200 };
    const r = await mount(createElement(TeamResearchExportHistory, { workspaceId: WS, runId: RUN }));
    return r;
  }

  it("makes no request until opened, then reads only the Team E2-A route", async () => {
    const r = await mountHistory();
    expect(calls).toEqual([]);
    await openHistory(r);
    expect(calls).toEqual([{ url: `${BASE}/exports`, method: "GET", body: undefined }]);
  });

  it("renders a download control only on ready and superseded rows", async () => {
    const r = await mountHistory();
    await openHistory(r);
    const rows = byTestId(r, "team-export-row");
    expect(rows).toHaveLength(4);
    const hasDownload = rows.map((rowNode) => rowNode.findAll((n) => n.props?.["data-testid"] === "team-export-download" && typeof n.type === "string").length);
    expect(hasDownload).toEqual([1, 1, 0, 0]);
  });

  it("a download calls the Team E2-B route for exactly that export", async () => {
    const r = await mountHistory();
    await openHistory(r);
    calls.length = 0;
    await act(async () => {
      byTestId(r, "team-export-download")[1].props.onClick();
    });
    expect(calls).toEqual([{ url: `${BASE}/exports/exp-3`, method: "GET", body: undefined }]);
    expect(saved).toEqual([`convergepanel-export-${RUN}-v3.pdf`]);
  });

  it("a refused download (plan or frozen governance) shows the server's message", async () => {
    const r = await mountHistory();
    await openHistory(r);
    respond = () => ({ ok: false, status: 403, body: { ok: false, errorCode: "governance_state_blocked", message: "DOWNLOAD-REFUSED-MESSAGE" } });
    await act(async () => {
      byTestId(r, "team-export-download")[0].props.onClick();
    });
    expect(textOf(r)).toContain("DOWNLOAD-REFUSED-MESSAGE");
    expect(saved).toEqual([]);
  });

  it("shows the frozen generator (name, then masked email, then 'Not available') and never a uid", async () => {
    const r = await mountHistory();
    await openHistory(r);
    const generators = byTestId(r, "team-export-generator").map((n) => JSON.stringify(n.children));
    expect(generators[0]).toContain("Dana Reviewer");
    expect(generators[1]).toContain("ma***@x.example");
    expect(generators[2]).toContain(TEAM_EXPORT_GENERATOR_UNAVAILABLE);
    expect(textOf(r)).not.toContain(RAW_UID);
  });
});

describe("pure rules", () => {
  it("only ready and superseded are downloadable", () => {
    expect(["ready", "superseded", "failed", "generating", "unknown"].map(isTeamExportDownloadable)).toEqual([true, true, false, false, false]);
  });

  it("generator label never falls back to anything but the neutral label", () => {
    expect(teamExportGeneratorLabel({ generatedBy: { displayName: "  ", maskedEmail: "" } })).toBe(TEAM_EXPORT_GENERATOR_UNAVAILABLE);
    expect(teamExportGeneratorLabel({})).toBe(TEAM_EXPORT_GENERATOR_UNAVAILABLE);
    // A uid smuggled alongside a missing generatedBy is never used.
    expect(teamExportGeneratorLabel({ createdBy: RAW_UID } as never)).toBe(TEAM_EXPORT_GENERATOR_UNAVAILABLE);
  });
});

describe("export feature flag off", () => {
  it("renders neither the action nor the history", async () => {
    await jest.isolateModulesAsync(async () => {
      process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "false";
      // React and the renderer are loaded INSIDE the isolated registry too, so the
      // component and the renderer share one React instance.
      const React = await import("react");
      const TR = (await import("react-test-renderer")).default;
      const mod = await import("@/components/workspace/projects/TeamResearchExport");
      let r!: TestRenderer.ReactTestRenderer;
      await TR.act(async () => {
        r = TR.create(
          React.createElement(mod.TeamExportRefreshProvider, null,
            React.createElement(mod.TeamResearchExportButton, { workspaceId: WS, runId: RUN, canCreateExport: true }),
            React.createElement(mod.TeamResearchExportHistory, { workspaceId: WS, runId: RUN }))
        );
      });
      expect(r.toJSON()).toBeNull();
      process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED = "true";
    });
  });
});
