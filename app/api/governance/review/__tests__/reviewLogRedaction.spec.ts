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
  return Object.assign(q, { doc: (id: string) => docHandle(name, id) });
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
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: async () => {} }));
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
  it("does not write a configured allowlist address to the log sink", async () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = C.allowlistEmail;
    jest.resetModules();
    const { governanceAdminListShapeForLog } = await import("@/lib/admin/config");
    captured = [];
    console.log(`[governance] governance-config ${governanceAdminListShapeForLog()}`);
    const logs = output();
    // ANCHOR: the shape really was emitted, and reflects the configured list.
    expect(logs).toContain("configured=1");
    expect(logs).not.toContain(C.allowlistEmail);
    expect(logs).not.toContain("canary-allowlist-domain-294fb4.example");
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
