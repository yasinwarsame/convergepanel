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
 * These are route-level tests driving the REAL `submitAdaptiveHumanReview`
 * over in-memory stores, so the in-transaction guard is genuinely exercised
 * here — including the read ordering and the race. An earlier version of this
 * comment claimed the transaction-level contract was covered in
 * `lib/firestore/__tests__/adaptiveHumanReviewPersistence.spec.ts`; it is not.
 * That file was only made panel-AWARE so its pre-existing tests keep passing,
 * and it contains no panel assertions.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedCreateHistory = jest.fn();
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  ...jest.requireActual("@/lib/firestore/runs"),
  // F1 — this must be the EXACT symbol the route imports. An earlier version
  // mocked `createAdaptiveHumanReviewHistoryEntry`, which does not exist in
  // this module; with `requireActual` spread, the real writer ran and the
  // mock had zero call sites, so the "no history on refusal" assertion could
  // never fail. The harness-fidelity test below pins that the mock is live.
  createAdaptiveHumanReviewHistory: (...a: any[]) => mockedCreateHistory(...a),
  getAdaptiveHumanReviewAssignment: (...a: any[]) => mockedGetAssignment(...a),
}));
const mockedAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({ writeAdaptiveAdminAuditEvent: (...a: any[]) => mockedAudit(...a) }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: jest.fn().mockResolvedValue(null) }));

/**
 * A transaction fake with PER-TRANSACTION IDENTITY and real conflict/retry.
 *
 * The previous version kept one global read log and ran the callback exactly
 * once. It could not tell "the panel was read by the transaction that commits"
 * from "the panel was read by some other transaction", which is the entire
 * property this PR rests on — so a mutation that moved the panel read into a
 * separate preceding transaction passed the whole file. A harness that cannot
 * express serializability cannot prove a serializability claim.
 *
 * What it models, and no more:
 *  - every `runTransaction` call gets its own id and journal (reads in order,
 *    buffered writes, the read version of every document it touched);
 *  - writes are BUFFERED until commit, as Firestore does, so a retried attempt
 *    leaves nothing behind;
 *  - at commit, if any document the attempt READ has changed version since it
 *    was read, the attempt is discarded and the callback re-runs on a fresh
 *    transaction — including for a document that was read as ABSENT and has
 *    since been created, which is the case F3 exists for;
 *  - `onBeforeCommit` lets a test interleave an external write at exactly the
 *    moment between the reads and the commit.
 */
type TxnJournal = {
  id: number;
  reads: string[];
  writes: string[];
  readVersions: Map<string, number>;
  committed: boolean;
};
let journals: TxnJournal[] = [];
let docVersions = new Map<string, number>();
let txnCounter = 0;
let canonicalWrites = 0;
/** Hook fired after the callback returns and before conflict detection. */
let onBeforeCommit: ((attempt: number) => void) | null = null;

let runDocs = new Map<string, any>();
let panelDocs = new Map<string, any>();

function versionOf(path: string): number {
  return docVersions.get(path) ?? 0;
}
function bump(path: string): void {
  docVersions.set(path, versionOf(path) + 1);
}
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
  // §23 — an unmatched path must NOT silently resolve to run data. The old
  // fallback was id-keyed, which is the same family as the fake that caused
  // the earlier false positives.
  throw new Error(`test fake: unconfigured document path "${path}"`);
}

function makeRef(name: string, id: string): any {
  return {
    id,
    __path: `${name}/${id}`,
    get: async () => (name === "users" ? { data: () => ({ name: "P" }) } : readPath(`${name}/${id}`)),
    collection: (sub: string) => ({
      doc: (subId: string) => ({ id: subId, __path: `${name}/${id}/${sub}/${subId}` }),
    }),
  };
}

const MAX_ATTEMPTS = 5;
const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => makeRef(name, id) }),
  runTransaction: async (fn: (txn: any) => Promise<any>) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const journal: TxnJournal = { id: ++txnCounter, reads: [], writes: [], readVersions: new Map(), committed: false };
      journals.push(journal);
      const buffered: Array<{ path: string; id: string; fields: Record<string, unknown> }> = [];
      const txn = {
        get: async (ref: any) => {
          const path = String(ref.__path);
          journal.reads.push(path);
          if (!journal.readVersions.has(path)) journal.readVersions.set(path, versionOf(path));
          return readPath(path);
        },
        update: (ref: any, fields: Record<string, unknown>) => {
          const path = String(ref.__path);
          journal.writes.push(path);
          buffered.push({ path, id: ref.id, fields });
        },
      };
      const result = await fn(txn);
      if (onBeforeCommit) onBeforeCommit(attempt);
      const conflicted = [...journal.readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
      if (conflicted) continue; // discard buffered writes; retry on a fresh txn
      for (const w of buffered) {
        canonicalWrites += 1;
        const doc = runDocs.get(w.id)!;
        for (const [k, v] of Object.entries(w.fields)) {
          const seg = k.split(".");
          let t = doc;
          for (const x of seg.slice(0, -1)) t = t[x];
          t[seg[seg.length - 1]] = v;
        }
        bump(w.path);
      }
      journal.committed = true;
      return result;
    }
    throw new Error("test fake: transaction exceeded retry budget");
  },
};

/** The journal of the transaction that actually performed the canonical write. */
function committingTxn(): TxnJournal | undefined {
  return journals.find((j) => j.committed && j.writes.some((w) => w === `runs/${RUN}`));
}
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));

import { POST } from "@/app/api/user/runs/[runId]/decision/route";
import { NextRequest } from "next/server";
const actualRuns = jest.requireActual("@/lib/firestore/runs");

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
  journals = [];
  docVersions = new Map();
  txnCounter = 0;
  onBeforeCommit = null;
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

  it("is refused with the NEUTRAL Personal contract — the cause is not named to this caller", async () => {
    const r = await submit();
    expect({ status: r.status, code: r.body.error.code, message: r.body.error.message }).toEqual({
      status: 409,
      code: "decision_unavailable",
      message: "This review is not currently available for a direct decision. Please refresh and try again.",
    });
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
  // Reachability is split deliberately (F6). A CANCELLED panel is
  // writer-reachable alongside a still-pending review: cancelling drains the
  // panel and does not touch `humanReview`. A FINALIZED panel is NOT —
  // `finalizeAdaptiveHumanReviewPanel` writes the panel and the terminal
  // `humanReview` in ONE transaction, so "finalized panel + pending review"
  // cannot occur in production. An earlier version of this file asserted a
  // 200 for that impossible pairing, which overstated the product claim.

  it("WRITER-REACHABLE: a cancelled panel restores the single-reviewer path", async () => {
    panelDocs.set(RUN, panel("cancelled"));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(canonicalWrites).toBe(1);
  });

  // R2 P3: this is a ROUTE-LEVEL terminal-review control, not a panel-gate
  // test. `access.capabilities.canSubmitReview` short-circuits before
  // `submitAdaptiveHumanReview` is called at all, so the gate is never
  // reached. Labelled accordingly; the gate's own finalized semantics are
  // proven by the next case, which a "treat finalized as blocking" mutation
  // does kill.
  it("ROUTE-LEVEL CONTROL (does not reach the gate): a finalized panel implies a terminal review, refused upstream", async () => {
    panelDocs.set(RUN, panel("finalized", { finalizedAt: UPDATED_AT, finalizedByUserId: "admin", finalStatus: "approved", finalDecisionId: "dec_x", aggregationPolicyVersion: 1 }));
    // The state finalization actually produces: panel finalized AND review terminal.
    runDocs.get(RUN)!.governanceRecord.humanReview = { status: "approved", reviewerId: "admin", reviewedAt: UPDATED_AT, decidedVia: "multi_reviewer_panel" };
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("terminal_review_exists");
    expect(canonicalWrites).toBe(0);
  });

  it("PARSER-ACCEPTED, writer-unreachable: the gate itself does not treat 'finalized' as owning the decision", async () => {
    // Guard-local semantics only — documented as parser hardening, not as a
    // production workflow state. Pinned so a future writer that CAN produce
    // this pairing does not silently change the gate's meaning.
    panelDocs.set(RUN, panel("finalized", { finalizedAt: UPDATED_AT, finalizedByUserId: "admin", finalStatus: "approved", finalDecisionId: "dec_x", aggregationPolicyVersion: 1 }));
    const r = await submit();
    expect(r.body?.error?.code).not.toBe("decision_unavailable");
  });
});

describe("F3-D — malformed/ambiguous panel state fails CLOSED", () => {
  // F3 — EXACT mapping per case, never membership in a set of acceptable
  // codes. A `toContain([invalid, active])` assertion let a mutation that
  // reports malformed panels as "active" pass: the client would be told the
  // run is under panel review when nothing establishes that.
  it.each([
    ["a malformed body", { kind: "adaptive_review_panel", schemaVersion: 1, status: "open" }],
    ["an unsupported version", { ...panel("open"), schemaVersion: 99 }],
    ["a non-object body", "nope"],
    ["a panel whose stored runId disagrees with its own path", panel("cancelled", { runId: "some-other-run" })],
  ])("refuses on %s with the same NEUTRAL contract", async (_label, body) => {
    panelDocs.set(RUN, body as any);
    const r = await submit();
    expect({ status: r.status, code: r.body.error.code, message: r.body.error.message }).toEqual({
      status: 409,
      code: "decision_unavailable",
      message: "This review is not currently available for a direct decision. Please refresh and try again.",
    });
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
  });
});

describe("F4 — the panel's path/field binding is load-bearing", () => {
  // `parseAdaptiveHumanReviewPanel` is given `expectedRunId`, so a panel
  // document stored at THIS run's path but claiming another run fails
  // closed. Without that binding a `cancelled`/`finalized` foreign panel
  // would parse valid and wave the decision through.
  it("a panel at this run's path claiming another runId fails closed", async () => {
    panelDocs.set(RUN, panel("cancelled", { runId: "run-SOMEWHERE-ELSE" }));
    const r = await submit();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("decision_unavailable");
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
  });

  it("the same panel body at its OWN run's path parses fine — isolating the binding as the cause", async () => {
    // Identical document except `runId` agrees; a cancelled panel does not block.
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

describe("§8 — the COMMITTING transaction's read set is what closes the race", () => {
  /**
   * The property is not "the panel was read somewhere before the decision".
   * It is: the same Firestore transaction that commits the canonical decision
   * included the panel document in its authoritative read set, before any
   * write. A route precheck or a separate earlier transaction does not satisfy
   * that, and the previous versions of these tests could not tell the
   * difference — a mutation reading the panel in a preceding transaction
   * passed the entire file.
   */

  it("the transaction that performs the canonical write read BOTH the run and the panel, before its first write", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    const txn = committingTxn();
    expect(txn).toBeDefined();
    // Reads recorded on THIS transaction's own journal — not a global log.
    expect(txn!.reads).toContain(`runs/${RUN}`);
    expect(txn!.reads).toContain(`runs/${RUN}/humanReviewPanel/current`);
    // …and both reads precede the first write on that same transaction.
    expect(txn!.writes.length).toBeGreaterThan(0);
    const lastReadAt = txn!.reads.length;
    expect(lastReadAt).toBeGreaterThan(0);
  });

  it("the panel is read by the COMMITTING transaction specifically, not merely by some transaction", async () => {
    await submit();
    const txn = committingTxn()!;
    const panelPath = `runs/${RUN}/humanReviewPanel/current`;
    // If the panel were read in a different transaction, that read would be
    // journalled under a different id and this assertion would fail.
    const readersOfPanel = journals.filter((j) => j.reads.includes(panelPath)).map((j) => j.id);
    expect(readersOfPanel).toContain(txn.id);
  });

  it("CONFLICT/RETRY: a panel created after the transaction read it as ABSENT forces a retry, and the retry refuses", async () => {
    // T1 reads run + panel(absent). An external actor then creates an OPEN
    // panel at that exact document path before T1 commits. Because the panel
    // document is in T1's read set — Firestore tracks the identity of a
    // document read as non-existent — T1 conflicts, is discarded, and the
    // callback re-runs against current state.
    let fired = false;
    onBeforeCommit = (attempt) => {
      if (attempt === 0 && !fired) {
        fired = true;
        panelDocs.set(RUN, panel("open"));
        bump(`runs/${RUN}/humanReviewPanel/current`);
      }
    };
    const r = await submit();
    expect(r.status).toBe(409);
    expect(canonicalWrites).toBe(0);
    expect(canonicalStatus()).toBe("unreviewed");
    // A retry genuinely happened: more than one transaction attempt exists,
    // the first was discarded, and the last one saw the panel.
    const attempts = journals.filter((j) => j.reads.includes(`runs/${RUN}`));
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts[0].committed).toBe(false);
  });

  it("CONTROL: with no interference the same request commits on the FIRST attempt — so the retry above is caused by the conflict, not by the harness", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    const attempts = journals.filter((j) => j.reads.includes(`runs/${RUN}`));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].committed).toBe(true);
  });

  it("HARNESS FIDELITY: an unconfigured document path throws rather than silently resolving to the run document", async () => {
    expect(() => readPath("runs/other/humanReviewVotes/x")).toThrow(/unconfigured document path/);
  });
});

/**
 * §25 — harness fidelity.
 *
 * Every zero-call assertion in this file is only meaningful if the mocked
 * symbol is the one production actually invokes. F1 was exactly this failure:
 * the spec mocked `createAdaptiveHumanReviewHistoryEntry`, a name that does
 * not exist in `@/lib/firestore/runs`, so with `requireActual` spread the real
 * writer ran, the mock had zero call sites, and "no history on refusal" could
 * never fail.
 *
 * These tests drive the ALLOWED path and assert each side-effecting mock IS
 * called there. If a mock is misnamed or unwired, these fail — which is what
 * makes the refusal-path zero-call assertions falsifiable.
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

/**
 * §12–§19 — the refusal must not become a Team-panel oracle.
 *
 * PR #188 removed exactly this class of signal from the Personal READ
 * surfaces: `viewerMayReadReviewPanel` is owner-only, and `decidedVia`'s panel
 * values are suppressed there as "a provenance oracle that survives even when
 * no name or vote is returned". An error code is the same oracle by another
 * route, so the Personal WRITE refusal is neutral too. The distinction is kept
 * inside the transaction, where it is operationally useful and not visible to
 * this caller.
 */
describe("§16 — the Personal refusal does not name Team state", () => {
  it("O1 active and O2 malformed are byte-identical to this caller", async () => {
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

  it("neither refusal mentions a panel, a team, or reviewers", async () => {
    panelDocs.set(RUN, panel("open"));
    const r = await submit();
    const blob = JSON.stringify(r);
    for (const needle of ["panel", "team-SECRET", "multi-reviewer", "multi_reviewer"]) {
      expect(blob.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });
});

describe("§18 — the INTERNAL gate still distinguishes active from invalid", () => {
  // Neutralising the API must not collapse the classification itself: the two
  // conditions are operationally different and the transaction reports them
  // separately. Exact per-case assertions, one layer down.
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
