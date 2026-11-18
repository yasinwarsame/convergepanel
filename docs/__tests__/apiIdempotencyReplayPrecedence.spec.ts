/**
 * Addendum 3, m3 — idempotent replay precedence, executable.
 *
 * Drives the reference model (support/idempotencyReferenceModel.ts) with:
 *   1. every row of the truth table in jobs-and-idempotency.md §5A.3, PARSED from the markdown
 *      (each `any` expanded over every new-job condition), so the document and the model cannot
 *      drift;
 *   2. state transitions (committed → deleted, committed → expired, in_progress → committed);
 *   3. every interleaving of two and three concurrent requests (identical, different, and with a
 *      concurrent revocation or availability change), asserting exactly one job, reservation and
 *      dispatch, and identical accepted responses;
 *   4. negative cases (invalid bodies, a live key without a key, NFC-equivalent and
 *      NFC-different bodies).
 */
import * as fs from "fs";
import * as path from "path";
import {
  ApiResponse,
  CreateRequest,
  IDEMPOTENCY_TTL_MS,
  IdemRecord,
  KeyDoc,
  MAX_TX_ATTEMPTS,
  OrgDoc,
  System,
  ADMISSION_MARKER_FIELD,
  CONCURRENCY_RECORD_TEMPLATE,
  ConcurrencyDoc,
  JobDoc,
  PeriodDoc,
  RELEASE_MARKER_FIELD,
  concurrencyPath,
  countedActive,
  DeletionOp,
  PLATFORM_FAULT_CODES,
  deletionPath,
  detectDrift,
  detectDriftTx,
  finishJob,
  handleDelete,
  handleGet,
  recordCallResult,
  sweep,
  workerBoundary,
  workerProviderCall,
  workerStart,
  periodPath,
  failureControls,
  FAILED_COUNT_HARD_1H,
  FAILED_COST_HARD_USD_24H,
  FAILED_RATIO_SOFT,
  FAILED_RATIO_MIN_JOBS,
  FAILED_COUNT_HARD_24H,
  SHORT_CIRCUIT_THRESHOLD,
  SHORT_CIRCUIT_CODES,
  CUSTOMER_FAILURE_CODES,
  outcomePath,
  OutcomeDoc,
  CostDoc,
  CallOutcome,
  JobState,
  repairConcurrency,
  handleCancel,
  handleCreate,
  idemPath,
  runToEnd,
} from "./support/idempotencyReferenceModel";
import * as model from "./support/idempotencyReferenceModel";

const ROOT = path.resolve(__dirname, "..", "..");
const JOBS = path.join(ROOT, "docs/product/api-0/jobs-and-idempotency.md");

const NEW_JOB_CONDITIONS = [
  "pass", "model_unavailable", "credits_exhausted", "queue_unhealthy", "plan_models_reduced",
  "type_disabled", "ack_withdrawn", "concurrency_full", "capacity_shed",
] as const;
type Cond = (typeof NEW_JOB_CONDITIONS)[number];

interface Row { id: string; record: string; request: string; caller: string; cond: string; response: string; job: "yes" | "no" }

function truthTable(): Row[] {
  const md = fs.readFileSync(JOBS, "utf8");
  const start = md.indexOf("### 5A.3");
  const end = md.indexOf("### 5A.4", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const rows: Row[] = [];
  for (const line of md.slice(start, end).split("\n")) {
    const m = /^\| (T\d+) \| (\w+) \| ([\w/]+) \| (\w+) \| (\w+) \| ([^|]+?) \| (yes|no) \|$/.exec(line);
    if (m) rows.push({ id: m[1], record: m[2], request: m[3], caller: m[4], cond: m[5], response: m[6], job: m[7] as "yes" | "no" });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const SAME = { type: "research", input: { question: "What are the main risks?" }, models: ["chatgpt", "claude", "gemini"] };
const DIFFERENT = { type: "research", input: { question: "What are the main benefits?" }, models: ["chatgpt", "claude", "gemini"] };
const IDEM = "idem-key-0001";

function world(): System {
  const sys = new System();
  const org: OrgDoc = { status: "active", livePlanActive: true, creditsRemaining: 1000, pipelineAck: true, planMaxModels: 5, concurrencyLimit: 5 };
  sys.store.put("orgs/o1", org);
  const live: KeyDoc = { orgId: "o1", appId: "a1", mode: "live", scopes: ["verifications:write", "verifications:read", "verifications:delete"], revoked: false };
  sys.store.put("keys/live1", live);
  sys.store.put("keys/test1", { ...live, mode: "test" });
  sys.store.put("keys/live_app2", { ...live, appId: "a2" });
  return sys;
}

const req = (body: unknown, over: Partial<CreateRequest> = {}): CreateRequest => ({ keyId: "live1", idempotencyKey: IDEM, body, ...over });
const scopeOf = (sys: System, keyId = "live1", key = IDEM): string => idemPath(sys.store.get<KeyDoc>(`keys/${keyId}`) as KeyDoc, key);
const send = (sys: System, r: CreateRequest): ApiResponse => runToEnd(handleCreate(sys, r));

function patchOrg(sys: System, p: Partial<OrgDoc>): void {
  sys.store.put("orgs/o1", { ...(sys.store.get<OrgDoc>("orgs/o1") as OrgDoc), ...p });
}
function patchKey(sys: System, id: string, p: Partial<KeyDoc>): void {
  sys.store.put(`keys/${id}`, { ...(sys.store.get<KeyDoc>(`keys/${id}`) as KeyDoc), ...p });
}

/** Sets up the record state; returns the original 202 if one was accepted. */
function setupRecord(sys: System, record: string): ApiResponse | null {
  const accept = (r: CreateRequest): ApiResponse => {
    const res = send(sys, r);
    expect(res.status).toBe(202);
    return res;
  };
  switch (record) {
    case "none":
      return null;
    case "committed":
      return accept(req(SAME));
    case "expired": {
      const res = accept(req(SAME));
      sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
      return res;
    }
    case "deleted": {
      const res = accept(req(SAME));
      sys.deleteVerification(scopeOf(sys));
      return res;
    }
    case "in_progress":
      sys.store.holdLock(scopeOf(sys), "other-transaction");
      return null;
    case "other_mode":
      return accept(req(SAME, { keyId: "test1" }));
    case "other_app":
      return accept(req(SAME, { keyId: "live_app2" }));
    default:
      throw new Error(`unknown record state in the truth table: ${record}`);
  }
}

function applyCaller(sys: System, caller: string): void {
  switch (caller) {
    case "authorized": return;
    case "key_revoked": return patchKey(sys, "live1", { revoked: true });
    case "scope_reduced": return patchKey(sys, "live1", { scopes: ["verifications:read"] });
    case "org_suspended": return patchOrg(sys, { status: "suspended" });
    case "plan_lapsed": return patchOrg(sys, { livePlanActive: false });
    case "rate_limited": sys.dynamic.rateRemaining.set("live1", 0); return;
    default: throw new Error(`unknown caller condition in the truth table: ${caller}`);
  }
}

function applyCondition(sys: System, cond: Cond): void {
  switch (cond) {
    case "pass": return;
    case "model_unavailable": sys.dynamic.modelsAvailable.delete("gemini"); return;
    case "credits_exhausted": return patchOrg(sys, { creditsRemaining: 0 });
    case "queue_unhealthy": sys.dynamic.queueHealthy = false; return;
    case "plan_models_reduced": return patchOrg(sys, { planMaxModels: 2 });
    case "type_disabled": sys.dynamic.typeEnabled.research = false; return;
    case "ack_withdrawn": return patchOrg(sys, { pipelineAck: false });
    case "concurrency_full": sys.store.put(concurrencyPath("o1"), { active: 5, anomalies: 0 }); return;
    case "capacity_shed": sys.dynamic.capacityShed = true; return;
  }
}

/** The organization's concurrency record (the one counter, §5B). */
const active = (sys: System, org = "o1"): number => sys.store.get<ConcurrencyDoc>(concurrencyPath(org))?.active ?? 0;

const fmt = (r: ApiResponse): string => (r.status === 202 ? (r.replayed ? "202 replay" : "202 new") : `${r.status} ${r.code}`);

// ---------------------------------------------------------------------------------------------
describe("m3: the truth table in jobs-and-idempotency.md §5A.3 is executable", () => {
  const rows = truthTable();

  it("parses, covers every case the owner named, and every `any` row is expandable", () => {
    expect(rows.length).toBe(30);
    expect(rows.map((r) => r.id)).toEqual(rows.map((_, i) => `T${i + 1}`));
    const has = (p: (r: Row) => boolean): boolean => rows.some(p);
    // The owner's list: no record / committed same / committed different / in-progress same /
    // in-progress different / expired / job deleted / key revoked / key scope reduced /
    // org suspended / mode mismatch, crossed with dynamic-condition changes.
    expect(has((r) => r.record === "none")).toBe(true);
    expect(has((r) => r.record === "committed" && r.request === "same" && r.cond === "any")).toBe(true);
    expect(has((r) => r.record === "committed" && r.request === "different")).toBe(true);
    expect(has((r) => r.record === "in_progress" && r.request === "same")).toBe(true);
    expect(has((r) => r.record === "in_progress" && r.request === "different")).toBe(true);
    expect(has((r) => r.record === "expired")).toBe(true);
    expect(has((r) => r.record === "deleted")).toBe(true);
    for (const c of ["key_revoked", "scope_reduced", "org_suspended", "plan_lapsed", "rate_limited"]) {
      expect({ c, present: has((r) => r.caller === c && r.record === "committed") }).toEqual({ c, present: true });
    }
    expect(has((r) => r.record === "other_mode")).toBe(true);
    for (const c of NEW_JOB_CONDITIONS.filter((x) => x !== "pass")) {
      expect({ c, present: has((r) => r.record === "none" && r.cond === c) }).toEqual({ c, present: true });
    }
  });

  const cases: Array<[string, Row, Cond]> = [];
  for (const r of rows) {
    const conds: Cond[] = r.cond === "any" ? [...NEW_JOB_CONDITIONS] : [r.cond as Cond];
    for (const c of conds) {
      expect(NEW_JOB_CONDITIONS).toContain(c);
      cases.push([`${r.id} ${r.record}/${r.request}/${r.caller}/${c} → ${r.response}`, r, c]);
    }
  }

  it.each(cases)("%s", (_name, row, cond) => {
    const sys = world();
    const original = setupRecord(sys, row.record);
    applyCaller(sys, row.caller);
    applyCondition(sys, cond);
    const jobsBefore = sys.jobs().length;
    const resBefore = sys.reservations().length;
    const dispBefore = sys.dispatched.length;
    const res = send(sys, req(row.request === "different" ? DIFFERENT : SAME));

    expect(fmt(res)).toBe(row.response);
    const created = sys.jobs().length - jobsBefore;
    expect(created).toBe(row.job === "yes" ? 1 : 0);
    expect(sys.reservations().length - resBefore).toBe(created);
    expect(sys.dispatched.length - dispBefore).toBe(created);
    if (row.response === "202 replay") {
      // The ORIGINAL accepted response, byte for byte.
      expect(res.body).toEqual(original?.body);
    }
    if (row.response === "202 new" && original?.body) expect(res.body?.id).not.toBe(original.body.id);
  });
});

describe("m3: state transitions", () => {
  it("committed → replay → deleted → 410 → expired → new job", () => {
    const sys = world();
    const first = send(sys, req(SAME));
    expect(fmt(first)).toBe("202 new");
    expect(send(sys, req(SAME))).toEqual({ status: 202, body: first.body, replayed: true });
    sys.deleteVerification(scopeOf(sys));
    expect(fmt(send(sys, req(SAME)))).toBe("410 verification_deleted");
    const marker = sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord;
    expect(marker.requestHash).toBeUndefined(); // content-free
    sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
    const again = send(sys, req(SAME));
    expect(fmt(again)).toBe("202 new");
    expect(again.body?.id).not.toBe(first.body?.id);
    expect(sys.dispatched).toEqual([first.body?.id, again.body?.id]);
  });

  it("in_progress → the holder commits → a retry replays the holder's response", () => {
    const sys = world();
    const scope = scopeOf(sys);
    sys.store.holdLock(scope, "holder");
    expect(fmt(send(sys, req(SAME)))).toBe("409 request_in_progress");
    expect(sys.jobs()).toEqual([]);
    // The holder commits its record (as T-create would) and releases the lock.
    const body = { object: "verification" as const, id: "ver_holder", status: "queued" as const, type: "research", credits_reserved: 6 };
    sys.store.put(scope, { kind: "committed", requestHash: recordHashOf(SAME), verificationId: body.id, response: body, expiresAt: sys.dynamic.now + IDEMPOTENCY_TTL_MS });
    sys.store.releaseLock(scope, "holder");
    expect(send(sys, req(SAME))).toEqual({ status: 202, body, replayed: true });
    expect(fmt(send(sys, req(DIFFERENT)))).toBe("409 idempotency_key_reused");
  });

  it.each([
    ["one millisecond before expiresAt → replay", -1, "202 replay"],
    ["exactly at expiresAt → expired, new job", 0, "202 new"],
    ["one millisecond after expiresAt → expired, new job", 1, "202 new"],
  ])("expiry boundary: %s", (_n, delta, expected) => {
    const sys = world();
    const first = send(sys, req(SAME));
    const rec = sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord;
    sys.dynamic.now = rec.expiresAt + (delta as number);
    const res = send(sys, req(SAME));
    expect(fmt(res)).toBe(expected);
    if (expected === "202 replay") expect(res.body).toEqual(first.body);
    else expect(res.body?.id).not.toBe(first.body?.id);
  });

  it("a throttled replay writes nothing, and the next window replays the same response", () => {
    const sys = world();
    const first = send(sys, req(SAME));
    sys.dynamic.rateRemaining.set("live1", 0);
    expect(fmt(send(sys, req(SAME)))).toBe("429 rate_limited");
    sys.dynamic.rateRemaining.set("live1", 10);
    expect(send(sys, req(SAME))).toEqual({ status: 202, body: first.body, replayed: true });
    expect(sys.jobs().length).toBe(1);
    expect(sys.dispatched.length).toBe(1);
  });

  it("a replay never consumes credits or concurrency again", () => {
    const sys = world();
    send(sys, req(SAME));
    const after = sys.store.get<OrgDoc>("orgs/o1") as OrgDoc;
    for (let i = 0; i < 5; i++) send(sys, req(SAME));
    expect(sys.store.get<OrgDoc>("orgs/o1")).toEqual(after);
  });
});

/** The canonical request the model stores for a body (via a throwaway world). */
function recordHashOf(body: unknown): string {
  const sys = world();
  expect(send(sys, req(body)).status).toBe(202);
  return (sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord).requestHash as string;
}

// ---------------------------------------------------------------------------------------------
// Interleavings
// ---------------------------------------------------------------------------------------------
type Proc = { name: string; start: (sys: System) => Generator<void, ApiResponse | null, void> };

const create = (name: string, r: CreateRequest): Proc => ({ name, start: (sys) => handleCreate(sys, r) });
/** A one-step administrative change that happens at some point of the schedule. */
const event = (name: string, apply: (sys: System) => void): Proc => ({
  name,
  start: function* (sys: System) {
    yield;
    apply(sys);
    return null;
  },
});

interface Outcome { schedule: number[]; results: Array<ApiResponse | null>; sys: System; finishedAt: number[] }

/** Enumerates every interleaving (each step of each process is a scheduling choice). */
function interleavings(setup: () => System, procs: Proc[]): Outcome[] {
  const out: Outcome[] = [];
  const explore = (prefix: number[]): void => {
    const sys = setup();
    const gens = procs.map((p) => p.start(sys));
    const results: Array<ApiResponse | null | undefined> = procs.map(() => undefined);
    const finishedAt: number[] = procs.map(() => -1);
    const step = (i: number, at: number): void => {
      const r = gens[i].next();
      if (r.done) {
        results[i] = r.value;
        finishedAt[i] = at;
      }
    };
    prefix.forEach((i, at) => step(i, at));
    const runnable = results.map((r, i) => (r === undefined ? i : -1)).filter((i) => i >= 0);
    if (runnable.length === 0) {
      out.push({ schedule: prefix, results: results as Array<ApiResponse | null>, sys, finishedAt });
      return;
    }
    for (const i of runnable) explore([...prefix, i]);
  };
  explore([]);
  return out;
}

describe("m3: concurrency — every interleaving", () => {
  const assertOneJob = (o: Outcome, label: string): void => {
    expect({ label, schedule: o.schedule, jobs: o.sys.jobs().length }).toEqual({ label, schedule: o.schedule, jobs: 1 });
    expect(o.sys.reservations().length).toBe(1);
    expect(o.sys.dispatched.length).toBe(1);
  };

  it.each([2, 3])("%i identical first requests → exactly one job, one reservation, identical 202s", (n) => {
    const outcomes = interleavings(world, Array.from({ length: n }, (_, i) => create(`r${i}`, req(SAME))));
    expect(outcomes.length).toBeGreaterThan(n === 2 ? 10 : 100);
    let sawInProgress = false;
    for (const o of outcomes) {
      assertOneJob(o, `${n} identical`);
      const accepted = o.results.filter((r): r is ApiResponse => r !== null && r.status === 202);
      expect(accepted.length).toBeGreaterThanOrEqual(1);
      expect(accepted.filter((r) => !r.replayed).length).toBe(1);
      const ids = new Set(accepted.map((r) => JSON.stringify(r.body)));
      expect(ids.size).toBe(1);
      for (const r of o.results) {
        if (r && r.status !== 202) {
          expect(fmt(r)).toBe("409 request_in_progress");
          sawInProgress = true;
        }
      }
      // A request that got 409 request_in_progress replays the same response on retry.
      const retry = send(o.sys, req(SAME));
      expect(retry).toEqual({ status: 202, body: accepted[0].body, replayed: true });
      expect(o.sys.jobs().length).toBe(1);
    }
    expect(sawInProgress).toBe(true); // the bounded-retry branch is reachable, so it is exercised
  });

  it("two different requests with one key → one job; the other is 409", () => {
    for (const o of interleavings(world, [create("same", req(SAME)), create("diff", req(DIFFERENT))])) {
      assertOneJob(o, "different");
      const codes = o.results.map((r) => fmt(r as ApiResponse)).sort();
      expect(["202 new"]).toEqual(codes.filter((c) => c.startsWith("202")));
      for (const c of codes.filter((x) => !x.startsWith("202"))) expect(["409 idempotency_key_reused", "409 request_in_progress"]).toContain(c);
    }
  });

  it("identical requests racing a key revocation → at most one job; no replay after the revocation commits", () => {
    for (const o of interleavings(world, [create("a", req(SAME)), create("b", req(SAME)), event("revoke", (s) => patchKey(s, "live1", { revoked: true }))])) {
      expect(o.sys.jobs().length).toBeLessThanOrEqual(1);
      expect(o.sys.dispatched.length).toBe(o.sys.jobs().length);
      const accepted = o.results.filter((r): r is ApiResponse => r !== null && r.status === 202);
      expect(new Set(accepted.map((r) => r.body?.id)).size).toBeLessThanOrEqual(1);
      for (const r of o.results) if (r) expect(["202 new", "202 replay", "401 invalid_api_key", "409 request_in_progress"]).toContain(fmt(r));
      // A request whose final (committing) step ran after the revocation never gets a 202:
      // its transaction re-read the key, or its commit failed validation and retried.
      const revokedAt = o.finishedAt[2];
      for (const i of [0, 1]) {
        const r = o.results[i] as ApiResponse;
        if (o.finishedAt[i] > revokedAt) expect({ schedule: o.schedule, i, got: fmt(r) }).not.toEqual({ schedule: o.schedule, i, got: expect.stringMatching(/^202/) });
      }
      // After the revocation, the key never obtains the replay.
      expect(fmt(send(o.sys, req(SAME)))).toBe("401 invalid_api_key");
    }
  });

  it.each([
    ["key scope reduction", (s: System) => patchKey(s, "live1", { scopes: ["verifications:read"] }), "403 insufficient_scope"],
    ["organization suspension", (s: System) => patchOrg(s, { status: "suspended" }), "403 org_suspended"],
    ["live plan lapsing", (s: System) => patchOrg(s, { livePlanActive: false }), "403 live_key_requires_plan"],
  ] as Array<[string, (s: System) => void, string]>)("identical requests racing %s (step 8b) → no 202 after it commits", (_n, change, denied) => {
    // Start from a committed record so both racers would replay; the change may land between
    // the outside checks (steps 5–6) and T-create. Only the in-transaction re-check stops them.
    const setup = (): System => {
      const s = world();
      expect(send(s, req(SAME)).status).toBe(202);
      return s;
    };
    let raced = 0;
    for (const o of interleavings(setup, [create("a", req(SAME)), create("b", req(SAME)), event("change", change)])) {
      const changedAt = o.finishedAt[2];
      for (const i of [0, 1]) {
        const r = o.results[i] as ApiResponse;
        if (o.finishedAt[i] > changedAt) {
          raced++;
          expect({ schedule: o.schedule, i, ok: [denied, "409 request_in_progress"].includes(fmt(r)) }).toEqual({ schedule: o.schedule, i, ok: true });
        } else expect(["202 replay", denied]).toContain(fmt(r));
      }
      expect(o.sys.jobs().length).toBe(1);
      expect(fmt(send(o.sys, req(SAME)))).toBe(denied);
    }
    expect(raced).toBeGreaterThan(0);
  });

  it("identical requests racing a model becoming unavailable → at most one job; once accepted, replays survive", () => {
    for (const o of interleavings(world, [create("a", req(SAME)), create("b", req(SAME)), event("model down", (s) => s.dynamic.modelsAvailable.delete("gemini"))])) {
      expect(o.sys.jobs().length).toBeLessThanOrEqual(1);
      const accepted = o.results.filter((r): r is ApiResponse => r !== null && r.status === 202);
      expect(new Set(accepted.map((r) => r.body?.id)).size).toBeLessThanOrEqual(1);
      for (const r of o.results) if (r) expect(["202 new", "202 replay", "422 model_unavailable", "409 request_in_progress"]).toContain(fmt(r));
      const after = send(o.sys, req(SAME));
      if (o.sys.jobs().length === 1) expect(after).toEqual({ status: 202, body: accepted[0].body, replayed: true });
      else expect(fmt(after)).toBe("422 model_unavailable");
    }
  });

  it("the bounded retry limit is the documented MAX_TX_ATTEMPTS", () => {
    expect(MAX_TX_ATTEMPTS).toBe(3);
  });
});

describe("m3: negative cases", () => {
  it("an invalid body is 400 even when a committed record exists for the key", () => {
    const sys = world();
    send(sys, req(SAME));
    expect(fmt(send(sys, req([SAME])))).toBe("400 invalid_request");
    expect(fmt(send(sys, req({ ...SAME, type: "video" })))).toBe("400 invalid_request");
    expect(sys.jobs().length).toBe(1);
  });

  it("a live key without Idempotency-Key is 400; a test key without one always creates", () => {
    const sys = world();
    expect(fmt(send(sys, { keyId: "live1", body: SAME }))).toBe("400 invalid_request");
    expect(fmt(send(sys, { keyId: "test1", body: SAME }))).toBe("202 new");
    expect(fmt(send(sys, { keyId: "test1", body: SAME }))).toBe("202 new");
    expect(sys.jobs().length).toBe(2);
  });

  it("NFC-equivalent bodies and member order replay; an NFC-preserved difference is 409", () => {
    const sys = world();
    const composed = { type: "research", input: { question: "Is café culture healthy?" }, models: ["chatgpt", "claude", "gemini"] };
    const decomposed = { models: ["chatgpt", "claude", "gemini"], input: { question: "Is café culture healthy?" }, type: "research" };
    const trailing = { ...composed, input: { question: "Is café culture healthy? " } };
    const first = send(sys, req(composed));
    expect(send(sys, req(decomposed))).toEqual({ status: 202, body: first.body, replayed: true });
    expect(fmt(send(sys, req(trailing)))).toBe("409 idempotency_key_reused");
  });

  it("an omitted default and an explicit default are different requests (fail-safe 409, no second job)", () => {
    const sys = world();
    send(sys, req(SAME));
    expect(fmt(send(sys, req({ ...SAME, options: { synthesis: false } })))).toBe("409 idempotency_key_reused");
    expect(fmt(send(sys, req({ ...SAME, models: ["chatgpt", "claude", "gemini"] })))).toBe("202 replay"); // identical members replay
    expect(sys.jobs().length).toBe(1);
  });

  it("a different Prefer header is a different request", () => {
    const sys = world();
    send(sys, req(SAME));
    expect(fmt(send(sys, req(SAME, { prefer: "wait=30" })))).toBe("409 idempotency_key_reused");
  });

  it("an unknown key is 401 and a foreign application's record is never visible", () => {
    const sys = world();
    send(sys, req(SAME, { keyId: "live_app2" }));
    expect(fmt(send(sys, req(SAME, { keyId: "nope" })))).toBe("401 invalid_api_key");
    expect(fmt(send(sys, req(DIFFERENT)))).toBe("202 new"); // own scope has no record
  });
});

// ---------------------------------------------------------------------------------------------
// Addendum 4: deleted marker, cancel, exact concurrency
// ---------------------------------------------------------------------------------------------
describe("Addendum 4 DM: an unexpired deleted marker answers 410 whatever the body, and keeps no request content", () => {
  it.each([["same", SAME], ["different", DIFFERENT], ["NFC-equivalent", { ...SAME, models: ["chatgpt", "claude", "gemini"] }]])("%s body → 410", (_n, body) => {
    const sys = world();
    send(sys, req(SAME));
    sys.deleteVerification(scopeOf(sys));
    const marker = sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord;
    // Content-free: identifiers only (Addendum 7 adds the immutable acceptance identity).
    expect(Object.keys(marker).sort()).toEqual(["acceptanceId", "expiresAt", "kind", "verificationId"]);
    expect(fmt(send(sys, req(body)))).toBe("410 verification_deleted");
    expect(sys.jobs().filter((j) => !(sys.store.get<JobDoc>(j) as JobDoc).deleted).length).toBe(0);
  });
});

interface CancelRow { id: string; target: string; state: string; response: string; count: string }
function cancelTable(): CancelRow[] {
  const md = fs.readFileSync(JOBS, "utf8");
  const sec = md.slice(md.indexOf("### 6.1 Cancel truth table"), md.indexOf("## 7."));
  return Array.from(sec.matchAll(/^\| (C\d+) \| (\w+) \| ([\w/]+) \| ([^|]+?) \| ([^|]+?) \|$/gm), (m) => ({ id: m[1], target: m[2], state: m[3], response: m[4], count: m[5] }));
}

describe("Addendum 4 CX: cancel (jobs-and-idempotency.md §6.1, parsed)", () => {
  const rows = cancelTable();

  it("the table has the eight documented rows", () => {
    expect(rows.map((r) => r.id)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
  });

  const setupCancel = (row: CancelRow): { sys: System; target: string } => {
    const sys = world();
    sys.store.put("orgs/o2", { ...(sys.store.get<OrgDoc>("orgs/o1") as OrgDoc) });
    sys.store.put("keys/foreign", { orgId: "o2", appId: "b1", mode: "live", scopes: ["verifications:write", "verifications:delete"], revoked: false } satisfies KeyDoc);
    const owner = row.target === "foreign" ? "foreign" : "live1";
    if (row.target === "nonexistent") return { sys, target: "ver_" + "9".repeat(24) };
    if (row.target === "malformed") return { sys, target: "ver_bad" };
    const res = send(sys, { keyId: owner, idempotencyKey: "c-" + row.id, body: SAME });
    expect(res.status).toBe(202);
    const id = res.body?.id as string;
    const scope = idemPath(sys.store.get<KeyDoc>(`keys/${owner}`) as KeyDoc, "c-" + row.id);
    const job = sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc;
    if (row.state === "running") sys.store.put(`jobs/${id}`, { ...job, state: "running" });
    if (row.state === "completed") runToEnd(finishJob(sys, id, "completed"));
    if (row.state === "deleted") {
      expect(sys.deleteVerification(scope, owner).status).toBe(202);
      expect((sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc).deleted).toBe(true);
    }
    return { sys, target: id };
  };

  it.each(rows.map((r) => [`${r.id} ${r.target}/${r.state} → ${r.response}`, r] as const))("%s", (_n, row) => {
    const { sys, target } = setupCancel(row);
    const runningBefore = active(sys);
    const res = runToEnd(handleCancel(sys, "live1", target));
    const expected = row.response.split(" ");
    expect(res.status).toBe(Number(expected[0]));
    if (res.status !== 200) expect(res.code).toBe(expected[1]);
    const runningAfter = active(sys);
    expect(runningAfter - runningBefore).toBe(row.count === "released" ? -1 : 0);
  });

  it("C5–C8 are byte-identical (a foreign deleted verification is not distinguishable from none)", () => {
    const bodies = rows.filter((r) => ["foreign", "nonexistent", "malformed"].includes(r.target)).map((r) => {
      const { sys, target } = setupCancel(r);
      return JSON.stringify(runToEnd(handleCancel(sys, "live1", target)));
    });
    expect(new Set(bodies).size).toBe(1);
  });

  it("a queued cancel releases credits fully and is idempotent (second cancel → 409, no double release)", () => {
    const sys = world();
    const res = send(sys, req(SAME));
    const id = res.body?.id as string;
    const before = sys.store.get<OrgDoc>("orgs/o1") as OrgDoc;
    expect(runToEnd(handleCancel(sys, "live1", id)).status).toBe(200);
    const after = sys.store.get<OrgDoc>("orgs/o1") as OrgDoc;
    expect(after.creditsRemaining - before.creditsRemaining).toBe(res.body?.credits_reserved);
    expect(active(sys)).toBe(0);
    expect(fmt(runToEnd(handleCancel(sys, "live1", id)))).toBe("409 not_cancelable");
    expect(runToEnd(finishJob(sys, id, "failed")).status).toBe(200); // no-op release
    expect(sys.store.get<OrgDoc>("orgs/o1")).toEqual(after);
  });
});

describe("Addendum 4 CC: exact concurrency across distinct keys", () => {
  const limited = (limit: number) => (): System => {
    const s = world();
    patchOrg(s, { concurrencyLimit: limit });
    s.store.put("keys/live2", { ...(s.store.get<KeyDoc>("keys/live1") as KeyDoc) });
    return s;
  };

  it.each([
    [1, 2],
    [2, 3],
  ])("limit %i, %i distinct-key creates racing → never more accepted jobs than the limit", (limit, n) => {
    const procs = Array.from({ length: n }, (_, i) => create(`r${i}`, { keyId: i % 2 === 0 ? "live1" : "live2", idempotencyKey: `distinct-${i}`, body: SAME }));
    const outcomes = interleavings(limited(limit), procs);
    expect(outcomes.length).toBeGreaterThan(10);
    let atLimit = 0;
    for (const o of outcomes) {
      const jobs = o.sys.jobs().length;
      expect({ schedule: o.schedule, jobs, overLimit: jobs > limit }).toEqual({ schedule: o.schedule, jobs, overLimit: false });
      expect(active(o.sys)).toBe(jobs);
      for (const r of o.results) expect(["202 new", "429 concurrency_limit", "409 request_in_progress"]).toContain(fmt(r as ApiResponse));
      if (jobs === limit) atLimit++;
    }
    expect(atLimit).toBeGreaterThan(0);
  });

  it("a terminal transition releases exactly once; the count never goes negative", () => {
    const sys = limited(1)();
    const a = send(sys, req(SAME, { idempotencyKey: "k-a" }));
    expect(fmt(send(sys, req(DIFFERENT, { idempotencyKey: "k-b" })))).toBe("429 concurrency_limit");
    const id = a.body?.id as string;
    runToEnd(finishJob(sys, id, "completed"));
    runToEnd(finishJob(sys, id, "completed"));
    runToEnd(finishJob(sys, id, "failed"));
    expect(active(sys)).toBe(0);
    expect(fmt(send(sys, req(DIFFERENT, { idempotencyKey: "k-b" })))).toBe("202 new");
  });

  it("concurrent releases of the same job (every interleaving) release once", () => {
    const setup = (): System => {
      const s = limited(1)();
      send(s, req(SAME));
      return s;
    };
    const id = (s: System): string => s.jobs()[0].slice("jobs/".length);
    const rel = (name: string, to: "completed" | "failed"): Proc => ({ name, start: (s) => finishJob(s, id(s), to) });
    for (const o of interleavings(setup, [rel("a", "completed"), rel("b", "failed")])) {
      expect(active(o.sys)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Addendum 5, MAJOR-1: one unsharded, organization-scoped concurrency record
// ---------------------------------------------------------------------------------------------
describe("Addendum 5 MAJOR-1: concurrency record location and release rule", () => {
  const sec = (): string => {
    const md = fs.readFileSync(JOBS, "utf8");
    return md.slice(md.indexOf("## 5B. Concurrency accounting"), md.indexOf("## 6. Cancellation"));
  };
  const declared = (label: string): string | undefined => new RegExp(`^\\*\\*${label}:\\*\\* \`([^\`]+)\`$`, "m").exec(sec())?.[1];

  it("the doc's declared counter location and markers equal the model's constants", () => {
    expect(declared("Counter location")).toBe(CONCURRENCY_RECORD_TEMPLATE);
    expect(declared("Release marker")).toBe(RELEASE_MARKER_FIELD);
    expect(declared("Admission marker")).toBe(ADMISSION_MARKER_FIELD);
    // Organization-scoped only: no month, period, year, shard or application in its identity.
    expect(CONCURRENCY_RECORD_TEMPLATE).toMatch(/\{orgId\}/);
    expect(CONCURRENCY_RECORD_TEMPLATE).not.toMatch(/YYYY|MM|month|period|shard|app/i);
    // The create transaction reads that record, not the period document, for the count.
    const md = fs.readFileSync(JOBS, "utf8");
    const t = md.slice(md.indexOf("### 5A.2"), md.indexOf("### 5A.3"));
    expect(t).toContain("`apiOrgConcurrency/{orgId}`");
    expect(t).not.toMatch(/period document \([^)]*active-job count/);
  });

  it("the model writes the count only to that record, whatever the month", () => {
    const sys = world();
    for (const now of [Date.UTC(2026, 10, 30, 23, 59, 59, 999), Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1)]) {
      sys.dynamic.now = now;
      expect(send(sys, req(SAME, { idempotencyKey: `m-${now}` })).status).toBe(202);
    }
    expect(active(sys)).toBe(3);
    const holders = sys.store.keys("").filter((k) => (sys.store.get<{ active?: number }>(k) ?? {}).active !== undefined);
    expect(holders).toEqual([concurrencyPath("o1")]);
  });

  interface ERow { id: string; before: string; released: string; event: string; countBefore: number; after: string; countAfter: number; anomaly: string }
  const releaseTable = (): ERow[] =>
    Array.from(sec().matchAll(/^\| (E\d+) \| (\w+) \| (yes|no) \| (\w+) \| (\d+) \| (\w+) \| (\d+) \| (yes|no) \|$/gm), (m) => ({
      id: m[1], before: m[2], released: m[3], event: m[4], countBefore: Number(m[5]), after: m[6], countAfter: Number(m[7]), anomaly: m[8],
    }));

  it("the release table has rows E1–E11", () => {
    expect(releaseTable().map((r) => r.id)).toEqual(Array.from({ length: 11 }, (_, i) => `E${i + 1}`));
  });

  const TO: Record<string, "completed" | "failed" | "expired"> = { complete: "completed", worker_timeout: "failed", expire: "expired" };

  it.each(releaseTable().map((r) => [`${r.id} ${r.before}/${r.event} → ${r.after}, count ${r.countBefore}→${r.countAfter}${r.anomaly === "yes" ? ", anomaly" : ""}`, r] as const))("%s", (_n, row) => {
    const sys = world();
    const res = send(sys, req(SAME));
    const id = res.body?.id as string;
    const path = `jobs/${id}`;
    const scope = scopeOf(sys);
    // Bring the job to its "before" state through the normal paths.
    if (row.before === "running") sys.store.put(path, { ...(sys.store.get<JobDoc>(path) as JobDoc), state: "running" });
    if (["completed", "canceled", "failed"].includes(row.before)) runToEnd(finishJob(sys, id, row.before as "completed" | "canceled" | "failed"));
    expect((sys.store.get<JobDoc>(path) as JobDoc)[RELEASE_MARKER_FIELD]).toBe(row.released === "yes");
    if (active(sys) !== row.countBefore) sys.store.put(concurrencyPath("o1"), { active: row.countBefore, anomalies: 0 });
    const auditBefore = sys.audit.length;
    if (row.event === "cancel") runToEnd(handleCancel(sys, "live1", id));
    else if (row.event === "delete") sys.deleteVerification(scope);
    else runToEnd(finishJob(sys, id, TO[row.event]));
    const job = sys.store.get<JobDoc>(path) as JobDoc;
    expect(job.state).toBe(row.after);
    expect(active(sys)).toBe(row.countAfter);
    expect(active(sys)).toBeGreaterThanOrEqual(0);
    expect(job[RELEASE_MARKER_FIELD]).toBe(["completed", "failed", "canceled", "expired", "partial"].includes(job.state));
    const anomalies = sys.audit.slice(auditBefore).filter((e) => e.type === "concurrency.release_anomaly");
    expect(anomalies.length).toBe(row.anomaly === "yes" ? 1 : 0);
    expect(job.concurrencyReleaseAnomaly === true).toBe(row.anomaly === "yes");
  });
});

describe("Addendum 5 MAJOR-1: deterministic scenarios", () => {
  const limitedWorld = (limit: number, now?: number) => (): System => {
    const s = world();
    patchOrg(s, { concurrencyLimit: limit });
    s.store.put("keys/live2", { ...(s.store.get<KeyDoc>("keys/live1") as KeyDoc) });
    if (now !== undefined) s.dynamic.now = now;
    return s;
  };
  /** No negative count and no silent leak: the record equals the counted, unreleased jobs. */
  const invariant = (s: System): void => {
    expect(active(s)).toBeGreaterThanOrEqual(0);
    expect(active(s)).toBe(countedActive(s, "o1"));
  };
  const NOV_LAST = Date.UTC(2026, 10, 30, 23, 59, 59, 999);
  const DEC_LAST = Date.UTC(2026, 11, 31, 23, 59, 59, 999);

  it("creates at the limit: the limit is admitted, the next is 429, a release admits one more", () => {
    const sys = limitedWorld(2)();
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "a" })))).toBe("202 new");
    const b = send(sys, req(SAME, { idempotencyKey: "b" }));
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "c" })))).toBe("429 concurrency_limit");
    invariant(sys);
    runToEnd(finishJob(sys, b.body?.id as string, "completed"));
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "c" })))).toBe("202 new");
    expect(active(sys)).toBe(2);
    invariant(sys);
  });

  it("last minute of the month: the count and limit carry over the month boundary", () => {
    const sys = limitedWorld(1, NOV_LAST)();
    const a = send(sys, req(SAME, { idempotencyKey: "nov" }));
    expect(a.status).toBe(202);
    sys.dynamic.now = NOV_LAST + 1; // 2026-12-01T00:00:00.000Z
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "dec" })))).toBe("429 concurrency_limit");
    runToEnd(finishJob(sys, a.body?.id as string, "completed"));
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "dec" })))).toBe("202 new");
    invariant(sys);
  });

  it("creates racing the month boundary (every interleaving) never exceed the limit", () => {
    const tick: Proc = event("month ends", (s) => { s.dynamic.now = NOV_LAST + 1; });
    for (const o of interleavings(limitedWorld(1, NOV_LAST), [
      create("a", { keyId: "live1", idempotencyKey: "x1", body: SAME }),
      create("b", { keyId: "live2", idempotencyKey: "x2", body: SAME }),
      tick,
    ])) {
      expect({ schedule: o.schedule, over: o.sys.jobs().length > 1 }).toEqual({ schedule: o.schedule, over: false });
      invariant(o.sys);
    }
  });

  it("a job running across year-end is released to the same record; the ledger month is the reservation month", () => {
    const sys = limitedWorld(1, DEC_LAST)();
    const a = send(sys, req(SAME));
    const id = a.body?.id as string;
    sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running" });
    sys.dynamic.now = DEC_LAST + 1; // 2027-01-01T00:00:00.000Z
    runToEnd(finishJob(sys, id, "completed"));
    expect(active(sys)).toBe(0);
    expect(sys.store.get<{ month: string }>(`ledger/reserve_${id}`)?.month).toBe("2026-12");
    expect(sys.store.get<PeriodDoc>(periodPath("o1", "2026-12"))?.reservedCredits).toBe(a.body?.credits_reserved);
    expect(sys.store.get<PeriodDoc>(periodPath("o1", "2027-01"))).toBeUndefined();
    expect(fmt(send(sys, req(DIFFERENT, { idempotencyKey: "jan" })))).toBe("202 new"); // capacity freed in the new year
    invariant(sys);
  });

  it("a sweeper (worker_timeout) racing normal completion: one terminal state, one release", () => {
    const setup = (): System => {
      const s = limitedWorld(1)();
      const r = send(s, req(SAME));
      s.store.put(`jobs/${r.body?.id}`, { ...(s.store.get<JobDoc>(`jobs/${r.body?.id}`) as JobDoc), state: "running" });
      return s;
    };
    const id = (s: System): string => s.jobs()[0].slice("jobs/".length);
    const outcomes = interleavings(setup, [
      { name: "worker", start: (s) => finishJob(s, id(s), "completed") },
      { name: "sweeper", start: (s) => finishJob(s, id(s), "failed") },
    ]);
    const states = new Set<string>();
    for (const o of outcomes) {
      states.add((o.sys.store.get<JobDoc>(o.sys.jobs()[0]) as JobDoc).state);
      expect(active(o.sys)).toBe(0);
      expect(o.sys.audit.filter((e) => e.type === "concurrency.release_anomaly")).toEqual([]);
      invariant(o.sys);
    }
    expect(Array.from(states).sort()).toEqual(["completed", "failed"]); // either may win; never both releases
  });

  it("cancellation followed by a late worker completion releases once and keeps the canceled state", () => {
    const sys = limitedWorld(1)();
    const a = send(sys, req(SAME));
    const id = a.body?.id as string;
    expect(runToEnd(handleCancel(sys, "live1", id)).status).toBe(200);
    runToEnd(finishJob(sys, id, "completed")); // late worker
    expect((sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc).state).toBe("canceled");
    expect(active(sys)).toBe(0);
    invariant(sys);
  });

  it("a failed (crashed) release fails safe: capacity held, detectable, recovered by the sweeper", () => {
    const sys = limitedWorld(1)();
    const a = send(sys, req(SAME));
    const id = a.body?.id as string;
    const crashed = finishJob(sys, id, "completed");
    crashed.next(); // reads done, then the worker dies before commit
    expect((sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc).state).toBe("pending_dispatch");
    expect(active(sys)).toBe(1); // held, never double-freed
    expect(fmt(send(sys, req(DIFFERENT, { idempotencyKey: "other" })))).toBe("429 concurrency_limit");
    invariant(sys);
    expect(detectDrift(sys, "o1")).toBe(false);
    runToEnd(finishJob(sys, id, "failed")); // sweeper: worker_timeout
    expect(active(sys)).toBe(0);
    invariant(sys);
  });

  it("reconciliation detects drift without writing; the audited repair corrects it", () => {
    const sys = limitedWorld(5)();
    send(sys, req(SAME));
    sys.store.put(concurrencyPath("o1"), { active: 3, anomalies: 0 }); // drift (corruption)
    const before = sys.store.get<ConcurrencyDoc>(concurrencyPath("o1"));
    expect(detectDrift(sys, "o1")).toBe(true);
    expect(sys.store.get<ConcurrencyDoc>(concurrencyPath("o1"))).toEqual(before); // detection never writes
    expect(sys.audit.map((e) => e.type)).toContain("concurrency.drift_detected");
    runToEnd(repairConcurrency(sys, "o1"));
    expect(active(sys)).toBe(1);
    expect(sys.audit.map((e) => e.type)).toContain("concurrency.repaired");
    invariant(sys);
  });

  it("the repair racing admissions and releases (every interleaving) ends consistent", () => {
    const setup = (): System => {
      const s = limitedWorld(5)();
      const r = send(s, req(SAME, { idempotencyKey: "first" }));
      s.store.put(concurrencyPath("o1"), { active: 4, anomalies: 0 }); // drift to repair
      void r;
      return s;
    };
    const firstId = (s: System): string => s.jobs()[0].slice("jobs/".length);
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "repair", start: (s) => repairConcurrency(s, "o1") },
      create("admit", { keyId: "live2", idempotencyKey: "second", body: DIFFERENT }),
      { name: "release", start: (s) => finishJob(s, firstId(s), "completed") },
    ])) {
      n++;
      expect({ schedule: o.schedule, active: active(o.sys) }).toEqual({ schedule: o.schedule, active: countedActive(o.sys, "o1") });
    }
    expect(n).toBeGreaterThan(50);
  });

  it("a release due at count 0 commits the terminal state, records an anomaly, and never goes negative", () => {
    const sys = limitedWorld(5)();
    const a = send(sys, req(SAME));
    sys.store.put(concurrencyPath("o1"), { active: 0, anomalies: 0 });
    runToEnd(finishJob(sys, a.body?.id as string, "completed"));
    expect((sys.store.get<JobDoc>(`jobs/${a.body?.id}`) as JobDoc).state).toBe("completed");
    expect(sys.store.get<ConcurrencyDoc>(concurrencyPath("o1"))).toEqual({ active: 0, anomalies: 1 });
    expect(sys.audit.filter((e) => e.type === "concurrency.release_anomaly").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Addendum 6: deletion of a running job — cancellation and settlement before purge
// ---------------------------------------------------------------------------------------------
describe("Addendum 6: deletion lifecycle (jobs-and-idempotency.md §6.2, parsed)", () => {
  interface DRow { id: string; at: string; then: string; read: string; releases: number; settlements: number; deletion: string; content: string }
  const table = (): DRow[] => {
    const md = fs.readFileSync(JOBS, "utf8");
    const sec = md.slice(md.indexOf("### 6.2 Deletion lifecycle"), md.indexOf("## 7. Polling"));
    return Array.from(sec.matchAll(/^\| (D\d+) \| (\w+) \| ([^|]+?) \| (\d{3}) \| (\d) \| (\d) \| (pending|completed) \| (purged|kept) \|$/gm), (m) => ({
      id: m[1], at: m[2], then: m[3], read: m[4], releases: Number(m[5]), settlements: Number(m[6]), deletion: m[7], content: m[8],
    }));
  };
  const count = (list: string[], id: string): number => list.filter((x) => x === id).length;
  const contentOf = (s: System, id: string): string[] => [`inputs/${id}`, `results/${id}`, ...s.store.keys(`calls/${id}/`)].filter((p) => s.store.get(p) !== undefined);
  const opOf = (s: System, id: string): DeletionOp => s.store.get<DeletionOp>(deletionPath(`del_${id.slice(4)}`)) as DeletionOp;
  const invariant = (s: System): void => {
    expect(active(s)).toBeGreaterThanOrEqual(0);
    expect(active(s)).toBe(countedActive(s, "o1"));
  };

  it("the table has rows D1–D12", () => {
    expect(table().map((r) => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => `D${i + 1}`));
  });

  it("the table covers every (Job at DELETE, Then) case the owner required (column binding)", () => {
    const pairs = new Set(table().map((r) => `${r.at} | ${r.then}`));
    const required = [
      "queued | sweeper",
      "running | worker reaches the next step boundary",
      "running | in-flight provider call completes, then the boundary",
      "synthesizing | worker reaches the next step boundary",
      "running | worker crashes; leases expire; sweeper",
      "running | normal completion races the deletion",
      "completed | sweeper",
      "running | a second DELETE, then the boundary",
      "running | sweeper runs before the worker stops",
      "running | worker stops; purge; then a late worker write",
      "running | first stop attempt crashes before commit; retried",
      "running | worker stops responding; fewer than three leases have expired so far",
    ];
    for (const p of required) expect({ p, present: pairs.has(p) }).toEqual({ p, present: true });
  });

  /** Runs one row; returns the system, the job ID and the owner's read while deletion is pending. */
  function scenario(row: DRow): { sys: System; id: string; read: ApiResponse } {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    const path = `jobs/${id}`;
    const setState = (state: string): void => sys.store.put(path, { ...(sys.store.get<JobDoc>(path) as JobDoc), state });
    if (row.at === "queued") setState("queued");
    if (row.at === "running" || row.at === "synthesizing") setState(row.at);
    if (row.at === "completed") runToEnd(finishJob(sys, id, "completed", undefined, { summary: "result" }));
    let inFlight: Generator<void, ApiResponse, void> | null = null;
    if (row.then === "in-flight provider call completes, then the boundary") {
      inFlight = workerProviderCall(sys, id);
      expect(inFlight.next().done).toBe(false); // call started before DELETE
    }
    // Parse-bound (Addendum 7): the job's state at DELETE is the table's "Job at DELETE".
    expect((sys.store.get<JobDoc>(path) as JobDoc).state).toBe(row.at === "queued" ? "queued" : row.at);
    const del = runToEnd(handleDelete(sys, "live1", id));
    expect(del.status).toBe(202);
    const read = handleGet(sys, "live1", id);
    // Parse-bound (Addendum 7): the scenario is selected by the exact "Then" text.
    const SCENARIO: Record<string, string> = {
      "sweeper": "S", "worker reaches the next step boundary": "B", "in-flight provider call completes, then the boundary": "F",
      "worker crashes; leases expire; sweeper": "X", "normal completion races the deletion": "R", "a second DELETE, then the boundary": "2",
      "sweeper runs before the worker stops": "W", "worker stops; purge; then a late worker write": "L",
      "first stop attempt crashes before commit; retried": "C", "worker stops responding; fewer than three leases have expired so far": "P",
    };
    const kind = SCENARIO[row.then];
    expect({ row: row.id, then: row.then, known: kind !== undefined }).toEqual({ row: row.id, then: row.then, known: true });
    switch (kind) {
      case "S": runToEnd(sweep(sys)); break;
      case "B": runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys)); break;
      case "F": runToEnd(inFlight as Generator<void, ApiResponse, void>); expect(sys.store.get(`calls/${id}/1`)).toBeDefined(); runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys)); break;
      case "X": sys.store.put(path, { ...(sys.store.get<JobDoc>(path) as JobDoc), leaseExpiries: 3 }); runToEnd(sweep(sys)); break;
      case "2": {
        const again = runToEnd(handleDelete(sys, "live1", id)) as ApiResponse & { deletion?: { id: string } };
        expect(again.status).toBe(202);
        expect(again.deletion?.id).toBe(`del_${id.slice(4)}`);
        runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys)); break;
      }
      case "W": {
        runToEnd(sweep(sys));
        expect(opOf(sys, id)).toMatchObject({ status: "pending", blockedBy: "awaiting_terminal" });
        runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys)); break;
      }
      case "L": {
        runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys));
        expect(fmt(runToEnd(workerProviderCall(sys, id)))).toBe("409 late_write_refused");
        runToEnd(finishJob(sys, id, "completed", undefined, { summary: "late" }));
        break;
      }
      case "C": {
        const crashed = workerBoundary(sys, id);
        crashed.next(); // the stop transaction read the job, then the worker died
        expect((sys.store.get<JobDoc>(path) as JobDoc).state).toBe("running");
        runToEnd(workerBoundary(sys, id)); runToEnd(sweep(sys)); break;
      }
      case "P": sys.store.put(path, { ...(sys.store.get<JobDoc>(path) as JobDoc), leaseExpiries: 2 }); runToEnd(sweep(sys)); runToEnd(sweep(sys)); break;
      default: throw new Error(`no scenario for "${row.then}"`);
    }
    return { sys, id, read };
  }

  it.each(table().filter((r) => r.id !== "D6").map((r) => [`${r.id} ${r.at}: ${r.then}`, r] as const))("%s", (_n, row) => {
    const { sys, id, read } = scenario(row);
    expect(fmt(read)).toBe(`${row.read} verification_deleted`);
    expect(count(sys.releases, id)).toBe(row.releases);
    expect(count(sys.settlements, id)).toBe(row.settlements);
    const op = opOf(sys, id);
    expect(op.status).toBe(row.deletion);
    if (row.content === "purged") expect(contentOf(sys, id)).toEqual([]);
    else expect(contentOf(sys, id).length).toBeGreaterThan(0);
    if (row.deletion === "pending") {
      expect(op.attempts).toBeGreaterThanOrEqual(1);
      expect(op.blockedBy).toBe("awaiting_terminal");
      expect((sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc)[RELEASE_MARKER_FIELD]).toBe(false); // still counted
    } else {
      const job = sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc;
      expect(job.deleted).toBe(true);
      expect(job[RELEASE_MARKER_FIELD]).toBe(true);
    }
    expect(fmt(runToEnd(handleCancel(sys, "live1", id)))).toBe("410 verification_deleted");
    invariant(sys);
  });

  it("D6 normal completion racing the deletion (every interleaving): one release, one settlement, then purge", () => {
    const row = table().find((r) => r.id === "D6") as DRow;
    const setup = (): System => {
      const s = world();
      const id = send(s, req(SAME)).body?.id as string;
      s.store.put(`jobs/${id}`, { ...(s.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running" });
      return s;
    };
    const idOf = (s: System): string => s.jobs()[0].slice("jobs/".length);
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "delete", start: (s) => handleDelete(s, "live1", idOf(s)) },
      { name: "complete", start: (s) => finishJob(s, idOf(s), "completed", undefined, { summary: "r" }) },
    ])) {
      n++;
      const id = idOf(o.sys);
      expect(fmt(handleGet(o.sys, "live1", id))).toBe(`${row.read} verification_deleted`);
      runToEnd(workerBoundary(o.sys, id));
      runToEnd(sweep(o.sys));
      expect([count(o.sys.releases, id), count(o.sys.settlements, id)]).toEqual([row.releases, row.settlements]);
      expect(opOf(o.sys, id).status).toBe(row.deletion);
      expect(contentOf(o.sys, id)).toEqual([]);
      invariant(o.sys);
    }
    expect(n).toBeGreaterThan(5);
  });

  it("the sweeper racing the worker's stop after DELETE (every interleaving): exactly one release", () => {
    const setup = (): System => {
      const s = world();
      const id = send(s, req(SAME)).body?.id as string;
      s.store.put(`jobs/${id}`, { ...(s.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running", leaseExpiries: 3 });
      runToEnd(handleDelete(s, "live1", id));
      return s;
    };
    const idOf = (s: System): string => s.jobs()[0].slice("jobs/".length);
    for (const o of interleavings(setup, [
      { name: "worker", start: (s) => workerBoundary(s, idOf(s)) },
      { name: "sweeper", start: (s) => sweep(s) },
    ])) {
      runToEnd(sweep(o.sys));
      const id = idOf(o.sys);
      expect(count(o.sys.releases, id)).toBe(1);
      expect(count(o.sys.settlements, id)).toBe(1);
      expect(opOf(o.sys, id).status).toBe("completed");
      invariant(o.sys);
    }
  });

  it("a repeat DELETE returns the SAME operation unchanged: never resets a pending or completed deletion", () => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running" });
    runToEnd(handleDelete(sys, "live1", id));
    runToEnd(sweep(sys)); // blocked: attempts 1, awaiting_terminal
    const pending = opOf(sys, id);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, blockedBy: "awaiting_terminal" });
    const again = runToEnd(handleDelete(sys, "live1", id)) as ApiResponse & { deletion?: DeletionOp };
    expect(again.deletion).toMatchObject({ status: "pending", attempts: 1 });
    expect(opOf(sys, id)).toEqual(pending);
    runToEnd(workerBoundary(sys, id));
    runToEnd(sweep(sys));
    const done = opOf(sys, id);
    expect(done.status).toBe("completed");
    const jobAfter = sys.store.get<JobDoc>(`jobs/${id}`);
    const third = runToEnd(handleDelete(sys, "live1", id)) as ApiResponse & { deletion?: DeletionOp };
    expect(third.status).toBe(202);
    expect(third.deletion?.status).toBe("completed");
    expect(opOf(sys, id)).toEqual(done);
    expect(sys.store.get<JobDoc>(`jobs/${id}`)).toEqual(jobAfter); // the tombstone is not rewritten
    expect(count(sys.releases, id)).toBe(1);
  });

  it("at the limit, deleting every active job frees exactly the capacity, with no leak", () => {
    const sys = world();
    patchOrg(sys, { concurrencyLimit: 2 });
    const a = send(sys, req(SAME, { idempotencyKey: "a" })).body?.id as string;
    const b = send(sys, req(DIFFERENT, { idempotencyKey: "b" })).body?.id as string;
    sys.store.put(`jobs/${b}`, { ...(sys.store.get<JobDoc>(`jobs/${b}`) as JobDoc), state: "running" });
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "c" })))).toBe("429 concurrency_limit");
    runToEnd(handleDelete(sys, "live1", a));
    runToEnd(handleDelete(sys, "live1", b));
    expect(active(sys)).toBe(1); // the running job is still counted while its deletion is pending
    expect(detectDrift(sys, "o1")).toBe(false);
    runToEnd(workerBoundary(sys, b));
    runToEnd(sweep(sys));
    expect(active(sys)).toBe(0);
    expect([a, b].map((id) => [count(sys.releases, id), opOf(sys, id).status])).toEqual([[1, "completed"], [1, "completed"]]);
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "c" })))).toBe("202 new");
    invariant(sys);
  });

  it("drift detection racing admissions and releases (every interleaving) never reports a spurious drift", () => {
    const setup = (): System => {
      const s = world();
      send(s, req(SAME, { idempotencyKey: "first" }));
      return s;
    };
    const firstId = (s: System): string => s.jobs()[0].slice("jobs/".length);
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "detect", start: function* (s: System) { yield* detectDriftTx(s, "o1"); return null; } },
      create("admit", { keyId: "live1", idempotencyKey: "second", body: DIFFERENT }),
      { name: "release", start: (s) => finishJob(s, firstId(s), "completed") },
    ])) {
      n++;
      expect({ schedule: o.schedule, drift: o.sys.audit.filter((e) => e.type === "concurrency.drift_detected").length }).toEqual({ schedule: o.schedule, drift: 0 });
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe("Addendum 6: worker_timeout and persistence_failed are platform-caused (ledger-and-billing.md §4.3)", () => {
  it("the ledger's 'What counts' lists match the model's platform-fault codes", () => {
    const md = fs.readFileSync(path.join(ROOT, "docs/product/api-0/ledger-and-billing.md"), "utf8");
    const para = /\*\*What counts\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    const customer = /count customer-attributable failures: (.+?)\. They exclude/.exec(para)?.[1] ?? "";
    const excluded = /They exclude platform-caused terminal states: (.+?)\./.exec(para)?.[1] ?? "";
    const codes = (t: string): string[] => Array.from(t.matchAll(/`([a-z_]+)`/g), (m) => m[1]);
    expect(codes(customer)).toEqual(["insufficient_usable_models"]);
    for (const c of PLATFORM_FAULT_CODES) {
      expect({ c, excluded: codes(excluded).includes(c), customer: codes(customer).includes(c) }).toEqual({ c, excluded: true, customer: false });
    }
  });

  it("a crashed worker's job ends worker_timeout via the sweeper, for running AND synthesizing", () => {
    for (const state of ["running", "synthesizing"]) {
      const sys = world();
      const id = send(sys, req(SAME)).body?.id as string;
      sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state, leaseExpiries: 3 });
      runToEnd(sweep(sys));
      const job = sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc;
      expect({ state, after: job.state, code: job.failureCode, active: active(sys) }).toEqual({ state, after: "failed", code: "worker_timeout", active: 0 });
      expect(PLATFORM_FAULT_CODES).toContain(job.failureCode);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Addendum 7, M-1: deletion binds to the original verification, not to the key string
// ---------------------------------------------------------------------------------------------
describe("Addendum 7 M-1: deleting A never touches a newer record B under the same Idempotency-Key", () => {
  it("A accepted with K; K expires; B accepted with K; A deleted → B still replays (no false 410)", () => {
    const sys = world();
    const a = send(sys, req(SAME));
    expect(fmt(a)).toBe("202 new");
    sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1; // K's record for A expires
    const b = send(sys, req(SAME));
    expect(fmt(b)).toBe("202 new");
    expect(b.body?.id).not.toBe(a.body?.id);
    const recordBefore = sys.store.get<IdemRecord>(scopeOf(sys));
    expect(recordBefore?.verificationId).toBe(b.body?.id);
    expect(runToEnd(handleDelete(sys, "live1", a.body?.id as string)).status).toBe(202);
    runToEnd(sweep(sys));
    // B's record is left entirely unchanged, and B's replay is the original 202.
    expect(sys.store.get<IdemRecord>(scopeOf(sys))).toEqual(recordBefore);
    expect(send(sys, req(SAME))).toEqual({ status: 202, body: b.body, replayed: true });
    expect(fmt(handleGet(sys, "live1", b.body?.id as string))).toBe("200 undefined");
    expect(fmt(handleGet(sys, "live1", a.body?.id as string))).toBe("410 verification_deleted");
    expect(sys.jobs().length).toBe(2);
    expect(sys.dispatched).toEqual([a.body?.id, b.body?.id]);
  });
});

describe("Addendum 7 M-1: deletion binds to the original acceptance", () => {
  const replayOf = (s: System, b: ApiResponse): void => expect(send(s, req(SAME))).toEqual({ status: 202, body: b.body, replayed: true });

  it("deleting A while A's record is still current writes the marker for A only (documented 410 preserved)", () => {
    const sys = world();
    const a = send(sys, req(SAME));
    runToEnd(handleDelete(sys, "live1", a.body?.id as string));
    const marker = sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord;
    expect(marker).toMatchObject({ kind: "deleted", verificationId: a.body?.id, acceptanceId: `acc_${(a.body?.id as string).slice(4)}` });
    expect(fmt(send(sys, req(SAME)))).toBe("410 verification_deleted");
  });

  it("an expired record is never recreated as a marker; after the marker expires the key accepts a new job", () => {
    const sys = world();
    const a = send(sys, req(SAME));
    sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
    const before = sys.store.get<IdemRecord>(scopeOf(sys));
    runToEnd(handleDelete(sys, "live1", a.body?.id as string));
    expect(sys.store.get<IdemRecord>(scopeOf(sys))).toEqual(before); // expired: left unchanged
    expect(fmt(send(sys, req(SAME)))).toBe("202 new");
    // A marker written while unexpired also stops masking once it expires.
    const s2 = world();
    const x = send(s2, req(SAME));
    runToEnd(handleDelete(s2, "live1", x.body?.id as string));
    expect(fmt(send(s2, req(SAME)))).toBe("410 verification_deleted");
    s2.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
    expect(fmt(send(s2, req(SAME)))).toBe("202 new");
  });

  it("repeated DELETEs of A after B reused the key never touch B's record", () => {
    const sys = world();
    const a = send(sys, req(SAME));
    sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
    const b = send(sys, req(SAME));
    const rec = sys.store.get<IdemRecord>(scopeOf(sys));
    for (let i = 0; i < 3; i++) {
      expect(runToEnd(handleDelete(sys, "live1", a.body?.id as string)).status).toBe(202);
      runToEnd(sweep(sys));
    }
    expect(sys.store.get<IdemRecord>(scopeOf(sys))).toEqual(rec);
    replayOf(sys, b);
  });

  it("deletion of A racing the reuse of K by B (every interleaving): B is never masked; one job, reservation and dispatch each", () => {
    const setup = (): System => {
      const s = world();
      send(s, req(SAME));
      s.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
      return s;
    };
    const aId = "ver_" + "1".padStart(24, "0");
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "delete A", start: (s) => handleDelete(s, "live1", aId) },
      create("create B", req(SAME)),
    ])) {
      n++;
      const b = o.results[1] as ApiResponse;
      expect({ schedule: o.schedule, b: fmt(b) }).toEqual({ schedule: o.schedule, b: "202 new" });
      replayOf(o.sys, b);
      expect(fmt(handleGet(o.sys, "live1", aId))).toBe("410 verification_deleted");
      expect(o.sys.jobs().length).toBe(2);
      expect(o.sys.reservations().filter((r) => r.startsWith("ledger/reserve_")).length).toBe(2);
      expect(o.sys.dispatched.length).toBe(2);
    }
    expect(n).toBeGreaterThan(5);
  });

  it("the binding holds under transaction contention: a replay of B racing the deletion of A (every interleaving)", () => {
    const setup = (): System => {
      const s = world();
      send(s, req(SAME));
      s.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
      send(s, req(SAME));
      return s;
    };
    const aId = "ver_" + "1".padStart(24, "0");
    for (const o of interleavings(setup, [
      { name: "delete A", start: (s) => handleDelete(s, "live1", aId) },
      create("replay B", req(SAME)),
    ])) {
      expect(["202 replay", "409 request_in_progress"]).toContain(fmt(o.results[1] as ApiResponse));
      expect(fmt(send(o.sys, req(SAME)))).toBe("202 replay");
    }
  });
});

describe("Addendum 7 m-2: settlement amounts are conserved, computed in the transaction, and applied once", () => {
  const conserve = (s: System, id: string): void => {
    const settle = s.store.keys("ledger/").filter((k) => k === `ledger/settle_${id}`);
    expect(settle.length).toBe(1);
    const e = s.store.get<{ charged: number; released: number; reserved: number }>(`ledger/settle_${id}`) as { charged: number; released: number; reserved: number };
    expect(e.charged + e.released).toBe(e.reserved);
    expect(e.charged).toBe(Math.min(e.reserved, (s.store.get<JobDoc>(`jobs/${id}`) as JobDoc).callsMade ?? 0));
  };

  it("a stop whose transaction retries after a late call recomputes the settlement (no over-refund)", () => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running", callsMade: 1 });
    sys.store.put(`calls/${id}/1`, { text: "t" });
    const credits0 = (sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining;
    runToEnd(handleDelete(sys, "live1", id)); // cancellation requested
    const stop = workerBoundary(sys, id);
    stop.next(); // the stop transaction has read callsMade = 1
    runToEnd(recordCallResult(sys, id)); // an in-flight call's result commits: callsMade = 2
    runToEnd(stop); // the stop's commit conflicts and retries from fresh reads
    const job = sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc;
    expect([job.state, job.callsMade, job.settledCharged, job.settledReleased]).toEqual(["canceled", 2, 2, job.credits - 2]);
    expect((sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining - credits0).toBe(job.credits - 2);
    conserve(sys, id);
  });

  it.each(["completed", "failed", "canceled", "expired"] as const)("%s: charged + released == reserved, one settlement, repeated terminal events refund nothing more", (to) => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running", callsMade: 2 });
    runToEnd(finishJob(sys, id, to));
    const credits1 = (sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining;
    for (const again of ["completed", "failed", "canceled"] as const) runToEnd(finishJob(sys, id, again));
    runToEnd(handleCancel(sys, "live1", id));
    runToEnd(sweep(sys));
    expect((sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining).toBe(credits1);
    expect(sys.settlements.filter((x) => x === id).length).toBe(1);
    conserve(sys, id);
  });

  it("across every deletion row, total credits are conserved: initial − Σ charged == remaining", () => {
    const sys = world();
    const initial = (sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(send(sys, req(SAME, { idempotencyKey: `cons-${i}` })).body?.id as string);
    sys.store.put(`jobs/${ids[1]}`, { ...(sys.store.get<JobDoc>(`jobs/${ids[1]}`) as JobDoc), state: "running", callsMade: 3 });
    for (const id of ids) runToEnd(handleDelete(sys, "live1", id));
    runToEnd(workerBoundary(sys, ids[1]));
    runToEnd(sweep(sys));
    const charged = ids.map((id) => (sys.store.get<{ charged: number }>(`ledger/settle_${id}`) as { charged: number }).charged);
    expect(charged).toEqual([0, 3, 0]);
    expect((sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining).toBe(initial - 3);
    for (const id of ids) conserve(sys, id);
  });
});

describe("Addendum 7 m-1: the provider-call boundary", () => {
  it("after cancellation (or deletion) is requested, the next provider call is NOT made", () => {
    for (const request of ["delete", "cancel"] as const) {
      const sys = world();
      const id = send(sys, req(SAME)).body?.id as string;
      sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running" });
      if (request === "delete") runToEnd(handleDelete(sys, "live1", id));
      else expect(runToEnd(handleCancel(sys, "live1", id)).status).toBe(200);
      const g = workerProviderCall(sys, id);
      const first = g.next();
      expect({ request, done: first.done, value: first.done ? fmt(first.value) : "in flight" }).toEqual({ request, done: true, value: "409 stopped_at_boundary" });
      expect(sys.store.keys(`calls/${id}/`)).toEqual([]);
      expect((sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc).callsMade ?? 0).toBe(0);
    }
  });

  it("a call started before the request completes; the one after it is not made", () => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    sys.store.put(`jobs/${id}`, { ...(sys.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running" });
    const inFlight = workerProviderCall(sys, id);
    inFlight.next();
    runToEnd(handleDelete(sys, "live1", id));
    expect(fmt(runToEnd(inFlight))).toBe("200 undefined");
    expect(fmt(runToEnd(workerProviderCall(sys, id)))).toBe("409 stopped_at_boundary");
    expect(sys.store.keys(`calls/${id}/`).length).toBe(1);
  });
});

describe("Addendum 7 m-3: purge versus late writes, and dispatch versus delete (every interleaving)", () => {
  const settleOnce = (s: System, id: string): void => {
    expect(s.settlements.filter((x) => x === id).length).toBe(1);
    expect(s.releases.filter((x) => x === id).length).toBe(1);
    const e = s.store.get<{ charged: number; released: number; reserved: number }>(`ledger/settle_${id}`) as { charged: number; released: number; reserved: number };
    expect(e.charged + e.released).toBe(e.reserved);
  };

  it("sweeper recovery + purge racing a late call result and a late completion", () => {
    const setup = (): System => {
      const s = world();
      const id = send(s, req(SAME)).body?.id as string;
      s.store.put(`jobs/${id}`, { ...(s.store.get<JobDoc>(`jobs/${id}`) as JobDoc), state: "running", leaseExpiries: 3 });
      runToEnd(handleDelete(s, "live1", id));
      return s;
    };
    const idOf = (s: System): string => s.jobs()[0].slice("jobs/".length);
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "sweeper", start: (s) => sweep(s) },
      { name: "late call result", start: (s) => recordCallResult(s, idOf(s)) },
      { name: "late completion", start: (s) => finishJob(s, idOf(s), "completed", undefined, { summary: "late" }) },
    ])) {
      n++;
      runToEnd(sweep(o.sys)); // a later sweep completes any deletion still pending
      const id = idOf(o.sys);
      settleOnce(o.sys, id);
      const op = o.sys.store.get<DeletionOp>(deletionPath(`del_${id.slice(4)}`)) as DeletionOp;
      expect(op.status).toBe("completed");
      expect([`inputs/${id}`, `results/${id}`, ...o.sys.store.keys(`calls/${id}/`)].filter((k) => o.sys.store.get(k) !== undefined)).toEqual([]);
      expect(active(o.sys)).toBe(countedActive(o.sys, "o1"));
    }
    expect(n).toBeGreaterThan(20);
  });

  it("dispatch racing DELETE of a queued job: no provider call after the request, one release", () => {
    const setup = (): System => {
      const s = world();
      send(s, req(SAME));
      return s;
    };
    const idOf = (s: System): string => s.jobs()[0].slice("jobs/".length);
    for (const o of interleavings(setup, [
      { name: "dispatch", start: (s) => workerStart(s, idOf(s)) },
      { name: "delete", start: (s) => handleDelete(s, "live1", idOf(s)) },
    ])) {
      const id = idOf(o.sys);
      expect(fmt(runToEnd(workerProviderCall(o.sys, id)))).toMatch(/^409 (stopped_at_boundary|late_write_refused)$/);
      runToEnd(workerBoundary(o.sys, id));
      runToEnd(sweep(o.sys));
      settleOnce(o.sys, id);
      expect((o.sys.store.get<DeletionOp>(deletionPath(`del_${id.slice(4)}`)) as DeletionOp).status).toBe("completed");
      expect(o.sys.store.keys(`calls/${id}/`)).toEqual([]);
    }
  });

  it("the tombstone keeps the release-anomaly marker", () => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    sys.store.put(concurrencyPath("o1"), { active: 0, anomalies: 0 });
    runToEnd(finishJob(sys, id, "completed"));
    runToEnd(handleDelete(sys, "live1", id));
    runToEnd(sweep(sys));
    expect(sys.store.get<JobDoc>(`jobs/${id}`)).toMatchObject({ deleted: true, concurrencyReleaseAnomaly: true });
  });
});

describe("Addendum 7 m-5: platform-fault failures still feed the repeated-failing-input short-circuit", () => {
  it("ledger-and-billing.md §4.3 counts worker_timeout and persistence_failed toward repeated failing input", () => {
    const md = fs.readFileSync(path.join(ROOT, "docs/product/api-0/ledger-and-billing.md"), "utf8");
    const rule = /\*\*Repeated failing input and platform faults \(Addendum 7\)\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    // The counting clause itself, not the surrounding prose, must name both codes.
    const clause = /the same input fingerprint ending (.+?) 3× in 1 h/.exec(rule)?.[1] ?? "";
    const codes = Array.from(clause.matchAll(/`([a-z_]+)`/g), (m) => m[1]).sort();
    expect(codes).toEqual(["insufficient_usable_models", "persistence_failed", "worker_timeout"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Addendum 8 (R4): fully failed jobs are free; provider cost recorded separately; failed-job
// controls intact; platform faults never counted against the customer; acceptance identity.
// ---------------------------------------------------------------------------------------------
const LEDGER = path.join(ROOT, "docs/product/api-0/ledger-and-billing.md");
const RETENTION = path.join(ROOT, "docs/product/api-0/retention-and-deletion.md");

type SettleEntry = { charged: number; released: number; reserved: number };
const settleOf = (s: System, id: string): SettleEntry => s.store.get<SettleEntry>(`ledger/settle_${id}`) as SettleEntry;
const jobOf = (s: System, id: string): JobDoc => s.store.get<JobDoc>(`jobs/${id}`) as JobDoc;
const creditsOf = (s: System): number => (s.store.get<OrgDoc>("orgs/o1") as OrgDoc).creditsRemaining;
const costsOf = (s: System, id: string): CostDoc[] => s.store.keys(`cost/${id}/`).map((k) => s.store.get<CostDoc>(k) as CostDoc);
/** Independent oracle of ledger-and-billing.md §2.4/§2.5 (Addendum 8): NOT the model's own formula. */
const expectedCharged = (to: JobState, usableCalls: number, reserved: number): number =>
  to === "failed" || to === "expired" ? 0 : Math.min(reserved, usableCalls);

let r4Seq = 0;
/** A live job accepted through T-create and started by a worker, with the given provider calls recorded. */
function runningJob(sys: System, calls: CallOutcome[] = [], body: unknown = SAME, usd = 0.01): string {
  const res = send(sys, req(body, { idempotencyKey: `r4-${++r4Seq}` }));
  expect(fmt(res)).toBe("202 new");
  const id = res.body?.id as string;
  expect(fmt(runToEnd(workerStart(sys, id)))).toBe("200 undefined");
  for (const c of calls) expect(fmt(runToEnd(workerProviderCall(sys, id, c, usd)))).toBe("200 undefined");
  return id;
}

/** Fully failed: charged 0, the whole reservation released, exactly once, balance restored. */
function assertFullyFailed(sys: System, id: string, creditsBefore: number, providerCalls: number): void {
  const job = jobOf(sys, id);
  const e = settleOf(sys, id);
  expect({ state: job.state, charged: e.charged, released: e.released, reserved: e.reserved }).toEqual({ state: "failed", charged: 0, released: job.credits, reserved: job.credits });
  expect([job.settledCharged, job.settledReleased]).toEqual([0, job.credits]);
  expect(creditsOf(sys)).toBe(creditsBefore);
  expect(sys.settlements.filter((x) => x === id).length).toBe(1);
  // Provider cost recorded independently of the customer charge: one cost entry per call.
  expect(costsOf(sys, id).length).toBe(providerCalls);
}

describe("Addendum 8 E1/E2: a fully failed job charges 0 and releases the whole reservation", () => {
  it("ledger-and-billing.md §2.5 lists failed and expired as charged 0 with a full release (parsed)", () => {
    const md = fs.readFileSync(LEDGER, "utf8");
    const line = /^`failed`, `canceled` \(before execution\), `expired`: `release_\{verId\}` for the whole estimate, `charged = 0` \(OD-8\)\. Canceled during execution settles for work done\.$/m.exec(md);
    expect(line).not.toBeNull();
    // Addendum 8 clarification: "fully failed" is every `failed` terminal state, whatever the cause.
    const clar = /\*\*Fully failed \(Addendum 8\)\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    expect(clar).toContain("every job that ends `failed`");
    expect(clar).toContain("whatever its failure code");
    expect(clar).toContain("however many provider calls");
  });

  it("every `failed` row of the job state table (jobs-and-idempotency.md §3) releases; the model charges 0 for each code", () => {
    const md = fs.readFileSync(JOBS, "utf8");
    const sec = md.slice(md.indexOf("## 3. State machine"), md.indexOf("## 4. Steps"));
    const rows = sec.split("\n").filter((l) => /^\| [^|]+ \| [^|]+ \| `?failed/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const codes = new Set<string>();
    for (const l of rows) {
      const cells = l.split("|").map((c) => c.trim());
      expect({ row: cells[3], side: /^release/.test(cells[4]) }).toEqual({ row: cells[3], side: true });
      const STATES = new Set(["pending_dispatch", "queued", "running", "synthesizing", "failed", "canceled"]);
      for (const m of cells[3].matchAll(/`failed: ([a-z_]+)`/g)) codes.add(m[1]);
      for (const m of cells[2].matchAll(/`([a-z_]+)`/g)) if (!STATES.has(m[1])) codes.add(m[1]);
    }
    for (const c of ["insufficient_usable_models", "worker_timeout", "persistence_failed", "capacity_unavailable", "query_not_executable", "no_comparable_claims", "adaptive_finalize_failed"]) expect(codes).toContain(c);
    for (const code of codes) {
      const sys = world();
      const before = creditsOf(sys);
      const id = runningJob(sys, ["ok", "ok", "error"]);
      runToEnd(finishJob(sys, id, "failed", code));
      expect({ code, charged: settleOf(sys, id).charged }).toEqual({ code, charged: 0 });
      assertFullyFailed(sys, id, before, 3);
    }
  });

  it("E2-1: failed after one or more provider calls with usable output → charged 0, released = reserved", () => {
    const sys = world();
    const before = creditsOf(sys);
    const id = runningJob(sys, ["ok", "error", "error"]);
    expect(jobOf(sys, id).callsMade).toBe(1);
    runToEnd(finishJob(sys, id, "failed", "insufficient_usable_models"));
    assertFullyFailed(sys, id, before, 3);
  });

  it("E2-2: failed after every selected model fails → charged 0, every attempt's cost recorded", () => {
    const sys = world();
    const before = creditsOf(sys);
    const id = runningJob(sys, ["error", "error", "error", "error"]);
    runToEnd(finishJob(sys, id, "failed", "insufficient_usable_models"));
    assertFullyFailed(sys, id, before, 4);
    expect(costsOf(sys, id).map((c) => c.outcome)).toEqual(["error", "error", "error", "error"]);
  });

  it("E2-3: platform-caused failures (worker_timeout via the sweeper, persistence_failed, capacity_unavailable) → charged 0", () => {
    {
      const sys = world();
      const before = creditsOf(sys);
      const id = runningJob(sys, ["ok", "ok"]);
      sys.store.put(`jobs/${id}`, { ...jobOf(sys, id), leaseExpiries: 3 });
      runToEnd(sweep(sys));
      expect(jobOf(sys, id).failureCode).toBe("worker_timeout");
      assertFullyFailed(sys, id, before, 2);
    }
    {
      const sys = world();
      const before = creditsOf(sys);
      const id = runningJob(sys, ["ok", "ok", "ok"]);
      sys.store.put(`jobs/${id}`, { ...jobOf(sys, id), state: "synthesizing" });
      runToEnd(finishJob(sys, id, "failed", "persistence_failed"));
      assertFullyFailed(sys, id, before, 3);
    }
    {
      const sys = world();
      const before = creditsOf(sys);
      const id = send(sys, req(SAME)).body?.id as string;
      runToEnd(finishJob(sys, id, "failed", "capacity_unavailable"));
      assertFullyFailed(sys, id, before, 0);
    }
  });

  it("E2-4: a customer-attributable failure (insufficient_usable_models) is fully failed, and it counts against the customer", () => {
    // Docs: jobs-and-idempotency.md §3 "< 2 usable models (`insufficient_usable_models`) | `failed` | release";
    // ledger-and-billing.md §2.5 "`failed` … whole estimate, `charged = 0`"; PRD J6 "released in full".
    const md = fs.readFileSync(JOBS, "utf8");
    expect(md).toContain("| `running` | < 2 usable models (`insufficient_usable_models`) | `failed` | release; internal cost recorded; failed-job counters (OD-8) |");
    const sys = world();
    const before = creditsOf(sys);
    const id = runningJob(sys, ["ok", "error", "error"]);
    runToEnd(finishJob(sys, id, "failed", "insufficient_usable_models"));
    assertFullyFailed(sys, id, before, 3);
    expect(failureControls(sys, "o1").count1h).toBe(1);
  });

  it("E2-5: partial completion with usable work settles that work; the rest is released", () => {
    const sys = world();
    const before = creditsOf(sys);
    const id = runningJob(sys, ["ok", "ok", "error"]);
    runToEnd(finishJob(sys, id, "partial"));
    const e = settleOf(sys, id);
    expect([e.charged, e.released, e.reserved]).toEqual([2, jobOf(sys, id).credits - 2, jobOf(sys, id).credits]);
    expect(creditsOf(sys)).toBe(before - 2);
    expect(costsOf(sys, id).length).toBe(3);
  });

  it("E2-6: cancellation before processing → charged 0, whole reservation released, no provider cost", () => {
    const sys = world();
    const before = creditsOf(sys);
    const id = send(sys, req(SAME)).body?.id as string;
    expect(runToEnd(handleCancel(sys, "live1", id)).status).toBe(200);
    const e = settleOf(sys, id);
    expect([jobOf(sys, id).state, e.charged, e.released]).toEqual(["canceled", 0, e.reserved]);
    expect(creditsOf(sys)).toBe(before);
    expect(costsOf(sys, id)).toEqual([]);
  });

  it("E2-7: cancellation after chargeable work settles the work done (unchanged by Addendum 8)", () => {
    const sys = world();
    const before = creditsOf(sys);
    const id = runningJob(sys, ["ok", "ok"]);
    expect(runToEnd(handleCancel(sys, "live1", id)).status).toBe(200);
    runToEnd(workerBoundary(sys, id));
    const e = settleOf(sys, id);
    expect([jobOf(sys, id).state, e.charged, e.released]).toEqual(["canceled", 2, e.reserved - 2]);
    expect(creditsOf(sys)).toBe(before - 2);
    expect(costsOf(sys, id).length).toBe(2);
  });

  it("E2-8: a failed transition whose transaction retries after a late call still charges 0 (no over- or under-refund)", () => {
    for (const to of ["failed", "partial"] as const) {
      const sys = world();
      const before = creditsOf(sys);
      const id = runningJob(sys, ["ok"]);
      const fin = finishJob(sys, id, to, to === "failed" ? "insufficient_usable_models" : undefined);
      fin.next(); // the terminal transaction has read callsMade = 1
      runToEnd(recordCallResult(sys, id, "ok")); // a call result commits in between: callsMade = 2
      runToEnd(fin); // conflict → retry from fresh reads
      const e = settleOf(sys, id);
      const want = expectedCharged(to, 2, e.reserved);
      expect({ to, charged: e.charged, released: e.released }).toEqual({ to, charged: want, released: e.reserved - want });
      expect(creditsOf(sys)).toBe(before - want);
      expect(sys.settlements.filter((x) => x === id).length).toBe(1);
    }
  });

  it("E2-9: duplicate terminal events (every interleaving of two terminal transitions) settle exactly once", () => {
    const pairs: Array<[JobState, string | undefined, JobState, string | undefined]> = [
      ["failed", "insufficient_usable_models", "failed", "insufficient_usable_models"],
      ["failed", "worker_timeout", "completed", undefined],
      ["failed", "persistence_failed", "partial", undefined],
      ["canceled", "canceled", "failed", "worker_timeout"],
    ];
    let n = 0;
    for (const [a, ac, b, bc] of pairs) {
      let id = "";
      let before = 0;
      const setup = (): System => {
        const s = world();
        before = creditsOf(s);
        id = runningJob(s, ["ok", "ok"]);
        return s;
      };
      for (const o of interleavings(setup, [
        { name: `${a}`, start: (s) => finishJob(s, id, a, ac) },
        { name: `${b}`, start: (s) => finishJob(s, id, b, bc) },
      ])) {
        n++;
        const job = jobOf(o.sys, id);
        const e = settleOf(o.sys, id);
        expect(o.sys.settlements.filter((x) => x === id).length).toBe(1);
        expect(o.sys.releases.filter((x) => x === id).length).toBe(1);
        expect(o.sys.store.keys(outcomePath(id)).length).toBe(1);
        expect(e.charged).toBe(expectedCharged(job.state, 2, e.reserved));
        expect(e.charged + e.released).toBe(e.reserved);
        expect(creditsOf(o.sys)).toBe(before - e.charged);
        // Further duplicates after the fact change nothing.
        for (const again of ["failed", "completed", "canceled"] as const) runToEnd(finishJob(o.sys, id, again, "worker_timeout"));
        runToEnd(sweep(o.sys));
        expect(creditsOf(o.sys)).toBe(before - e.charged);
        expect(o.sys.settlements.filter((x) => x === id).length).toBe(1);
      }
    }
    expect(n).toBeGreaterThan(8);
  });

  it("E2-10: credit conservation across every outcome (exhaustive): charged + released == reserved, no negative balance, cost independent of charge", () => {
    const sys = world();
    patchOrg(sys, { creditsRemaining: 100_000 });
    const initial = creditsOf(sys);
    let totalCharged = 0;
    let cases = 0;
    const outcomes: Array<[JobState, string | undefined]> = [
      ["completed", undefined], ["partial", undefined], ["canceled", "canceled"], ["canceled", "deletion_requested"],
      ...["insufficient_usable_models", "worker_timeout", "persistence_failed", "capacity_unavailable", "query_not_executable", "no_comparable_claims", "adaptive_finalize_failed", "pipeline_disabled"].map((c): [JobState, string] => ["failed", c]),
    ];
    for (const [to, code] of outcomes) {
      for (let ok = 0; ok <= 8; ok++) {
        for (let bad = 0; bad <= 2; bad++) {
          for (const del of [false, true]) {
            sys.dynamic.now += 25 * 60 * 60 * 1000; // outside every failed-job window: controls never interfere
            const calls: CallOutcome[] = [...Array(ok).fill("ok"), ...Array(bad).fill("error")];
            const id = runningJob(sys, calls, { ...SAME, input: { question: `case ${cases}` } });
            runToEnd(finishJob(sys, id, to, code));
            if (del) {
              runToEnd(handleDelete(sys, "live1", id));
              runToEnd(sweep(sys));
              expect(jobOf(sys, id).deleted).toBe(true);
            }
            const e = settleOf(sys, id);
            const want = expectedCharged(to, ok, e.reserved);
            expect({ to, code, ok, bad, del, charged: e.charged, sum: e.charged + e.released }).toEqual({ to, code, ok, bad, del, charged: want, sum: e.reserved });
            expect(e.charged).toBeGreaterThanOrEqual(0);
            expect(e.released).toBeGreaterThanOrEqual(0);
            expect(costsOf(sys, id).length).toBe(ok + bad);
            totalCharged += want;
            expect(creditsOf(sys)).toBe(initial - totalCharged);
            expect(creditsOf(sys)).toBeGreaterThanOrEqual(0);
            cases++;
          }
        }
      }
    }
    // Expired (never started) is always free.
    for (let i = 0; i < 3; i++) {
      const id = send(sys, req(SAME, { idempotencyKey: `exp-${i}` })).body?.id as string;
      sys.dynamic.now += model.MAX_QUEUE_WAIT_MS + 1;
      runToEnd(sweep(sys));
      expect([jobOf(sys, id).state, settleOf(sys, id).charged]).toEqual(["expired", 0]);
    }
    expect(creditsOf(sys)).toBe(initial - totalCharged);
    expect(sys.settlements.length).toBe(new Set(sys.settlements).size);
    expect(cases).toBe(outcomes.length * 9 * 3 * 2);
    expect(active(sys)).toBe(countedActive(sys, "o1"));
  });

  it("an organization with exactly the reservation left never goes negative when a job fails", () => {
    const sys = world();
    patchOrg(sys, { creditsRemaining: 6 });
    const id = runningJob(sys, ["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(creditsOf(sys)).toBe(0);
    runToEnd(finishJob(sys, id, "failed", "insufficient_usable_models"));
    expect(creditsOf(sys)).toBe(6);
  });
});

describe("Addendum 8 E3: a provider call returning after the job became terminal (not yet purged)", () => {
  it.each(["failed", "completed", "canceled"] as const)("after %s: content refused, cost recorded, settlement and balance unchanged", (to) => {
    const sys = world();
    const id = runningJob(sys, ["ok"]);
    const inFlight = workerProviderCall(sys, id, "ok", 0.02);
    inFlight.next(); // in flight
    if (to === "failed") {
      sys.store.put(`jobs/${id}`, { ...jobOf(sys, id), leaseExpiries: 3 });
      runToEnd(sweep(sys)); // failed: worker_timeout
    } else runToEnd(finishJob(sys, id, to));
    const settled = settleOf(sys, id);
    const credits = creditsOf(sys);
    const job = jobOf(sys, id);
    expect(job.deleted).toBeUndefined();
    expect(fmt(runToEnd(inFlight))).toBe("409 late_write_refused");
    expect(sys.store.keys(`calls/${id}/`).length).toBe(1);
    expect(jobOf(sys, id)).toEqual(job);
    expect(settleOf(sys, id)).toEqual(settled);
    expect(creditsOf(sys)).toBe(credits);
    expect(costsOf(sys, id).length).toBe(2);
    expect(costsOf(sys, id).some((c) => c.usd === 0.02)).toBe(true);
  });

  it("every interleaving of an in-flight call with a failed transition: never charged, cost always recorded", () => {
    let id = "";
    let before = 0;
    const setup = (): System => {
      const s = world();
      before = creditsOf(s);
      id = runningJob(s, ["ok"]);
      return s;
    };
    let n = 0;
    for (const o of interleavings(setup, [
      { name: "call", start: (s) => workerProviderCall(s, id, "ok") },
      { name: "fail", start: (s) => finishJob(s, id, "failed", "insufficient_usable_models") },
    ])) {
      n++;
      expect(settleOf(o.sys, id).charged).toBe(0);
      expect(creditsOf(o.sys)).toBe(before);
      expect(costsOf(o.sys, id).length).toBe(2);
    }
    expect(n).toBeGreaterThan(3);
  });
});

describe("Addendum 8 E2: failed-job controls still bound a flood of fully failed jobs (ledger-and-billing.md §4.3)", () => {
  it("the model's thresholds and code lists are the ledger's (parsed)", () => {
    const md = fs.readFileSync(LEDGER, "utf8");
    expect(md).toContain(`| Failed-job ratio | > ${FAILED_RATIO_SOFT * 100} % of an org's live jobs in a rolling 24 h with ≥ ${FAILED_RATIO_MIN_JOBS} jobs |`);
    expect(md).toContain(`≥ ${FAILED_COUNT_HARD_24H} released (failed) live jobs per org in a rolling 24 h, or ≥ ${FAILED_COUNT_HARD_1H} in a rolling 1 h`);
    expect(md).toContain(`of released jobs > $${FAILED_COST_HARD_USD_24H} / 24 h`);
    expect(md).toContain(`| Same input fingerprint failed ${SHORT_CIRCUIT_THRESHOLD}× in 1 h |`);
    const para = /\*\*What counts\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    const customer = /count customer-attributable failures: (.+?)\. They exclude/.exec(para)?.[1] ?? "";
    expect(Array.from(customer.matchAll(/`([a-z_]+)`/g), (m) => m[1])).toEqual([...CUSTOMER_FAILURE_CODES]);
    const rule = /\*\*Repeated failing input and platform faults \(Addendum 7\)\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    const clause = /the same input fingerprint ending (.+?) 3× in 1 h/.exec(rule)?.[1] ?? "";
    expect(Array.from(clause.matchAll(/`([a-z_]+)`/g), (m) => m[1]).sort()).toEqual([...SHORT_CIRCUIT_CODES].sort());
  });

  it("a flood of distinct customer-attributable failures is stopped by the hard count limit, all free to the customer", () => {
    const sys = world();
    const before = creditsOf(sys);
    let accepted = 0;
    const answers: string[] = [];
    for (let i = 0; i < 30; i++) {
      const res = send(sys, req({ ...SAME, input: { question: `flood ${i}` } }, { idempotencyKey: `flood-${i}` }));
      answers.push(fmt(res));
      if (res.status !== 202) continue;
      accepted++;
      const id = res.body?.id as string;
      runToEnd(workerStart(sys, id));
      runToEnd(workerProviderCall(sys, id, "ok"));
      runToEnd(workerProviderCall(sys, id, "error"));
      runToEnd(finishJob(sys, id, "failed", "insufficient_usable_models"));
    }
    expect(accepted).toBe(FAILED_COUNT_HARD_1H);
    expect(answers.slice(FAILED_COUNT_HARD_1H)).toEqual(Array(30 - FAILED_COUNT_HARD_1H).fill("403 failed_job_threshold_exceeded"));
    expect(creditsOf(sys)).toBe(before);
    const totalCost = sys.jobs().reduce((n, p) => n + costsOf(sys, p.slice(5)).length, 0);
    expect(totalCost).toBe(2 * FAILED_COUNT_HARD_1H);
  });

  it("a flood of distinct platform-fault failures (excluded from the count) is stopped by the failed-job cost limit", () => {
    const sys = world();
    let accepted = 0;
    let last = "";
    for (let i = 0; i < 30; i++) {
      const res = send(sys, req({ ...SAME, input: { question: `outage ${i}` } }, { idempotencyKey: `outage-${i}` }));
      last = fmt(res);
      if (res.status !== 202) break;
      accepted++;
      const id = res.body?.id as string;
      runToEnd(workerStart(sys, id));
      runToEnd(workerProviderCall(sys, id, "ok", 0.5));
      runToEnd(workerProviderCall(sys, id, "ok", 0.5));
      sys.store.put(`jobs/${id}`, { ...jobOf(sys, id), leaseExpiries: 3 });
      runToEnd(sweep(sys));
      expect(settleOf(sys, id).charged).toBe(0);
    }
    const c = failureControls(sys, "o1");
    expect({ accepted, last, count: c.count24h }).toEqual({ accepted: 6, last: "403 failed_job_threshold_exceeded", count: 0 });
    expect(c.releasedCostUsd24h).toBeGreaterThan(FAILED_COST_HARD_USD_24H);
  });
});

describe("Addendum 8 E3: platform faults are excluded from customer-attributable failure counts and ratios", () => {
  const failSame = (sys: System, code: string, n: number, body: unknown = SAME): void => {
    for (let i = 0; i < n; i++) {
      const id = runningJob(sys, ["ok"], body);
      if (code === "worker_timeout") {
        sys.store.put(`jobs/${id}`, { ...jobOf(sys, id), leaseExpiries: 3 });
        runToEnd(sweep(sys));
      } else runToEnd(finishJob(sys, id, "failed", code));
    }
  };

  it("ledger-and-billing.md §4.3 specifies short-circuit attribution (parsed)", () => {
    const md = fs.readFileSync(LEDGER, "utf8");
    const para = /\*\*Short-circuit attribution \(Addendum 8\)\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    expect(para).toContain("counts toward the failed-job count and ratio only when the fingerprint's customer-attributable failures alone");
    expect(para).toContain("never counts against the customer");
  });

  it("a short-circuit reached only through platform faults rejects, but never counts against the customer", () => {
    const sys = world();
    failSame(sys, "worker_timeout", SHORT_CIRCUIT_THRESHOLD);
    for (let i = 0; i < 15; i++) expect(fmt(send(sys, req(SAME, { idempotencyKey: `sc-${i}` })))).toBe("422 repeated_failing_input");
    const c = failureControls(sys, "o1");
    expect({ count1h: c.count1h, count24h: c.count24h, ratio: c.ratio, hard: c.hard, soft: c.soft }).toEqual({ count1h: 0, count24h: 0, ratio: 0, hard: false, soft: false });
    // A different input is still accepted: the outage did not suspend the customer.
    expect(fmt(send(sys, req(DIFFERENT, { idempotencyKey: "other" })))).toBe("202 new");
  });

  it("mixed: 2 customer failures + 1 platform fault block the input, but the rejections do not count; a 3rd customer failure makes them count", () => {
    const sys = world();
    failSame(sys, "insufficient_usable_models", 2);
    failSame(sys, "worker_timeout", 1);
    expect(fmt(send(sys, req(SAME, { idempotencyKey: "m-1" })))).toBe("422 repeated_failing_input");
    expect(failureControls(sys, "o1").count1h).toBe(2);
    expect(sys.shortCircuitRejections.map((r) => r.counted)).toEqual([false]);
    // The block is in force, so model a third customer failure on the same input from before the block.
    const s2 = world();
    failSame(s2, "insufficient_usable_models", 3);
    expect(fmt(send(s2, req(SAME, { idempotencyKey: "m-2" })))).toBe("422 repeated_failing_input");
    expect(s2.shortCircuitRejections.map((r) => r.counted)).toEqual([true]);
    expect(failureControls(s2, "o1").count1h).toBe(4);
  });

  it("platform-fault rejections never push the ratio over the soft threshold", () => {
    const sys = world();
    for (let i = 0; i < 20; i++) {
      const id = runningJob(sys, ["ok", "ok"], { ...SAME, input: { question: `fine ${i}` } });
      runToEnd(finishJob(sys, id, "completed"));
    }
    failSame(sys, "persistence_failed", SHORT_CIRCUIT_THRESHOLD);
    for (let i = 0; i < 15; i++) send(sys, req(SAME, { idempotencyKey: `pr-${i}` }));
    const c = failureControls(sys, "o1");
    expect(c.jobs24h).toBeGreaterThanOrEqual(FAILED_RATIO_MIN_JOBS);
    expect({ ratio: c.ratio, soft: c.soft }).toEqual({ ratio: 0, soft: false });
  });
});

describe("Addendum 8 E3: the acceptance identity is generated independently and is unique", () => {
  const acceptances = (sys: System): string[] => sys.jobs().map((p) => (sys.store.get<JobDoc>(p) as JobDoc).idemAcceptanceId as string);

  it("retention-and-deletion.md §3.1 specifies the generation and uniqueness rule (parsed); the model meets it", () => {
    const md = fs.readFileSync(RETENTION, "utf8");
    const para = /\*\*Acceptance identity \(Addendum 8\)\.\*\*([^\n]+)/.exec(md)?.[1] ?? "";
    expect(para).toContain("cryptographically secure random generator");
    expect(para).toContain("at least 128 bits");
    expect(para).toContain("never derived from the client's `Idempotency-Key`, the verification ID, the request content or the time");
    expect(para).toContain("unique across all organizations, applications, modes and keys");
    expect(model.ACCEPTANCE_ID_BYTES).toBeGreaterThanOrEqual(16);
  });

  it("format: acc_ + 32 hex characters (128 bits); the job and the record carry the same value", () => {
    const sys = world();
    const id = send(sys, req(SAME)).body?.id as string;
    const rec = sys.store.get<IdemRecord>(scopeOf(sys)) as IdemRecord;
    expect(rec.acceptanceId).toMatch(/^acc_[0-9a-f]{32}$/);
    expect(jobOf(sys, id).idemAcceptanceId).toBe(rec.acceptanceId);
  });

  it("not derived: two identical worlds produce the same verification IDs and scopes but different acceptance IDs", () => {
    const run = (): System => {
      const s = world();
      send(s, req(SAME));
      s.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
      send(s, req(SAME)); // the same Idempotency-Key reused after expiry
      return s;
    };
    const a = run();
    const b = run();
    expect(a.jobs()).toEqual(b.jobs());
    const [a1, a2] = acceptances(a);
    const [b1, b2] = acceptances(b);
    expect(new Set([a1, a2, b1, b2]).size).toBe(4);
    for (const [acc, p] of [[a1, a.jobs()[0]], [a2, a.jobs()[1]]] as const) {
      expect(acc).not.toContain(p.slice("jobs/ver_".length));
      expect(acc).not.toContain(IDEM);
    }
  });

  it("unique across many acceptances (orgs, apps, modes, key reuse)", () => {
    const sys = world();
    sys.store.put("orgs/o2", sys.store.get("orgs/o1"));
    sys.store.put("keys/o2live", { ...(sys.store.get<KeyDoc>("keys/live1") as KeyDoc), orgId: "o2" });
    const seen: string[] = [];
    for (let round = 0; round < 25; round++) {
      for (const keyId of ["live1", "test1", "live_app2", "o2live"]) {
        const res = send(sys, req(SAME, { keyId, idempotencyKey: `u-${round % 3}` }));
        if (fmt(res) === "202 new") {
          runToEnd(finishJob(sys, res.body?.id as string, "completed"));
          seen.push(jobOf(sys, res.body?.id as string).idemAcceptanceId as string);
        }
      }
      sys.dynamic.now += IDEMPOTENCY_TTL_MS + 1;
    }
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
  });

  it("a record with the same verification ID but a different acceptance identity (e.g. restored) is never overwritten", () => {
    const sys = world();
    const a = send(sys, req(SAME));
    const scope = scopeOf(sys);
    const restored = { ...(sys.store.get<IdemRecord>(scope) as IdemRecord), acceptanceId: "acc_" + "f".repeat(32) };
    sys.store.put(scope, restored);
    runToEnd(handleDelete(sys, "live1", a.body?.id as string));
    runToEnd(sweep(sys));
    expect(sys.store.get<IdemRecord>(scope)).toEqual(restored);
  });
});
