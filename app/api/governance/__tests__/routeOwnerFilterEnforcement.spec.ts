/**
 * Phase FIRST-ADMIN-C5 — THE ROUTES MUST ENFORCE THE FINITE OWNER SET,
 * ON EVERY COLLECTION AND EVERY QUERY MODE.
 *
 * C4 added route-level coverage and closed the three regressions R3 named. The
 * C4-R1 review then found the coverage had three holes, each of which let the
 * SAME class of defect straight back through:
 *
 *   1. The queue "empty set" test asserted `body.items ?? []` — the route emits
 *      `runs`, never `items`, so the key was always `undefined` and the
 *      assertion could not fail. Converting the empty set to `null` (a full
 *      global queue over every user's records) passed 2685/2685.
 *   2. The audit and review gates were only ever exercised with
 *      `collection=runs`. Scoping either gate to `runs` — leaving
 *      `verifications` and `videoVerifications` ungated — survived. On the
 *      REVIEW route that is an unauthorised cross-tenant WRITE.
 *   3. The queue was only exercised with `runType=all`. Each single-type branch
 *      sits beside a near-identical GLOBAL loader that applies no owner filter;
 *      swapping any one survived, and is a complete cross-tenant read.
 *
 * Two structural changes make those classes detectable rather than relying on
 * remembering to add cases:
 *
 *   - Every audit/review case is PARAMETRISED over all three collections.
 *   - The Firestore double implements REAL QUERY SEMANTICS: it returns the
 *     documents matching the `where("userId", …)` constraints a query actually
 *     carries, and returns EVERY seeded document when a query carries none.
 *     So an unscoped query really does yield the other owner's rows, and the
 *     assertion is "owner-b never appears in the response" — a leaked ROW,
 *     not merely a missing constraint.
 */

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

const NOW = Date.now();
const VIEWER_UID = "reviewer";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
/** The three owner-scoped collections. Every gate must cover all of them. */
const COLLECTIONS = ["runs", "verifications", "videoVerifications"] as const;
type Coll = (typeof COLLECTIONS)[number];

let visibility: Record<string, unknown> = {};
/** Owner of the single document addressed by the audit/review routes. */
let docOwner: string = OWNER_A;

const auditWrite = jest.fn(async () => undefined);
const reviewUpdate = jest.fn(async () => undefined);
/** Owner constraints actually issued, tagged with their collection. */
const whereCalls: Array<{ collection: string; field: string; op: string; value: unknown }> = [];
const queriedCollections: string[] = [];

/** One document per owner, in every collection, all queue-eligible. */
const seedDoc = (coll: Coll, owner: string) => ({
  id: `${coll}-${owner}`,
  data: () => ({
    userId: owner,
    uid: owner,
    userEmail: `${owner}@test-invented.example`,
    question: `question owned by ${owner}`,
    claim: `claim owned by ${owner}`,
    fileName: `${owner}.mp4`,
    type: coll === "videoVerifications" ? "video_verification" : "claim_verification",
    governanceStatus: "needs_review",
    consensusScore: 50,
    // Recent: the queue drops anything older than its cutoff, so a stale
    // timestamp would make every row assertion below vacuous.
    createdAt: { toMillis: () => NOW },
    timestamp: { toMillis: () => NOW },
    verifiedAt: { toMillis: () => NOW },
  }),
});

/** The document the audit/review routes address, owned by `docOwner`. */
const addressedDoc = () => ({
  exists: true,
  id: "run-1",
  data: () => ({
    userId: docOwner,
    uid: docOwner,
    userEmail: `${docOwner}@test-invented.example`,
    question: "q",
    governanceStatus: "needs_review",
    createdAt: { toMillis: () => NOW },
  }),
});

/**
 * A chainable query that REMEMBERS its owner constraints and resolves them the
 * way Firestore would: constrained -> only matching owners; unconstrained ->
 * the whole collection.
 */
function makeQuery(collection: string) {
  const constraints: Array<{ field: string; op: string; value: unknown }> = [];
  const q: Record<string, unknown> = {};
  for (const m of ["orderBy", "limit", "select", "startAfter", "endBefore", "offset"]) q[m] = () => q;
  q.where = (field: string, op: string, value: unknown) => {
    constraints.push({ field, op, value });
    whereCalls.push({ collection, field, op, value });
    return q;
  };
  q.get = async () => {
    queriedCollections.push(collection);
    if (collection === "admin_audit_logs") {
      // Two audit rows: one performed BY the viewer, one by someone else about
      // an out-of-scope owner. The global list must not disclose the latter.
      return {
        docs: [
          { id: "ev-mine", data: () => ({ at: { toMillis: () => NOW }, byUid: VIEWER_UID, byEmail: "reviewer@test-invented.example", action: "approved", runId: "run-1", collection: "runs", runOwnerUid: OWNER_A, runOwnerEmail: `${OWNER_A}@test-invented.example`, question: "mine" }) },
          { id: "ev-theirs", data: () => ({ at: { toMillis: () => NOW }, byUid: "someone-else", byEmail: "other@test-invented.example", action: "blocked", runId: "run-2", collection: "runs", runOwnerUid: OWNER_B, runOwnerEmail: `${OWNER_B}@test-invented.example`, question: "SECRET-OTHER-TENANT-QUESTION" }) },
        ],
        empty: false,
        size: 2,
      };
    }
    const owners = COLLECTIONS.includes(collection as Coll) ? [OWNER_A, OWNER_B] : [];
    const ownerConstraint = constraints.find((c) => c.field === "userId" || c.field === "uid");
    const allowed = ownerConstraint
      ? owners.filter((o) => (Array.isArray(ownerConstraint.value) ? ownerConstraint.value.includes(o) : ownerConstraint.value === o))
      : owners; // NO owner constraint => the whole collection, exactly like Firestore
    return { docs: allowed.map((o) => seedDoc(collection as Coll, o)), empty: allowed.length === 0, size: allowed.length };
  };
  q.count = () => ({ get: async () => ({ data: () => ({ count: 0 }) }) });
  q.add = (...a: unknown[]) => reviewUpdate(...(a as []));
  q.doc = () => ({
    get: async () => addressedDoc(),
    update: (...a: unknown[]) => reviewUpdate(...(a as [])),
    set: (...a: unknown[]) => reviewUpdate(...(a as [])),
    collection: (n: string) => makeQuery(n),
  });
  return q;
}

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: async () => ({ email: "reviewer@test-invented.example", emailVerified: true, disabled: false }) },
  adminDb: { collection: (name: string) => makeQuery(name) },
  firebaseAdmin: { firestore: { Timestamp: { now: () => "TS", fromDate: () => "TS" }, FieldValue: { serverTimestamp: () => "TS" } } },
}));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => {
  const actual = jest.requireActual("@/lib/governance/governanceVisibleUserIds");
  return {
    ...actual,
    // Only the resolvers are doubled; `runOwnerVisibleInGovernance` stays REAL.
    resolveGovernanceVisibleUserIds: async () => visibility,
    resolveGovernanceVisibleUserIdsCached: async () => visibility,
  };
});
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: "reviewer", email: "reviewer@test-invented.example", emailVerified: true }),
  checkAdminOnly: async () => false,
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: (...a: unknown[]) => auditWrite(...(a as [])) }));

import { NextRequest } from "next/server";

const SCOPED = { ok: true, visibleUserIds: [OWNER_A], isSupportAdmin: false, queueScope: "assigners" };
const EMPTY = { ok: true, visibleUserIds: [] as string[], isSupportAdmin: false, queueScope: "no_assigners" };
const GLOBAL = { ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" };

const ownerConstraints = () => whereCalls.filter((c) => c.field === "userId" || c.field === "uid");

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "governance-only@test-invented.example";
  visibility = { ...SCOPED };
  docOwner = OWNER_A;
  auditWrite.mockClear();
  reviewUpdate.mockClear();
  whereCalls.length = 0;
  queriedCollections.length = 0;
});

// ------------------------------------------------------------------ AUDIT --
describe.each(COLLECTIONS)("governance AUDIT route — collection=%s", (collection) => {
  const call = async () => {
    const { GET } = await import("@/app/api/governance/audit/route");
    return GET(new NextRequest(`http://localhost/api/governance/audit?runId=run-1&collection=${collection}`, {
      headers: { authorization: "Bearer t" },
    }));
  };

  it("an owner INSIDE the finite set is readable", async () => {
    docOwner = OWNER_A;
    expect((await call()).status).not.toBe(403);
  });

  it("THE CORE PROOF: an owner OUTSIDE the finite set is refused", async () => {
    docOwner = OWNER_B;
    const res = await call();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("an EMPTY finite set exposes nothing — it is not global", async () => {
    visibility = { ...EMPTY };
    docOwner = OWNER_A;
    expect((await call()).status).toBe(403);
  });

  it("only a genuine governance admin reaches an out-of-scope owner", async () => {
    visibility = { ...GLOBAL };
    docOwner = OWNER_B;
    expect((await call()).status).not.toBe(403);
  });
});

// ----------------------------------------------------------------- REVIEW --
describe.each(COLLECTIONS)("governance REVIEW route (WRITE) — collection=%s", (collection) => {
  const call = async () => {
    const { POST } = await import("@/app/api/governance/review/route");
    return POST(new NextRequest("http://localhost/api/governance/review", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-1", collection, action: "approved", comment: "ok" }),
    }));
  };

  it("an owner INSIDE the finite set can be reviewed", async () => {
    docOwner = OWNER_A;
    expect((await call()).status).not.toBe(403);
  });

  it("THE CORE PROOF: reviewing an owner OUTSIDE the set is refused AND writes nothing", async () => {
    docOwner = OWNER_B;
    const res = await call();
    expect(res.status).toBe(403);
    expect(reviewUpdate).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it("an EMPTY finite set permits no review at all", async () => {
    visibility = { ...EMPTY };
    docOwner = OWNER_A;
    expect((await call()).status).toBe(403);
    expect(reviewUpdate).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ QUEUE --
describe.each(["all", "research", "verification", "video"])("governance QUEUE route — runType=%s", (runType) => {
  const call = async () => {
    const { GET } = await import("@/app/api/governance/queue/route");
    return GET(new NextRequest(`http://localhost/api/governance/queue?runType=${runType}&status=all`, {
      headers: { authorization: "Bearer t" },
    }));
  };
  const rowsOf = (body: unknown) => ((body as { runs?: Array<{ userId?: string }> }).runs ?? []);

  it("THE CORE PROOF: no row belonging to an out-of-scope owner is ever returned", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    // `runs` is the key this route emits. Asserting a key it never emits would
    // make this vacuous — that was the C4 defect.
    expect(body).toHaveProperty("runs");
    const rows = rowsOf(body);
    // The in-scope owner's rows MUST come back. Without this, "no owner-b rows"
    // would pass trivially on an empty response — which is exactly how this
    // assertion was vacuous before the seed timestamps were made recent.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.userId === OWNER_A)).toBe(true);
    expect(rows.filter((r) => r.userId === OWNER_B)).toEqual([]);
  });

  it("every owner-scoped collection it queried carried an owner constraint", async () => {
    await call();
    const constrained = new Set(ownerConstraints().map((c) => c.collection));
    const queriedScoped = queriedCollections.filter((c) => (COLLECTIONS as readonly string[]).includes(c));
    expect(queriedScoped.length).toBeGreaterThan(0);
    for (const c of new Set(queriedScoped)) expect(constrained).toContain(c);
    for (const c of ownerConstraints()) {
      const named = Array.isArray(c.value) ? c.value : [c.value];
      expect(named).toEqual([OWNER_A]);
    }
  });

  it("an EMPTY finite set returns nothing and queries no owner-scoped collection", async () => {
    visibility = { ...EMPTY };
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("runs");
    expect(rowsOf(body)).toEqual([]);
    // Exact label, not merely "not admin_global" — a decorative string cannot
    // carry the property, so it is pinned precisely.
    expect((body as { queueScope?: string }).queueScope).toBe("no_assigners");
    // The degradation this catches: `[]` becoming "no filter".
    expect(queriedCollections.filter((c) => (COLLECTIONS as readonly string[]).includes(c))).toEqual([]);
  });

  it("only a genuine governance admin sees another owner's rows", async () => {
    visibility = { ...GLOBAL };
    const res = await call();
    const body = await res.json();
    expect(rowsOf(body).some((r) => r.userId === OWNER_B)).toBe(true);
  });
});

// ------------------------------------------- AUDIT GLOBAL LIST (no runId) --
/**
 * Phase FIRST-ADMIN-C5. The C4-R1 review found this path had ZERO enforcement
 * coverage: `vis.visibleUserIds` is resolved and then never consulted, and the
 * only narrowing is `filterEventsToViewerActions`. Deleting that one line
 * returned every user's governance audit rows — owner email, question text,
 * consensus score — to any full-plan reviewer, and passed the whole suite.
 */
describe("governance AUDIT global list (no runId) narrows to the viewer's own actions", () => {
  const call = async () => {
    const { GET } = await import("@/app/api/governance/audit/route");
    return GET(new NextRequest("http://localhost/api/governance/audit", { headers: { authorization: "Bearer t" } }));
  };

  it("THE CORE PROOF: another actor's audit rows are not disclosed", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    // The row performed by the viewer is present; the other tenant's is not,
    // in any field — actor, owner uid, owner email, or question text.
    expect(raw).toContain("ev-mine");
    expect(raw).not.toContain("ev-theirs");
    expect(raw).not.toContain("SECRET-OTHER-TENANT-QUESTION");
    expect(raw).not.toContain("someone-else");
    expect(raw).not.toContain(`${OWNER_B}@test-invented.example`);
  });

  it("a scoped reviewer sees only their own actions even with a finite owner set", async () => {
    visibility = { ...SCOPED };
    const raw = JSON.stringify(await (await call()).json());
    expect(raw).toContain("ev-mine");
    expect(raw).not.toContain("ev-theirs");
  });
});

// ------------------------------------------------------ LOG REDACTION (call site) --
/**
 * Phase FIRST-ADMIN-C5. C4 redacted the allowlist at the HELPER and tested the
 * helper plus a hand-copied reproduction of the log line — so re-adding
 * `raw=${process.env.GOVERNANCE_ADMIN_EMAILS}` at the real call site passed all
 * 11,209 tests. This drives the real handler and inspects what it ACTUALLY
 * emitted.
 */
describe("the governance queue route emits no privileged address", () => {
  const CANARY_LOCAL = "c5-callsite-canary";
  const CANARY_DOMAIN = "leak-detector-invented.example";
  const CANARY = `${CANARY_LOCAL}@${CANARY_DOMAIN}`;

  it("THE CORE PROOF: no captured log line contains the allowlist in any form", async () => {
    process.env.GOVERNANCE_ADMIN_EMAILS = `  ${CANARY.toUpperCase()}  ,second-canary@${CANARY_DOMAIN}`;
    const captured: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      })
    );
    try {
      const { GET } = await import("@/app/api/governance/queue/route");
      await GET(new NextRequest("http://localhost/api/governance/queue?status=all", { headers: { authorization: "Bearer t" } }));
    } finally {
      for (const sp of spies) sp.mockRestore();
    }
    const all = captured.join("\n");
    expect(captured.length).toBeGreaterThan(0); // the route really did log
    for (const forbidden of [CANARY, CANARY.toUpperCase(), CANARY_LOCAL, CANARY_LOCAL.toUpperCase(), CANARY_DOMAIN, CANARY_DOMAIN.toUpperCase(), "second-canary"]) {
      expect(all).not.toContain(forbidden);
    }
    // The useful diagnostic survives.
    expect(all).toContain("configured=2");
  });
});
