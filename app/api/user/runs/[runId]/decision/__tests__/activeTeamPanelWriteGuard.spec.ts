/**
 * F3 — a Personal assignee must not commit a terminal decision while a
 * blocking legacy Team panel owns the review.
 *
 * WHAT THIS FILE PROVES, AND WHERE THE REST OF THE ARGUMENT LIVES.
 *
 * These are route-level tests over the REAL `submitAdaptiveHumanReview` and
 * the REAL Personal decision handler, on in-memory stores. They establish
 * observable behaviour (which states block, which proceed, what the caller is
 * told, what side effects occur) and one STRUCTURAL fact: the transaction that
 * performs the canonical write reads both the run and the panel before writing.
 *
 * They do NOT simulate Firestore. An earlier version of this file carried a
 * bespoke emulator with document versions, conflict detection, retry
 * scheduling and buffered commits, and claimed to demonstrate serializability.
 * Five review rounds found no defect in the production guard and eleven
 * defects in that scaffolding — false impossibility claims, vacuous
 * assertions, and mutations that died incidentally. It was increasing proof
 * risk without reducing production risk, so it is gone.
 *
 * The concurrency argument is FIRESTORE TRANSACTION SEMANTIC REASONING, not
 * something Jest demonstrates here:
 *
 *   1. the canonical decision write happens inside a Firestore transaction;
 *   2. that transaction reads `runs/{runId}/humanReviewPanel/current` before
 *      writing — proven structurally below;
 *   3. the panel document is therefore in that transaction's read set;
 *   4. Firestore applies its conflict/locking semantics to documents in the
 *      read set, including one read as non-existent and subsequently created;
 *   5. so a panel created between the read and the commit cannot be missed by
 *      the committing transaction.
 *
 * Step 2 is what this file pins. Steps 3–5 are properties of Firestore, cited
 * in the PR evidence, and are not claimed to be reproduced by this harness.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedCreateHistory = jest.fn();
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  ...jest.requireActual("@/lib/firestore/runs"),
  // Must be the EXACT symbol the route imports. An earlier version mocked
  // `createAdaptiveHumanReviewHistoryEntry`, which does not exist in this
  // module; the real writer ran, the mock had zero call sites, and the
  // "no history on refusal" assertion could never fail. The positive controls
  // in §25 pin that this mock is live.
  createAdaptiveHumanReviewHistory: (...a: any[]) => mockedCreateHistory(...a),
  getAdaptiveHumanReviewAssignment: (...a: any[]) => mockedGetAssignment(...a),
}));
const mockedAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({ writeAdaptiveAdminAuditEvent: (...a: any[]) => mockedAudit(...a) }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: jest.fn().mockResolvedValue(null) }));

/**
 * A minimal path-aware transaction spy. Single-shot: the callback runs once,
 * reads are served from explicit stores, writes are applied. It records the
 * ORDERED operations of that one transaction, which is all the structural
 * proof needs. No versions, no conflicts, no retries.
 */
type TxnOp = { kind: "read" | "write"; path: string };
let ops: TxnOp[] = [];
let canonicalWrites = 0;
let runDocs = new Map<string, any>();
let panelDocs = new Map<string, any>();

const readsOf = () => ops.filter((o) => o.kind === "read").map((o) => o.path);
const firstWriteIndex = () => ops.findIndex((o) => o.kind === "write");
const lastReadIndexOf = (path: string) => ops.reduce((acc, o, i) => (o.kind === "read" && o.path === path ? i : acc), -1);

function readPath(path: string): { exists: boolean; data: () => any } {
  const parts = path.split("/");
  if (parts.length === 4 && parts[2] === "humanReviewPanel") {
    const rid = parts[1];
    return { exists: panelDocs.has(rid), data: () => panelDocs.get(rid) };
  }
  if (parts.length === 2 && parts[0] === "runs") {
    const rid = parts[1];
    return { exists: runDocs.has(rid), data: () => runDocs.get(rid) };
  }
  // An unconfigured path must fail loudly. A fallback to run data is how an
  // earlier fake made security assertions pass for the wrong reason.
  throw new Error(`test fake: unconfigured document path "${path}"`);
}

function makeRef(name: string, id: string): any {
  return {
    id,
    __path: `${name}/${id}`,
    get: async () => (name === "users" ? { data: () => ({ name: "P" }) } : readPath(`${name}/${id}`)),
    collection: (sub: string) => ({ doc: (subId: string) => ({ id: subId, __path: `${name}/${id}/${sub}/${subId}` }) }),
  };
}

const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => makeRef(name, id) }),
  runTransaction: async (fn: (txn: any) => Promise<any>) => {
    const txn = {
      get: async (ref: any) => {
        const path = String(ref.__path);
        ops.push({ kind: "read", path });
        return readPath(path);
      },
      update: (ref: any, fields: Record<string, unknown>) => {
        ops.push({ kind: "write", path: String(ref.__path) });
        canonicalWrites += 1;
        const doc = runDocs.get(ref.id)!;
        for (const [k, v] of Object.entries(fields)) {
          const seg = k.split(".");
          let t = doc;
          for (const x of seg.slice(0, -1)) t = t[x];
          t[seg[seg.length - 1]] = v;
        }
      },
    };
    return fn(txn);
  },
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));

import { POST } from "@/app/api/user/runs/[runId]/decision/route";
import { NextRequest } from "next/server";
const actualRuns = jest.requireActual("@/lib/firestore/runs");

const RUN = "run-legacy-1", OWNER = "owner-uid", P = "personal-reviewer-uid";
const UPDATED_AT = "2026-08-01T00:00:00.000Z";
const RUN_PATH = `runs/${RUN}`;
const PANEL_PATH = `runs/${RUN}/humanReviewPanel/current`;

const NEUTRAL = {
  status: 409,
  code: "decision_unavailable",
  message: "This review is not currently available for a direct decision. Please refresh and try again.",
};

function panel(status: string, over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, kind: "adaptive_review_panel", teamId: "team-SECRET", runId: RUN,
    mode: "majority_quorum", reviewerUserIds: ["A", "B", "C"], requiredReviewerCount: 3, quorum: 2,
    status, revision: 1, createdAt: UPDATED_AT, createdByUserId: "admin", updatedAt: UPDATED_AT, updatedByUserId: "admin",
    ...over,
  };
}
const finalizedPanel = () =>
  panel("finalized", { finalizedAt: UPDATED_AT, finalizedByUserId: "admin", finalStatus: "approved", finalDecisionId: "dec_x", aggregationPolicyVersion: 1 });

beforeEach(() => {
  jest.clearAllMocks();
  ops = [];
  canonicalWrites = 0;
  runDocs = new Map();
  panelDocs = new Map();
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

describe("STRUCTURAL — the committing transaction reads run + panel before it writes", () => {
  // The single fact this harness pins for the concurrency argument. Steps 3-5
  // of that argument (read-set conflict semantics) are Firestore properties
  // cited in the PR evidence, not simulated here.
  it("both required reads are present, and both precede the first write", async () => {
    const r = await submit();
    expect(r.status).toBe(200);

    // Presence asserted SEPARATELY from ordering: `lastReadIndexOf` returns -1
    // for a path never read, and `-1 < w` is trivially true, so the ordering
    // comparison alone would be satisfied by "the panel was never read".
    const runAt = lastReadIndexOf(RUN_PATH);
    const panelAt = lastReadIndexOf(PANEL_PATH);
    const w = firstWriteIndex();
    expect(runAt).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(-1);
    expect(w).toBeGreaterThan(-1);
    expect(runAt).toBeLessThan(w);
    expect(panelAt).toBeLessThan(w);
  });

  it("the panel is read through the transaction, not by a separate non-transactional read", async () => {
    await submit();
    expect(readsOf()).toContain(PANEL_PATH);
  });

  it("HARNESS FIDELITY: an unconfigured path throws instead of resolving to the run document", () => {
    expect(() => readPath("runs/other/humanReviewVotes/x")).toThrow(/unconfigured document path/);
  });
});

describe("F3-A — no panel: the Personal decision path is untouched", () => {
  it("commits exactly once and reports success", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(canonicalWrites).toBe(1);
    expect(canonicalStatus()).toBe("approved");
  });
});

describe("F3-B — an OPEN Team panel blocks the Personal decision", () => {
  beforeEach(() => panelDocs.set(RUN, panel("open")));

  it("is refused with the NEUTRAL Personal contract — the cause is not named to this caller", async () => {
    const r = await submit();
    expect({ status: r.status, code: r.body.error.code, message: r.body.error.message }).toEqual(NEUTRAL);
  });

  it("ZERO side effects — no canonical write, no history, no audit", async () => {
    await submit();
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
    expect(mockedCreateHistory).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("leaves the panel document untouched", async () => {
    await submit();
    expect(panelDocs.get(RUN)).toEqual(panel("open"));
    expect(ops.filter((o) => o.kind === "write").map((o) => o.path)).not.toContain(PANEL_PATH);
  });

  it("does not leak the panel's team, reviewers or shape in the refusal", async () => {
    const r = await submit();
    const s = JSON.stringify(r.body);
    expect(s).not.toContain("team-SECRET");
    for (const uid of ["A", "B", "C"]) expect(s).not.toContain(`"${uid}"`);
  });
});

describe("F3-C — panel states that do NOT own the decision", () => {
  it("a cancelled panel restores the single-reviewer path", async () => {
    panelDocs.set(RUN, panel("cancelled"));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(canonicalWrites).toBe(1);
    expect(canonicalStatus()).toBe("approved");
  });

  /**
   * A finalized panel can legitimately coexist with a pending review: panel
   * finalization accepts `changes_requested` as a final status, and
   * `lib/workspaces/resubmitWorkspaceReview.ts` moves that review back to
   * `unreviewed` without reopening or mutating the panel (its own header
   * states it never writes `humanReviewPanel/current`). Proceeding is correct
   * — a finalized panel can never reopen or accept votes.
   *
   * An earlier version of this file called the pairing writer-unreachable and,
   * on that false premise, replaced this strong assertion with
   * `not.toBe("decision_unavailable")`, which would also pass on a 500.
   */
  it("a finalized panel + pending review is ALLOWED, and commits exactly once", async () => {
    panelDocs.set(RUN, finalizedPanel());
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(canonicalWrites).toBe(1);
    expect(canonicalStatus()).toBe("approved");
    expect(mockedCreateHistory).toHaveBeenCalled();
  });

  it("a finalized panel on an ALREADY-terminal review is refused upstream by the terminal check, not the panel gate", async () => {
    panelDocs.set(RUN, finalizedPanel());
    runDocs.get(RUN)!.governanceRecord.humanReview = { status: "approved", reviewerId: "admin", reviewedAt: UPDATED_AT, decidedVia: "multi_reviewer_panel" };
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("terminal_review_exists");
    expect(canonicalWrites).toBe(0);
  });
});

describe("F3-D — malformed/ambiguous panel state fails CLOSED", () => {
  it.each([
    ["a malformed body", { kind: "adaptive_review_panel", schemaVersion: 1, status: "open" }],
    ["an unsupported version", { ...panel("open"), schemaVersion: 99 }],
    ["a non-object body", "nope"],
    ["a panel whose stored runId disagrees with its own path", panel("cancelled", { runId: "some-other-run" })],
  ])("refuses on %s with the same NEUTRAL contract", async (_label, body) => {
    panelDocs.set(RUN, body as any);
    const r = await submit();
    expect({ status: r.status, code: r.body.error.code, message: r.body.error.message }).toEqual(NEUTRAL);
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
  });
});

describe("F4 — the panel's path/field binding is load-bearing", () => {
  it("a panel at this run's path claiming another runId fails closed", async () => {
    panelDocs.set(RUN, panel("cancelled", { runId: "run-SOMEWHERE-ELSE" }));
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("decision_unavailable");
    expect(canonicalWrites).toBe(0);
  });

  it("the same body at its OWN run's path parses fine — isolating the binding as the cause", async () => {
    panelDocs.set(RUN, panel("cancelled"));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(canonicalWrites).toBe(1);
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

/**
 * §25 — the side-effect mocks are live.
 *
 * Every zero-call assertion above is only meaningful if the mocked symbol is
 * the one production actually invokes. These drive the ALLOWED path and assert
 * each mock IS called there, which is what makes the refusal-path zero-call
 * assertions falsifiable.
 */
describe("§25 — the side-effect mocks are live", () => {
  it("the history writer mock is invoked on the allowed path", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(mockedCreateHistory).toHaveBeenCalled();
  });

  it("the admin-audit mock is invoked on the allowed path", async () => {
    await submit();
    expect(mockedAudit).toHaveBeenCalled();
  });

  it("the assignment reader mock is invoked", async () => {
    await submit();
    expect(mockedGetAssignment).toHaveBeenCalled();
  });
});

describe("§16 — the Personal refusal does not name Team state", () => {
  // PR #188 removed this class of signal from the Personal READ surfaces —
  // `viewerMayReadReviewPanel` is owner-only and `decidedVia`'s panel values
  // are suppressed there as a provenance oracle. An error code is the same
  // oracle by another route, so the WRITE refusal is neutral too.
  it("active and malformed produce an identical response to this caller", async () => {
    panelDocs.set(RUN, panel("open"));
    const o1 = await submit();

    jest.clearAllMocks();
    runDocs.get(RUN)!.governanceRecord.humanReview = { status: "unreviewed" };
    canonicalWrites = 0;
    panelDocs.set(RUN, { kind: "adaptive_review_panel", schemaVersion: 1, status: "open" } as any);
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: P });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: { version: 1, runId: RUN, teamId: null, assignedReviewerUserId: P, assignedByUserId: OWNER, assignedAt: UPDATED_AT, revision: 1 },
    });
    const o2 = await submit();

    expect(o2).toEqual(o1);
    expect(JSON.stringify(o1)).not.toMatch(/panel|team|multi_reviewer/i);
  });
});

describe("§18 — the INTERNAL gate still distinguishes active from invalid", () => {
  // Neutralising the API must not collapse the classification itself.
  const submitDirect = async () =>
    actualRuns.submitAdaptiveHumanReview({
      runId: RUN,
      update: { status: "approved" } as any,
      reviewerId: P,
      expectedUpdatedAt: UPDATED_AT,
    });

  it("an OPEN panel yields exactly adaptive_review_panel_active", async () => {
    panelDocs.set(RUN, panel("open"));
    await expect(submitDirect()).resolves.toEqual({ ok: false, reason: "adaptive_review_panel_active" });
  });

  it("a malformed panel yields exactly adaptive_review_panel_invalid", async () => {
    panelDocs.set(RUN, { kind: "adaptive_review_panel", schemaVersion: 1, status: "open" } as any);
    await expect(submitDirect()).resolves.toEqual({ ok: false, reason: "adaptive_review_panel_invalid" });
  });

  it("a runId/path mismatch yields exactly adaptive_review_panel_invalid", async () => {
    panelDocs.set(RUN, panel("cancelled", { runId: "run-SOMEWHERE-ELSE" }));
    await expect(submitDirect()).resolves.toEqual({ ok: false, reason: "adaptive_review_panel_invalid" });
  });
});
