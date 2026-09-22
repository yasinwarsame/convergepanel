/**
 * F3 — a Personal assignee must not commit a competing terminal decision
 * while an independently governed legacy Team panel owns the review.
 *
 * The Team decision route has always gated on this; the Personal route never
 * read the panel at all. Measured on the pre-fix baseline: HTTP 200, panel
 * getter called 0 times, `submitAdaptiveHumanReview` committed — the Team
 * panel silently pre-empted and unable to finalize afterwards.
 *
 * The guard lives INSIDE `submitAdaptiveHumanReview`'s transaction rather
 * than only at the route, because a route precheck is not race-free here and
 * the asymmetry is real: `submitAdaptiveHumanReviewPanel` reads the RUN doc
 * in its own transaction and refuses `not_pending` once a review is terminal,
 * so panel creation was already protected against a racing decision — while
 * the decision transaction read only the run doc and was not protected
 * against a racing panel creation.
 *
 * These are route-level tests; the transaction-level state contract is
 * covered in `lib/firestore/__tests__/adaptiveHumanReviewPersistence.spec.ts`.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedCreateHistory = jest.fn();
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  ...jest.requireActual("@/lib/firestore/runs"),
  createAdaptiveHumanReviewHistoryEntry: (...a: any[]) => mockedCreateHistory(...a),
  getAdaptiveHumanReviewAssignment: (...a: any[]) => mockedGetAssignment(...a),
}));
const mockedAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({ writeAdaptiveAdminAuditEvent: (...a: any[]) => mockedAudit(...a) }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: jest.fn().mockResolvedValue(null) }));

/** Real transaction semantics over in-memory stores — the guard must be exercised, not stubbed. */
let runDocs = new Map<string, any>();
let panelDocs = new Map<string, any>();
let canonicalWrites = 0;

function makeRef(name: string, id: string): any {
  return {
    id,
    __path: `${name}/${id}`,
    get: async () => (name === "users" ? { data: () => ({ name: "P" }) } : { exists: runDocs.has(id), data: () => runDocs.get(id) }),
    collection: (sub: string) => ({
      doc: (subId: string) => ({ id: subId, __path: `${name}/${id}/${sub}/${subId}` }),
    }),
  };
}
const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => makeRef(name, id) }),
  runTransaction: async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: any) => {
        const parts = String(ref.__path).split("/");
        if (parts.length === 4 && parts[2] === "humanReviewPanel") {
          return { exists: panelDocs.has(parts[1]), data: () => panelDocs.get(parts[1]) };
        }
        return { exists: runDocs.has(ref.id), data: () => runDocs.get(ref.id) };
      },
      update: (ref: any, fields: Record<string, unknown>) => {
        canonicalWrites += 1;
        const doc = runDocs.get(ref.id)!;
        for (const [k, v] of Object.entries(fields)) {
          const path = k.split(".");
          let t = doc;
          for (const seg of path.slice(0, -1)) t = t[seg];
          t[path[path.length - 1]] = v;
        }
      },
    };
    return fn(txn);
  },
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));

import { POST } from "@/app/api/user/runs/[runId]/decision/route";
import { NextRequest } from "next/server";

const RUN = "run-legacy-1", OWNER = "owner-uid", P = "personal-reviewer-uid";
const UPDATED_AT = "2026-08-01T00:00:00.000Z";

function panel(status: string, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, kind: "adaptive_review_panel", teamId: "team-SECRET", runId: RUN,
    mode: "majority_quorum", reviewerUserIds: ["A", "B", "C"], requiredReviewerCount: 3, quorum: 2,
    status, revision: 1, createdAt: UPDATED_AT, createdByUserId: "admin", updatedAt: UPDATED_AT, updatedByUserId: "admin",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  runDocs = new Map();
  panelDocs = new Map();
  canonicalWrites = 0;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: P });
  runDocs.set(RUN, {
    userId: OWNER, question: "q",
    governanceRecord: {
      version: 1, schemaId: "decision_support", answerShape: "decision_support_view", adaptiveOutputVersion: 1,
      humanReview: { status: "unreviewed" },
      decisionReceipt: { conclusion: "C", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: false },
      createdAt: UPDATED_AT, updatedAt: UPDATED_AT,
    },
  });
  mockedGetAssignment.mockResolvedValue({
    status: "found",
    assignment: { version: 1, runId: RUN, teamId: null, assignedReviewerUserId: P, assignedByUserId: OWNER, assignedAt: UPDATED_AT, revision: 1 },
  });
  mockedCreateHistory.mockResolvedValue({ status: "created" });
  mockedAudit.mockResolvedValue({ status: "written" });
});

const submit = async () => {
  const req = new NextRequest(`http://localhost/api/user/runs/${RUN}/decision`, {
    method: "POST",
    body: JSON.stringify({ status: "approved", expectedUpdatedAt: UPDATED_AT }),
    headers: { "content-type": "application/json" },
  });
  const res = await POST(req, { params: { runId: RUN } } as any);
  return { status: res.status, body: await res.json() };
};

const canonicalStatus = () => runDocs.get(RUN)?.governanceRecord?.humanReview?.status;

describe("F3-A — no panel: the Personal decision path is untouched (anti-overrestriction control)", () => {
  it("commits exactly as before", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(canonicalWrites).toBe(1);
    expect(canonicalStatus()).toBe("approved");
  });
});

describe("F3-B — an OPEN Team panel blocks the Personal decision", () => {
  beforeEach(() => panelDocs.set(RUN, panel("open")));

  it("is refused with the Team route's own established contract", async () => {
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("adaptive_review_panel_active");
  });

  it("ZERO side effects — no canonical write, no history, no audit", async () => {
    await submit();
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
    expect(mockedCreateHistory).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("does not leak the panel's team, reviewers or shape in the refusal", async () => {
    const r = await submit();
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("team-SECRET");
    for (const uid of ["A", "B", "C"]) expect(s).not.toContain(`"${uid}"`);
  });
});

describe("F3-C — panel states that do NOT own the decision", () => {
  it.each(["cancelled", "finalized"])("a %s panel restores the single-reviewer path", async (status) => {
    panelDocs.set(RUN, status === "finalized"
      ? panel("finalized", { finalizedAt: UPDATED_AT, finalizedByUserId: "admin", finalStatus: "approved", finalDecisionId: "dec_x", aggregationPolicyVersion: 1 })
      : panel("cancelled"));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(canonicalWrites).toBe(1);
  });
});

describe("F3-D — malformed/ambiguous panel state fails CLOSED", () => {
  it.each([
    ["a malformed body", { kind: "adaptive_review_panel", schemaVersion: 1, status: "open" }],
    ["an unsupported version", { ...panel("open"), schemaVersion: 99 }],
    ["a non-object body", "nope"],
  ])("refuses on %s rather than treating it as no panel", async (_label, body) => {
    panelDocs.set(RUN, body as any);
    const r = await submit();
    expect(r.status).toBe(409);
    expect(["adaptive_review_panel_invalid", "adaptive_review_panel_active"]).toContain(r.body.error.code);
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
  });
});

describe("§7 — the guard does not depend on the creation rollout flag", () => {
  it("an existing OPEN panel blocks identically with MULTI_REVIEWER_GOVERNANCE_ENABLED false and true", async () => {
    panelDocs.set(RUN, panel("open"));
    const whenFalse = await submit();
    jest.replaceProperty(require("@/lib/env"), "MULTI_REVIEWER_GOVERNANCE_ENABLED", true as never);
    canonicalWrites = 0;
    const whenTrue = await submit();
    expect(whenTrue).toEqual(whenFalse);
    expect(whenTrue.status).toBe(409);
    expect(canonicalWrites).toBe(0);
  });

  it("neither the decision route nor the shared mutation consults the flag", () => {
    const fs = require("fs");
    expect(fs.readFileSync("app/api/user/runs/[runId]/decision/route.ts", "utf8")).not.toContain("MULTI_REVIEWER_GOVERNANCE_ENABLED");
    expect(fs.readFileSync("lib/firestore/runs.ts", "utf8")).not.toContain("MULTI_REVIEWER_GOVERNANCE_ENABLED");
  });
});

describe("§8 — the guard is inside the transaction, which is what closes the race", () => {
  it("a panel that appears AFTER any route-level precheck still blocks the commit", async () => {
    // The panel is absent when the request starts and is created before the
    // transaction reads it. A route-level precheck would have passed; the
    // in-transaction read does not.
    let installed = false;
    const original = mockAdminDb.runTransaction;
    mockAdminDb.runTransaction = async (fn: any) => {
      if (!installed) {
        installed = true;
        panelDocs.set(RUN, panel("open")); // concurrent actor wins the gap
      }
      return original(fn);
    };
    try {
      const r = await submit();
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("adaptive_review_panel_active");
      expect(canonicalWrites).toBe(0);
    } finally {
      mockAdminDb.runTransaction = original;
    }
  });

  it("the panel document is read through the SAME transaction as the run document", async () => {
    panelDocs.set(RUN, panel("open"));
    const seen: string[] = [];
    const original = mockAdminDb.runTransaction;
    mockAdminDb.runTransaction = async (fn: any) =>
      original(async (txn: any) => fn({ ...txn, get: async (ref: any) => { seen.push(String(ref.__path)); return txn.get(ref); } }));
    try {
      await submit();
      expect(seen).toContain(`runs/${RUN}`);
      expect(seen).toContain(`runs/${RUN}/humanReviewPanel/current`);
    } finally {
      mockAdminDb.runTransaction = original;
    }
  });
});
