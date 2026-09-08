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
 * delegates to `console.error/warn/log/debug` (lib/logger.ts:119-140), and the
 * governance modules under test use `console.log/warn/error` directly, so the
 * capture covers every sink THOSE MODULES ACTUALLY USE. Arguments are
 * serialized deeply, so a canary buried in an object argument is caught exactly
 * like one interpolated into the message.
 *
 * SCOPE OF THAT CLAIM, stated because C9 overstated it as "every console
 * method": `console.dir`, `console.trace`, `console.table` and direct
 * `process.stdout.write` are NOT captured. No governance module uses them
 * today — verified by the structural test below — but a future one would be
 * invisible here. That is a named residual, not a covered case.
 *
 * A second named residual: `logger.redact()` replaces values under the keys
 * `uid`/`userId`/`firebaseUid` with a truncated 32-bit hash. A leak routed
 * through `logger.warn(msg, { uid })` therefore does not appear as the raw
 * canary and is invisible to these assertions — and the hash is itself a stable
 * per-user correlation identifier. Not fixed here; see
 * docs/operations/security-test-falsifiability.md.
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

/**
 * Phase FIRST-ADMIN-C9 (R5 F1) — ONE SHARED DENY-SET.
 *
 * C8 made every logging branch execute, then gave each its own canary list:
 * 9 canaries on the main path, 7 on `admin_global` (missing the reason text),
 * 4 on the 403 denial, 2 on the integrity exception. So the branches ran, but
 * each sibling accepted leaks the main path rejected — the same branch-shaped
 * vacuity C8 existed to close, one level in. Six mutations proved it: a
 * governance reason logged in `admin_global`, an owner email on the denial
 * path, the reviewer uid on the integrity path, all green.
 *
 * Every ordinary governance branch now asserts against THIS list. A branch may
 * add canaries; none may quietly assert a weaker subset. The one documented
 * exception is the workspace-integrity path, which is allowed the run id and
 * nothing else — see its own describe block.
 */
const SENSITIVE_LOG_CANARIES: Array<[string, () => string]> = [
  ["the reviewer's uid", () => C.reviewerUid],
  ["the run owner's uid", () => C.ownerAUid],
  ["a foreign tenant's uid", () => C.ownerBUid],
  ["the reviewed run's id", () => C.runId],
  ["a foreign run's id", () => "other-run"],
  ["the run's governance reason text", () => C.reason],
  ["the run's question text", () => C.question],
  ["the caller's email address", () => C.callerEmail],
  ["the caller's email domain", () => C.callerDomain],
  ["the run owner's email address", () => C.ownerEmail],
  ["the privileged allowlist address", () => C.allowlistEmail],
  ["the privileged allowlist domain", () => "canary-allowlist-domain-294fb4.example"],
];

/**
 * The audit event object's identity fields, by the names the writer sees. Same
 * values as above — listed so it is explicit that `byUid`/`byEmail`/
 * `runOwnerUid`/`runOwnerEmail` are covered by the shared set, which is what
 * the audit-failure branch leaked.
 */
const AUDIT_EVENT_IDENTITY_FIELDS = {
  byUid: () => C.reviewerUid,
  byEmail: () => C.callerEmail,
  runOwnerUid: () => C.ownerAUid,
  runOwnerEmail: () => C.ownerEmail,
  runId: () => C.runId,
  question: () => C.question,
} as const;

/**
 * Phase FIRST-ADMIN-C10 (R6 P1-1) — ONE ASSERTION, NOT A LIST PER BRANCH.
 *
 * C9 unified the deny-set across five branches and left the sixth — the audit
 * writer's catch block — on a hand-written three-value list. That block holds
 * the WHOLE event object, so `byUid`, `byEmail`, `runOwnerUid`,
 * `runOwnerEmail` and `question` all leaked with the suite green; under
 * `admin_global` the swallowed event describes another tenant's run.
 *
 * A per-branch list is the defect. Every governance logging branch now calls
 * THIS function, so a new branch cannot quietly ship a weaker subset — the only
 * way to weaken one is to pass an explicit `allow`, which is visible in review.
 */
function assertNoSensitiveGovernanceCanaries(
  logs: string,
  opts: { allowIntegrityRunId?: boolean } = {}
) {
  /**
   * Phase FIRST-ADMIN-C11 (R7 P2-a). The exception used to be an unbounded
   * `allow: string[]`, so widening it to six values — including reviewer uid,
   * owner uid and owner email — passed with the suite green. There is exactly
   * ONE justified exception in this system, so it is now a named boolean and
   * nothing else can be excused.
   */
  const leaked: string[] = [];
  for (const [label, get] of SENSITIVE_LOG_CANARIES) {
    const value = get();
    if (opts.allowIntegrityRunId && value === C.runId) continue;
    if (logs.includes(value)) leaked.push(label);
  }
  expect(leaked).toEqual([]);
}

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
type Write = { kind: "set" | "update" | "add"; collection: string; id: string; patch?: Record<string, unknown> };
/** Every Firestore write the handler performed, so a zero-write premise is testable. */
let writes: Write[] = [];
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

/**
 * Phase FIRST-ADMIN-C11 (R7 P1-a/P1-b) — REDACTION IS ENFORCED AUTOMATICALLY.
 *
 * C10 required each branch to CALL the shared assertion, and proved compliance
 * by looking for the call as a substring of the test body. A reviewer defeated
 * that twice: commenting the call out satisfied the substring check (and the
 * sibling scan skipped comment lines, so one `//` blinded both), and a
 * same-named decoy test earlier in the file redirected the per-branch lookup.
 * A real uid+email leak rode in behind each, green.
 *
 * So the assertion is no longer something a test opts INTO. It runs after every
 * test in this file against whatever reached the log sink. A new branch is
 * covered the moment it is written, and the only way out is one of the two
 * declared exemptions below — set in the test body, visible in review, and
 * itself asserted.
 */
type RedactionExemption =
  | "none"
  /** The capture-fidelity tests deliberately log a canary to prove the spy works. */
  | "capture-fidelity"
  /** The workspace-integrity 404 path may retain the run id, and nothing else. */
  | "integrity-run-id";
let redactionExemption: RedactionExemption = "none";
/**
 * Counts assertions the afterEach actually PERFORMED. Without it the
 * enforcement hook is itself unguarded: short-circuiting it (`if (true) return`)
 * silently disables redaction checking for every branch in this file and no
 * test notices — the same defect as the substring guard it replaced, one level
 * further in.
 */
let redactionAssertionsRun = 0;

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
        // Present on EVERY fixture document, including the cross-tenant one, so
        // a reason-text leak is reachable on every branch that reads a run.
        governanceReasons: [C.reason],
        createdAt: { toMillis: () => NOW },
      } : undefined),
    }),
    set: async (patch: Record<string, unknown>) => { writes.push({ kind: "set", collection, id, patch }); },
    update: async (patch: Record<string, unknown>) => { writes.push({ kind: "update", collection, id, patch }); },
    collection: (sub: string) => ({
      add: async (patch: Record<string, unknown>) => { writes.push({ kind: "add", collection: `${collection}/${id}/${sub}`, id: "auto", patch }); },
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
        /**
         * Phase FIRST-ADMIN-C10 (R6 P2). The previous fixture was an `Error`
         * with only `code` added — and `message`/`name` are NON-enumerable on
         * Error, so the only own enumerable property was the one the code
         * already logs deliberately. A mutation spreading the error (`...err`)
         * therefore leaked nothing and survived. `firebase-admin` throws a
         * grpc-js ServiceError, whose `details` repeats the document path as an
         * ENUMERABLE property. Modelled properly, a spread now leaks.
         */
        const path = `projects/p/databases/(default)/documents/admin_audit_logs/${C.runId}`;
        throw Object.assign(new Error(`5 NOT_FOUND: no entity to update: app: ${path}`), {
          code: 5,
          details: `no entity to update: app: ${path}`,
          metadata: { internalRepr: new Map(), options: {} },
          owner: C.ownerAUid,
        });
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
  writes = [];
  auditWriteFails = false;
  redactionExemption = "none";
});

afterEach(() => {
  if (redactionExemption === "capture-fidelity") return;
  assertNoSensitiveGovernanceCanaries(output(), {
    allowIntegrityRunId: redactionExemption === "integrity-run-id",
  });
  redactionAssertionsRun += 1;
});

describe("ANCHOR 0 — every canary is REACHABLE in the data the route reads", () => {
  /**
   * Phase FIRST-ADMIN-C9. A vacuity attack proved this necessary: emptying
   * `governanceReasons` in the fixture left every "does not log the reason
   * text" assertion green on every branch, because the value no longer existed
   * anywhere for the route to leak. An absence assertion about a value the
   * system never holds cannot fail.
   *
   * This pins that each canary is genuinely present in the state the route
   * reads, so the deny-set assertions are about values that could actually
   * escape.
   */
  it("the reviewed run carries the owner, reason, question and owner email", async () => {
    const data = (await collectionHandle("runs").doc(C.runId).get()).data() as Record<string, unknown>;
    expect(data.userId).toBe(C.ownerAUid);
    expect(data.governanceReasons).toContain(C.reason);
    expect(data.question).toBe(C.question);
    expect(data.userEmail).toBe(C.ownerEmail);
  });

  it("the cross-tenant run carries OWNER_B and its own reason text", async () => {
    const data = (await collectionHandle("runs").doc("other-run").get()).data() as Record<string, unknown>;
    expect(data.userId).toBe(C.ownerBUid);
    expect(data.governanceReasons).toContain(C.reason);
  });

  it("the caller identity carries the reviewer uid, email and domain", () => {
    expect(tokenClaims.uid).toBe(C.reviewerUid);
    expect(tokenClaims.email).toBe(C.callerEmail);
    expect(C.callerEmail).toContain(C.callerDomain);
    expect(C.allowlistEmail).toContain("canary-allowlist-domain-294fb4.example");
  });

  it("every value in the shared deny-set is a distinct, non-empty canary", () => {
    const values = SENSITIVE_LOG_CANARIES.map(([, v]) => v());
    expect(values).toHaveLength(new Set(values).size);
    for (const v of values) expect(v.length).toBeGreaterThan(8);
  });
});

describe("ANCHOR 1 — the capture reproduces what the sink actually received", () => {
  /**
   * Without this, every absence assertion below is satisfied by a capture that
   * silently records nothing. It covers each console method `logger` uses, and
   * an object argument, because that is how `logger` passes structured data.
   */
  it.each(CONSOLE_METHODS)("console.%s output is recovered verbatim", (method) => {
    redactionExemption = "capture-fidelity"; // deliberately emits a canary
    captured = [];
    (console[method] as (...a: unknown[]) => void)(`probe-${method}-${C.runId}`);
    expect(output()).toContain(`probe-${method}-${C.runId}`);
  });

  it("a canary nested inside an object argument is recovered", () => {
    redactionExemption = "capture-fidelity"; // deliberately emits a canary
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

  it("never writes any sensitive canary to the log sink", async () => {
    assertNoSensitiveGovernanceCanaries(await run());
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
    // THE ONE justified exemption. Named, not an arbitrary allowlist.
    redactionExemption = "integrity-run-id";
    integrityClassification = "invalid";
    const res = await post("runs", C.runId);
    expect(res.status).toBe(404);
    const logs = output();
    expect(logs).toContain("workspace_run_integrity_failed");
    expect(logs).toContain(C.runId);

    /**
     * THE PREMISE, PINNED (R6 P1-2). The run id is allowed here ONLY because
     * this path writes nothing — no governance write, no governanceEvents
     * write, no audit event — so the log line is the sole trace of a malformed
     * record. C9 asserted the exception and not its justification, so adding a
     * `writeAuditEvent` to this branch survived 2779 tests. If any of these
     * becomes non-zero, the licence for the run id is gone.
     */
    expect(writes).toEqual([]);
    expect(auditRows).toEqual([]);

    /**
     * NARROW ALLOWLIST, not a weak subset. C8 checked two canaries here and
     * three leak mutations survived — reviewer uid, owner uid and reason text
     * could all be added to this log with the suite green. That is the branch
     * where scope creep is most likely precisely BECAUSE it is already licensed
     * to carry one identifier. Everything except the run id is still forbidden.
     */
    assertNoSensitiveGovernanceCanaries(logs, { allowIntegrityRunId: true });
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

  it("writes no sensitive canary to the log sink on the denial path", async () => {
    await post(collection, "other-run");
    assertNoSensitiveGovernanceCanaries(output());
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

  it("writes no sensitive canary to the log sink", async () => {
    asGovernanceAdmin();
    captured = [];
    await post("runs", "other-run");
    assertNoSensitiveGovernanceCanaries(output());
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


  it("plan_required: logs the decision without the caller's identity", async () => {
    planId = "lite";
    const res = await post("runs", C.runId);
    expect(res.status).toBe(403);
    expect(output()).toContain("Scoping decision: plan_required");   // ANCHOR
    assertNoSensitiveGovernanceCanaries(output());
  });

  it("no_assigners: logs the empty scope without the caller's identity", async () => {
    reviewerFor = [];
    const res = await post("runs", C.runId);
    expect(res.status).toBe(403);
    expect(output()).toContain("no assigners (empty queue scope)");  // ANCHOR
    assertNoSensitiveGovernanceCanaries(output());
  });

  it("truncation: warns with a count and never the owner list", async () => {
    // 31 assigners forces the >30 branch; OWNER_B is among them, so a leak of
    // the list would be visible.
    reviewerFor = [C.ownerBUid, ...Array.from({ length: 30 }, (_, i) => `assigner-${i}`)];
    await post("runs", "other-run");
    expect(output()).toContain("Truncated visible owner set to 30");  // ANCHOR
    expect(output()).toContain("owner(s)");
    assertNoSensitiveGovernanceCanaries(output());
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
  it("SELF-VALIDATION: every identity field of the event is covered by the shared deny-set", () => {
    // Without this, "the shared set covers the event object" is an assumption.
    const denied = new Set(SENSITIVE_LOG_CANARIES.map(([, v]) => v()));
    for (const [field, get] of Object.entries(AUDIT_EVENT_IDENTITY_FIELDS)) {
      expect({ field, covered: denied.has(get()) }).toEqual({ field, covered: true });
    }
  });

  it("SELF-VALIDATION: the injected error carries the path in BOTH message and an enumerable field", async () => {
    auditWriteFails = true;
    // If the fixture stopped embedding the identifier, or stopped making it
    // enumerable, the absence assertions would pass for the wrong reason.
    let thrown: unknown;
    auditWriteFails = true;
    try { await collectionHandle("admin_audit_logs").add({}); } catch (e) { thrown = e; }
    expect((thrown as Error).message).toContain(C.runId);
    expect(Object.keys(thrown as object)).toEqual(expect.arrayContaining(["code", "details"]));
    expect(JSON.stringify({ ...(thrown as object) })).toContain(C.runId);
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

    /**
     * R6 P1-1: this branch asserted three hand-picked values while every
     * neighbour used the shared set — and the catch block holds the WHOLE
     * event object, so byUid / byEmail / runOwnerUid / runOwnerEmail /
     * question all leaked with the suite green. Under `admin_global` that
     * event describes another tenant's run. Same assertion as every branch now.
     */
    assertNoSensitiveGovernanceCanaries(output());
    // Plus the error's own path-bearing payload, which is not a canary value.
    expect(output()).not.toContain("admin_audit_logs/");
    expect(output()).not.toContain("NOT_FOUND: no entity");
  });
});

describe("DENY-SET INTEGRITY — every declared canary is load-bearing", () => {
  /**
   * Phase FIRST-ADMIN-C11.
   *
   * The per-branch "does this test call the shared helper?" checks that used to
   * live here are GONE. They asserted that a call appeared as a substring of a
   * test body, and a reviewer defeated them twice — by commenting the call out
   * (which also blinded the sibling scan, since that skipped comment lines) and
   * by adding a same-named decoy test earlier in the file. A real uid+email
   * leak rode in behind each, green.
   *
   * Enforcement is now the `afterEach` above: it runs against the real captured
   * sink after every test in this file, so a branch cannot forget it and a
   * comment cannot silence it. What remains worth testing is the deny-set
   * itself — R7 found four of its twelve entries could be deleted silently,
   * and two others were protected only by accident.
   */
  const EXPECTED_CANARIES = [
    "the reviewer's uid",
    "the run owner's uid",
    "a foreign tenant's uid",
    "the reviewed run's id",
    "a foreign run's id",
    "the run's governance reason text",
    "the run's question text",
    "the caller's email address",
    "the caller's email domain",
    "the run owner's email address",
    "the privileged allowlist address",
    "the privileged allowlist domain",
  ];

  it("the deny-set contains exactly the declared entries — none can be dropped silently", () => {
    expect(SENSITIVE_LOG_CANARIES.map(([label]) => label)).toEqual(EXPECTED_CANARIES);
  });

  it.each(EXPECTED_CANARIES)("%s is a distinct, non-empty, unmistakable value", (label) => {
    const entry = SENSITIVE_LOG_CANARIES.find(([l]) => l === label);
    expect(entry).toBeDefined();
    const value = entry![1]();
    expect(value.length).toBeGreaterThan(8);
    expect(SENSITIVE_LOG_CANARIES.filter(([, g]) => g() === value)).toHaveLength(1);
  });

  it.each(EXPECTED_CANARIES)("a leak of %s fails the shared assertion", (label) => {
    /**
     * Each entry must be able to FAIL the assertion — R7 found only two were,
     * and those two only because they happened to be hard-coded into the
     * helper's own unit test.
     */
    redactionExemption = "capture-fidelity"; // asserting on strings, not on a sink
    const value = SENSITIVE_LOG_CANARIES.find(([l]) => l === label)![1]();
    expect(() => assertNoSensitiveGovernanceCanaries(`prefix ${value} suffix`)).toThrow();
  });

  it.each(EXPECTED_CANARIES)("the integrity exemption does NOT excuse %s", (label) => {
    /**
     * The exemption is a named boolean rather than an unbounded allow-list, but
     * its implementation still decides WHICH value it excuses. Widening that to
     * a second identity field must fail — R7 widened the old array to six and
     * shipped a real leak green.
     */
    redactionExemption = "capture-fidelity";
    const value = SENSITIVE_LOG_CANARIES.find(([l]) => l === label)![1]();
    if (value === C.runId) {
      expect(() => assertNoSensitiveGovernanceCanaries(`x ${value}`, { allowIntegrityRunId: true })).not.toThrow();
      return;
    }
    expect(() => assertNoSensitiveGovernanceCanaries(`x ${value}`, { allowIntegrityRunId: true })).toThrow();
  });

  it("the shared assertion passes on genuinely clean output", () => {
    redactionExemption = "capture-fidelity";
    expect(() => assertNoSensitiveGovernanceCanaries("[governance/queue] plan: full, 3 owner(s)")).not.toThrow();
  });

  it("every audit-event identity field is covered by the deny-set", () => {
    const denied = new Set(SENSITIVE_LOG_CANARIES.map(([, v]) => v()));
    for (const [field, get] of Object.entries(AUDIT_EVENT_IDENTITY_FIELDS)) {
      expect({ field, covered: denied.has(get()) }).toEqual({ field, covered: true });
    }
  });
});

describe("RECORDER FIDELITY — a zero-write assertion cannot pass on a dead recorder", () => {
  /**
   * The integrity exception is licensed by "this path writes nothing", asserted
   * as `expect(writes).toEqual([])`. Unwire the double's `set` and that passes
   * for the wrong reason. So the recorder is pinned on a path that DOES write.
   */
  it("records the governance write performed by an authorized review", async () => {
    const res = await post("runs", C.runId);
    expect(res.status).toBe(200);
    const primary = writes.filter((w) => w.kind !== "add" && w.collection === "runs" && w.id === C.runId);
    expect(primary).toHaveLength(1);
    expect(primary[0].patch).toMatchObject({ governanceStatus: "approved" });
    // and the sub-collection write, recorded with its full path
    expect(writes.some((w) => w.collection === `runs/${C.runId}/governanceEvents`)).toBe(true);
  });
});

describe("STRUCTURAL — governance modules use only sinks this suite captures", () => {
  /**
   * The capture patches console.log/warn/error/debug/info. `console.dir`,
   * `console.trace`, `console.table` and `process.stdout.write` would bypass
   * it. Rather than claim universal interception, pin that the modules on this
   * request path do not use them — so the claim and the reality stay together.
   */
  const MODULES = [
    "app/api/governance/review/route.ts",
    "lib/governance/governanceVisibleUserIds.ts",
    "lib/governance/auditLog.ts",
    "lib/logger.ts",
  ];

  it("ANCHOR: the modules were read and do log", () => {
    for (const m of MODULES) expect(readFileSync(m, "utf8")).toMatch(/console\.|logger\./);
  });

  it.each(MODULES)("%s uses no uncaptured output sink", (mod) => {
    const src = readFileSync(mod, "utf8");
    for (const sink of ["console.dir", "console.trace", "console.table", "console.group", "process.stdout.write", "process.stderr.write"]) {
      expect({ mod, sink, used: src.includes(sink) }).toEqual({ mod, sink, used: false });
    }
  });
});

describe("ZZ ENFORCEMENT LIVENESS — the automatic check actually ran", () => {
  /**
   * Runs last. Every preceding test either performed the shared assertion in
   * afterEach or declared a capture-fidelity exemption. If the hook were
   * disabled the counter would not have moved, and redaction would be
   * unenforced across this whole file with every test still green.
   */
  it("the afterEach performed the shared assertion for the bulk of this suite", () => {
    expect(redactionAssertionsRun).toBeGreaterThan(40);
  });
});
