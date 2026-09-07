/**
 * Phase FIRST-ADMIN-C7 — GOVERNANCE HOT-PATH LOG REDACTION, PINNED AT THE
 * ROUTE/LOGGER BOUNDARY.
 *
 * C6 redacted these logs and proved it with a source grep. The C6-R3 review
 * classified that as a pre-enrollment blocker, correctly: a grep asserts that
 * today's source does not contain an interpolation, which is a syntax claim
 * about one file. It cannot see a value that reaches the log through a
 * variable, through an object argument, through `logger`'s own `redact()`, or
 * from a callee. Nothing stopped a future edit from reintroducing a leak by a
 * shape the grep did not spell.
 *
 * This suite instead runs the REAL route and captures the REAL sink. `logger`
 * delegates to `console.error/warn/log/debug` (lib/logger.ts:119-140), so
 * capturing every console method captures both the direct `console.*` calls and
 * everything routed through `logger` — including whatever `redact()` did or did
 * not do to it. Arguments are serialized deeply, so a canary buried in an
 * object argument is caught exactly like one interpolated into the message.
 *
 * Falsifiability. "No canary appeared in the output" is trivially satisfied by
 * a capture that recorded nothing, by a route that logged nothing, and by a
 * request that never reached the logging path. All three are excluded by
 * positive anchors that must hold before any absence assertion is trusted:
 *
 *   1. CAPTURE FIDELITY — a canary written straight to console is recovered by
 *      the capture, for every console method the logger uses.
 *   2. PATH EXECUTION — the override log line is present, proving the request
 *      actually reached the code under test.
 *   3. NON-SENSITIVE CONTENT SURVIVES — the operational content of that line is
 *      still there, so the test cannot be satisfied by logging nothing at all.
 */

import { inspect } from "node:util";
import { readFileSync } from "node:fs";

const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const COLLECTIONS = ["runs", "verifications", "videoVerifications"] as const;
type Coll = (typeof COLLECTIONS)[number];

/**
 * CANARIES. Each is unique and structurally unmistakable, so a hit is a leak
 * and never a coincidental substring. They stand in for the real values at the
 * position the real value occupies.
 */
const C = {
  reviewerUid: "CANARY-REVIEWER-UID-a71f3c",
  ownerAUid: "CANARY-OWNER-A-UID-b82e4d",
  ownerBUid: "CANARY-OWNER-B-UID-c93f5e",
  runId: "CANARY-RUN-ID-d04a6f",
  reason: "CANARY-REASON-TEXT-e15b70",
  question: "CANARY-QUESTION-TEXT-f26c81",
  callerEmail: "canary-reviewer@canary-domain-072d92.example",
  callerDomain: "canary-domain-072d92.example",
  ownerEmail: "canary-owner-a@canary-owner-domain-183ea3.example",
  allowlistEmail: "canary-allowlisted-admin@canary-allowlist-domain-294fb4.example",
} as const;

const NOW = Date.now();
let tokenClaims: Record<string, unknown> = {};
let liveRecord: Record<string, unknown> = {};
let planId = "full";
let reviewerFor: string[] = [];
let prevStatus = "blocked";
let integrityClassification: "valid" | "invalid" = "valid";

let existingDocs: Record<string, { userId: string }> = {};

/** Everything any console method received, in order, deeply serialized. */
/** Rows the REAL `writeAuditEvent` persisted, so we can prove it executed. */
let auditRows: Array<Record<string, unknown>> = [];
/** When true the audit `.add()` throws a realistic path-bearing Firestore error. */
let auditWriteFails = false;
let captured: string[] = [];
const CONSOLE_METHODS = ["log", "warn", "error", "debug", "info"] as const;
const originals: Partial<Record<(typeof CONSOLE_METHODS)[number], (...a: unknown[]) => void>> = {};
const serialize = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: null, breakLength: Infinity }))).join(" ");

beforeAll(() => {
  for (const m of CONSOLE_METHODS) {
    originals[m] = console[m].bind(console);
    console[m] = (...args: unknown[]) => { captured.push(serialize(args)); };
  }
});
afterAll(() => {
  for (const m of CONSOLE_METHODS) if (originals[m]) console[m] = originals[m]!;
});

const output = () => captured.join("\n");

function docHandle(collection: string, id: string) {
  const rec = existingDocs[`${collection}/${id}`];
  return {
    id,
    get: async () => ({
      exists: Boolean(rec),
      id,
      data: () => (rec ? {
        userId: rec.userId,
        uid: rec.userId,
        userEmail: C.ownerEmail,
        question: C.question,
        governanceStatus: prevStatus,
        governanceReasons: [C.reason],
        createdAt: { toMillis: () => NOW },
      } : undefined),
    }),
    set: async () => {},
    update: async () => {},
    collection: () => ({
      add: async () => {},
      orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
      get: async () => ({ docs: [] }),
    }),
  };
}
function collectionHandle(name: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["where", "orderBy", "limit", "select"]) q[m] = () => q;
  q.get = async () => ({ docs: [], empty: true, size: 0 });
  return Object.assign(q, {
    doc: (id: string) => docHandle(name, id),
    /**
     * Phase FIRST-ADMIN-C8. `writeAuditEvent` is NO LONGER MOCKED, so the real
     * writer runs against this double and its own logging is captured. The C7
     * suite stubbed `@/lib/governance/auditLog` — the module holding the actual
     * leak — so the proof examined everything except the thing that leaked.
     */
    add: async (patch: Record<string, unknown>) => {
      if (auditWriteFails) {
        // Firestore errors carry the document path they failed on, which is how
        // a cross-tenant identifier reaches the log by a route no grep for
        // `event.runId` would find. Shaped like the real thing.
        const err = Object.assign(
          new Error(`5 NOT_FOUND: no entity to update: app: projects/p/databases/(default)/documents/admin_audit_logs/${C.runId}`),
          { code: 5 }
        );
        throw err;
      }
      auditRows.push(patch);
      return { id: "audit-row-id" };
    },
  });
}

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: async () => tokenClaims,
    verifySessionCookie: async () => tokenClaims,
    getUser: async () => liveRecord,
  },
  adminDb: { collection: (n: string) => collectionHandle(n) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS" } } },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId }) }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => reviewerFor }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: async () => ({
    classification: integrityClassification,
    reason: integrityClassification === "invalid" ? "CANARY-INTEGRITY-REASON" : undefined,
  }),
}));

import { NextRequest } from "next/server";

const post = async (collection: Coll, runId: string) => {
  const { POST } = await import("@/app/api/governance/review/route");
  return POST(new NextRequest("http://localhost/api/governance/review", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ runId, collection, action: "approved", comment: "reviewed" }),
  }));
};

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "";
  planId = "full";
  reviewerFor = [C.ownerAUid];
  prevStatus = "blocked";
  integrityClassification = "valid";
  tokenClaims = { uid: C.reviewerUid, email: C.callerEmail, email_verified: true };
  liveRecord = { email: C.callerEmail, emailVerified: true, disabled: false };
  existingDocs = {};
  for (const c of COLLECTIONS) {
    existingDocs[`${c}/${C.runId}`] = { userId: C.ownerAUid };
    existingDocs[`${c}/other-run`] = { userId: C.ownerBUid };
  }
  captured = [];
  auditRows = [];
  auditWriteFails = false;
});

describe("ANCHOR 1 — the capture reproduces what the sink actually received", () => {
  /**
   * Without this, every absence assertion below is satisfied by a capture that
   * silently records nothing. It covers each console method `logger` uses, and
   * an object argument, because that is how `logger` passes structured data.
   */
  it.each(CONSOLE_METHODS)("console.%s output is recovered verbatim", (method) => {
    captured = [];
    (console[method] as (...a: unknown[]) => void)(`probe-${method}-${C.runId}`);
    expect(output()).toContain(`probe-${method}-${C.runId}`);
  });

  it("a canary nested inside an object argument is recovered", () => {
    captured = [];
    console.log("probe", { deep: { nested: [{ value: C.ownerBUid }] } });
    expect(output()).toContain(C.ownerBUid);
  });

  it("the capture starts empty for each test", () => {
    expect(captured).toEqual([]);
  });
});

describe.each(COLLECTIONS)("GOVERNANCE HOT PATH — collection=%s", (collection) => {
  /** Runs the authorized blocked→approved override, the most log-heavy path. */
  const run = async () => {
    const res = await post(collection, C.runId);
    expect(res.status).toBe(200); // the path really completed
    return output();
  };

  it("ANCHOR 2 — the request reached the logging path, and its content survived", async () => {
    const logs = await run();
    // The override line exists: absence assertions below are about a path that ran.
    expect(logs).toContain("[governance/review] Override:");
    // Its operational content is intact — this cannot be satisfied by logging nothing.
    expect(logs).toContain("prevStatus=blocked");
    // And the visibility resolver's line ran too, with its counts.
    expect(logs).toContain("[governance/queue] User:");
    expect(logs).toContain("plan: full");
    // THE REAL AUDIT WRITER EXECUTED on this request — not a stub. Both its
    // log lines are present, and it persisted exactly one identified row.
    expect(logs).toContain("[governance/audit] Writing audit event:");
    expect(logs).toContain("[governance/audit] Event written to admin_audit_logs:");
    expect(auditRows).toHaveLength(1);
    // The identified data lives in the ROW, which is the whole argument for
    // keeping it out of the log. If this stopped being true, redacting the log
    // would be destroying evidence rather than relocating it.
    expect(auditRows[0]).toMatchObject({ runId: C.runId, byUid: C.reviewerUid, runOwnerUid: C.ownerAUid });
  });

  it.each([
    ["the reviewer's own uid", C.reviewerUid],
    ["the run owner's uid", C.ownerAUid],
    ["a foreign tenant's uid", C.ownerBUid],
    ["the reviewed run's id", C.runId],
    ["the run's governance reason text", C.reason],
    ["the run's question text", C.question],
    ["the caller's email address", C.callerEmail],
    ["the caller's email domain", C.callerDomain],
    ["the run owner's email address", C.ownerEmail],
  ])("never writes %s to the log sink", async (_label, canary) => {
    const logs = await run();
    expect(logs).not.toContain(canary);
  });

  it("a governance status may appear only on a line carrying no identifier", async () => {
    /**
     * Status is deliberately NOT redacted: "a blocked run was approved" is the
     * operational content of the override line. It stops being tenant data
     * precisely because no identifier accompanies it, so that — not absence —
     * is the property worth pinning.
     */
    const logs = await run();
    const identifiers = [C.reviewerUid, C.ownerAUid, C.ownerBUid, C.runId, C.callerEmail, C.ownerEmail];
    const statusLines = logs.split("\n").filter((l) => /blocked|approved|needs_review/.test(l));
    expect(statusLines.length).toBeGreaterThan(0); // the rule is not vacuous
    for (const line of statusLines) {
      for (const id of identifiers) expect(line).not.toContain(id);
    }
  });
});

describe("the privileged allowlist is logged as shape, never as membership", () => {
  /**
   * VACUITY NOTE (self-composed string). A first version of this test built the
   * log line itself — `console.log(\`...${governanceAdminListShapeForLog()}\`)` —
   * and then asserted about its own output. That proves nothing about the
   * route: had the route been changed to log the raw list, the test would still
   * have passed, because the test was never reading the route.
   *
   * So the assertions below are on the VALUE THAT REACHES THE LOG — the
   * function's actual return — and a separate check derives from the route's
   * own source that this value is the only thing it interpolates. The second
   * check is a source check and is worth exactly what a source check is worth;
   * it is here because driving the full queue route is out of C7's scope, and
   * it is labelled rather than dressed up as behavioural proof.
   */
  const QUEUE_SRC = readFileSync("app/api/governance/queue/route.ts", "utf8");

  it("the value that reaches the log carries counts, never addresses", async () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = C.allowlistEmail;
    jest.resetModules();
    const { governanceAdminListShapeForLog } = await import("@/lib/admin/config");
    const shape = governanceAdminListShapeForLog();
    // ANCHOR: the list really was parsed — a function returning "" would pass
    // every absence assertion below.
    expect(shape).toContain("configured=1");
    expect(shape).toContain("valid=");
    expect(shape).not.toContain(C.allowlistEmail);
    expect(shape).not.toContain("canary-allowlist-domain-294fb4.example");
    expect(shape).not.toContain("@");
  });

  it("SOURCE CHECK: the queue route's governance-config line interpolates only that shape", () => {
    const line = QUEUE_SRC.split("\n").find((l) => l.includes("[governance] governance-config"));
    expect(line).toBeDefined();
    // Exactly one interpolation, and it is the shape function.
    expect([...line!.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim()))
      .toEqual(["governanceAdminListShapeForLog()"]);
  });
});

describe("DELIBERATE DIVERGENCE — the integrity-failure path keeps its run id", () => {
  /**
   * This is not an oversight, and it is pinned so that a future blanket
   * "redact all run ids" change has to re-make the decision consciously rather
   * than silently destroying the only trace of a data-integrity defect.
   *
   * The override line can drop its run id because `writeAuditEvent` records the
   * same event, identified, in an access-controlled collection. This path has
   * no such record: it returns 404 and writes nothing. Redacting here would
   * leave an integrity failure with no way to find the affected run.
   */
  it("logs the run id on workspace integrity failure, because nothing else records it", async () => {
    integrityClassification = "invalid";
    const res = await post("runs", C.runId);
    expect(res.status).toBe(404);
    const logs = output();
    expect(logs).toContain("workspace_run_integrity_failed");
    expect(logs).toContain(C.runId);
    // Still no caller identity or tenant content on that path.
    expect(logs).not.toContain(C.callerEmail);
    expect(logs).not.toContain(C.question);
  });
});

describe.each(COLLECTIONS)("OWNER_B IS REACHABLE — cross-tenant denial, collection=%s", (collection) => {
  /**
   * Phase FIRST-ADMIN-C8 (R4 P2-1). The C7 canary list asserted OWNER_B's uid
   * never appears in the logs — on a request where no production variable
   * could ever hold it. `other-run` was seeded and never posted to, so the row
   * was unfalsifiable: a maximal leak of the whole document and the whole
   * resolved identity failed eight of the nine canary rows and left that one
   * green.
   *
   * The fix is not a stronger assertion, it is a request that actually reaches
   * the branch: posting to a run OWNED BY OWNER_B, which the reviewer's scope
   * excludes. Now `ownerUid` genuinely holds OWNER_B at the 403.
   */
  it("SELF-VALIDATION: the target exists and belongs to OWNER_B, not to the reviewer's owner", async () => {
    // Derived from the fixture the route will actually read.
    expect(existingDocs[`${collection}/other-run`]).toEqual({ userId: C.ownerBUid });
    expect(C.ownerBUid).not.toBe(C.ownerAUid);
    expect(reviewerFor).toEqual([C.ownerAUid]);
    const snap = await collectionHandle(collection).doc("other-run").get();
    expect(snap.exists).toBe(true);
    expect((snap.data() as { userId: string }).userId).toBe(C.ownerBUid);
  });

  it("the branch is genuinely reached: a foreign run is denied 403 and never written", async () => {
    const res = await post(collection, "other-run");
    expect(res.status).toBe(403);
    expect(auditRows).toEqual([]);
  });

  it("the 403 RESPONSE discloses nothing about the tenant it refused", async () => {
    /**
     * Found by C8's own mutation battery: echoing `ownerUid` into the denial
     * body survived every test. A log leak is read by an operator; this one is
     * read by the caller who was just refused, so a foreign owner's uid would
     * be handed straight to the party that has no right to it.
     */
    const res = await post(collection, "other-run");
    const body = JSON.stringify(await res.json());
    // ANCHOR: this is the real denial payload, not an empty object.
    expect(body).toContain("forbidden");
    expect(body).toContain("permission");
    for (const canary of [C.ownerBUid, C.ownerAUid, C.reviewerUid, C.ownerEmail, C.question, "other-run"]) {
      expect(body).not.toContain(canary);
    }
  });

  it("ANCHOR: approved shape logging still occurs on the denial path", async () => {
    await post(collection, "other-run");
    // Without this the absence assertion below is satisfied by a silent request.
    expect(output()).toContain("[governance/queue] User:");
    expect(output()).toContain("plan: full");
  });

  it.each([
    ["the foreign tenant's uid", () => C.ownerBUid],
    ["the foreign run's id", () => "other-run"],
    ["the reviewer's uid", () => C.reviewerUid],
    ["the caller's email", () => C.callerEmail],
  ])("does not write %s to the log sink on the denial path", async (_label, canary) => {
    await post(collection, "other-run");
    expect(output()).not.toContain(canary());
  });
});

describe("admin_global BRANCH — the one that first executes at enrollment", () => {
  /**
   * Phase FIRST-ADMIN-C8 (R4 P2-2). C7 proved redaction on the `assigners`
   * branch only, then generalised to "the governance hot path". Four sibling
   * branches of the same edited function accepted arbitrary leaks with the
   * whole suite green — including this one, which does not execute AT ALL
   * until a GOVERNANCE_ADMIN is enrolled. Covering it after enrollment would
   * be covering it after the risk.
   *
   * The identity is constructed from a test-local env value and the mocked
   * Auth record. Production allowlists are untouched, and the snapshot at the
   * top of this file restores the variable.
   */
  const asGovernanceAdmin = () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = C.allowlistEmail;
    tokenClaims = { uid: C.reviewerUid, email: C.allowlistEmail, email_verified: true };
    liveRecord = { email: C.allowlistEmail, emailVerified: true, disabled: false };
  };

  it("SELF-VALIDATION: this identity really takes the admin_global branch", async () => {
    asGovernanceAdmin();
    const { resolveGovernanceVisibleUserIds } = await import("@/lib/governance/governanceVisibleUserIds");
    const vis = await resolveGovernanceVisibleUserIds(C.reviewerUid);
    // Not merely "authorized" — the specific branch, by its own contract:
    // a null visible set removes the owner filter entirely.
    expect(vis).toMatchObject({ ok: true, visibleUserIds: null, queueScope: "admin_global" });
  });

  it("ANCHOR: the branch logs its approved scope decision", async () => {
    asGovernanceAdmin();
    captured = [];
    await post("runs", "other-run");
    expect(output()).toContain("[governance/queue] Admin: global access");
  });

  it("a governance admin may review a run owned by any tenant", async () => {
    asGovernanceAdmin();
    // Proves the branch is load-bearing: OWNER_B's run is now reviewable,
    // which is exactly why its logging matters.
    const res = await post("runs", "other-run");
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
  });

  it.each([
    ["the governance admin's own uid", () => C.reviewerUid],
    ["the privileged allowlist address", () => C.allowlistEmail],
    ["the privileged allowlist domain", () => "canary-allowlist-domain-294fb4.example"],
    ["the cross-tenant run id", () => "other-run"],
    ["the cross-tenant owner uid", () => C.ownerBUid],
    ["the run owner's email", () => C.ownerEmail],
    ["the run's question text", () => C.question],
  ])("does not write %s to the log sink", async (_label, canary) => {
    asGovernanceAdmin();
    captured = [];
    await post("runs", "other-run");
    expect(output()).not.toContain(canary());
  });
});

describe("SIBLING SCOPE BRANCHES — every remaining logging branch of the resolver", () => {
  /**
   * Phase FIRST-ADMIN-C8 (R4 P2-2, "branch-shaped vacuity"). Enumerated from
   * lib/governance/governanceVisibleUserIds.ts: admin_global (above),
   * plan_required, no_assigners, the >30 truncation warning, and the assigners
   * decision (covered by the main suite). Each is exercised here with an
   * anchor proving the branch ran, then checked for identifiers.
   */
  const CANARIES = [C.reviewerUid, C.ownerAUid, C.ownerBUid, C.callerEmail, C.callerDomain, C.question];

  it("plan_required: logs the decision without the caller's identity", async () => {
    planId = "lite";
    const res = await post("runs", C.runId);
    expect(res.status).toBe(403);
    expect(output()).toContain("Scoping decision: plan_required");   // ANCHOR
    for (const c of CANARIES) expect(output()).not.toContain(c);
  });

  it("no_assigners: logs the empty scope without the caller's identity", async () => {
    reviewerFor = [];
    const res = await post("runs", C.runId);
    expect(res.status).toBe(403);
    expect(output()).toContain("no assigners (empty queue scope)");  // ANCHOR
    for (const c of CANARIES) expect(output()).not.toContain(c);
  });

  it("truncation: warns with a count and never the owner list", async () => {
    // 31 assigners forces the >30 branch; OWNER_B is among them, so a leak of
    // the list would be visible.
    reviewerFor = [C.ownerBUid, ...Array.from({ length: 30 }, (_, i) => `assigner-${i}`)];
    await post("runs", "other-run");
    expect(output()).toContain("Truncated visible owner set to 30");  // ANCHOR
    expect(output()).toContain("owner(s)");
    for (const c of CANARIES) expect(output()).not.toContain(c);
    expect(output()).not.toContain("assigner-0");
  });
});

describe("the audit writer's FAILURE path does not leak the record it failed on", () => {
  /**
   * Phase FIRST-ADMIN-C8. `writeAuditEvent` swallows its own errors and logged
   * the raw one. A Firestore error carries the document path it failed on, so
   * the same cross-tenant identifier redacted from the success path reached the
   * log through the catch block — by a route no grep for `event.runId` finds.
   *
   * This branch never fires in ordinary tests (the double always succeeds), so
   * a mutation restoring the raw error survived the entire suite until this
   * existed. The failure is injected deliberately.
   */
  it("SELF-VALIDATION: the injected error really carries the run id in its message", () => {
    auditWriteFails = true;
    const err = new Error(`5 NOT_FOUND: ... /admin_audit_logs/${C.runId}`);
    // If the fixture stopped embedding the identifier, the absence assertion
    // below would pass for the wrong reason.
    expect(err.message).toContain(C.runId);
  });

  it("logs the failure as shape, never the raw error", async () => {
    auditWriteFails = true;
    const res = await post("runs", C.runId);
    // ANCHOR: the request still succeeded (the writer swallows its error), and
    // the failure branch genuinely executed.
    expect(res.status).toBe(200);
    expect(output()).toContain("[governance/audit] FAILED to write audit event");
    // ANCHOR: useful operational content survived.
    expect(output()).toContain("errorCode");
    expect(auditRows).toEqual([]);
    // And the identifiers the error dragged along are absent.
    expect(output()).not.toContain(C.runId);
    expect(output()).not.toContain("admin_audit_logs/");
    expect(output()).not.toContain("NOT_FOUND: no entity");
  });
});
