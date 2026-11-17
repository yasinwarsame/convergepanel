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
  JobDoc,
  finishJob,
  handleCancel,
  handleCreate,
  idemPath,
  runToEnd,
} from "./support/idempotencyReferenceModel";

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
  const org: OrgDoc = { status: "active", livePlanActive: true, creditsRemaining: 1000, pipelineAck: true, planMaxModels: 5, concurrencyLimit: 5, running: 0 };
  sys.store.put("orgs/o1", org);
  const live: KeyDoc = { orgId: "o1", appId: "a1", mode: "live", scopes: ["verifications:write", "verifications:read"], revoked: false };
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
    case "concurrency_full": return patchOrg(sys, { running: 5 });
    case "capacity_shed": sys.dynamic.capacityShed = true; return;
  }
}

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
    expect(Object.keys(marker).sort()).toEqual(["expiresAt", "kind", "verificationId"]);
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
    sys.store.put("keys/foreign", { orgId: "o2", appId: "b1", mode: "live", scopes: ["verifications:write"], revoked: false } satisfies KeyDoc);
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
    if (row.state === "deleted") sys.deleteVerification(scope);
    return { sys, target: id };
  };

  it.each(rows.map((r) => [`${r.id} ${r.target}/${r.state} → ${r.response}`, r] as const))("%s", (_n, row) => {
    const { sys, target } = setupCancel(row);
    const runningBefore = (sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).running;
    const res = runToEnd(handleCancel(sys, "live1", target));
    const expected = row.response.split(" ");
    expect(res.status).toBe(Number(expected[0]));
    if (res.status !== 200) expect(res.code).toBe(expected[1]);
    const runningAfter = (sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).running;
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
    expect(after.running).toBe(before.running - 1);
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
      expect((o.sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).running).toBe(jobs);
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
    expect((sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).running).toBe(0);
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
      expect((o.sys.store.get<OrgDoc>("orgs/o1") as OrgDoc).running).toBe(0);
    }
  });
});
