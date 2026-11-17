/**
 * Executable reference model of the documented create-request decision procedure
 * (jobs-and-idempotency.md §5A, error-catalog.md §3.1; Owner Decision Addendum 3, m3).
 *
 * Docs-only: this is NOT the implementation. It is a small, dependency-free model that the
 * spec `docs/__tests__/apiIdempotencyReplayPrecedence.spec.ts` drives with the truth table parsed
 * from the markdown, with state transitions, and with every interleaving of two or three
 * concurrent requests. A future implementation must pass the same scenarios.
 *
 * Firestore semantics modelled (Admin SDK server transactions):
 *   - the idempotency document is LOCKED by the transaction that reads it, until that
 *     transaction commits or aborts; a second transaction that finds it locked aborts and
 *     retries, up to MAX_TX_ATTEMPTS, then answers 409 `request_in_progress` (nothing written);
 *   - every other document read inside the transaction is version-checked at commit; a changed
 *     version aborts the commit and the transaction retries from the start;
 *   - `create` fails if the document exists (tx.create semantics);
 *   - writes become visible only at commit, all together.
 * Handlers are generators: each `yield` is a point where another request may run, so a
 * scheduler can enumerate interleavings deterministically.
 */

export const MAX_TX_ATTEMPTS = 3;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type Mode = "live" | "test";
export type Scope = "verifications:write" | "verifications:read" | "verifications:delete";

export interface KeyDoc {
  orgId: string;
  appId: string;
  mode: Mode;
  scopes: Scope[];
  revoked: boolean;
}

export interface OrgDoc {
  status: "active" | "suspended";
  livePlanActive: boolean;
  creditsRemaining: number;
  pipelineAck: boolean;
  planMaxModels: number;
  /** The plan's admission limit for accepted non-terminal jobs. Not a counter. */
  concurrencyLimit: number;
}

// ------------------------------------------------------------------------------------------------
// Concurrency record (jobs-and-idempotency.md §5B, Addendum 5). These constants are compared with
// the normative document by the spec, so the model and the doc cannot drift.
// ------------------------------------------------------------------------------------------------
/** ONE organization-scoped, unsharded record; its identity never depends on a month or period. */
export const CONCURRENCY_RECORD_TEMPLATE = "apiOrgConcurrency/{orgId}";
/** Field on the job that records its single release, set in the terminal-transition transaction. */
export const RELEASE_MARKER_FIELD = "concurrencyReleased";
/** Field on the job that records that its admission was counted, set in T-create. */
export const ADMISSION_MARKER_FIELD = "concurrencyCounted";
export const concurrencyPath = (orgId: string): string => CONCURRENCY_RECORD_TEMPLATE.replace("{orgId}", orgId);
export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);
export const periodPath = (orgId: string, month: string): string => `periods/${orgId}/${month}`;

export interface ConcurrencyDoc {
  active: number;
  anomalies: number;
}

export interface PeriodDoc {
  reservedCredits: number;
}

export interface AuditEvent {
  type: "concurrency.release_anomaly" | "concurrency.drift_detected" | "concurrency.repaired";
  orgId: string;
  detail: string;
}

export interface AcceptedBody {
  object: "verification";
  id: string;
  status: "queued";
  type: string;
  credits_reserved: number;
}

export interface IdemRecord {
  kind: "committed" | "deleted";
  /** Canonical request (stands in for its SHA-256). Absent on a deleted marker (content-free). */
  requestHash?: string;
  verificationId: string;
  response?: AcceptedBody;
  expiresAt: number;
}

export interface ApiResponse {
  status: number;
  code?: string;
  body?: AcceptedBody;
  replayed?: boolean;
}

export interface CreateRequest {
  keyId: string;
  idempotencyKey?: string;
  prefer?: string;
  body: unknown;
}

/** Non-transactional dynamic state (Redis-class store, provider health, switches). */
export interface Dynamic {
  now: number;
  modelsAvailable: Set<string>;
  typeEnabled: { claim: boolean; research: boolean };
  queueHealthy: boolean;
  capacityShed: boolean;
  /** Remaining authenticated create-rate budget per key. Missing = unlimited. */
  rateRemaining: Map<string, number>;
}

// ------------------------------------------------------------------------------------------------
// Transactional document store
// ------------------------------------------------------------------------------------------------
interface Doc {
  version: number;
  value: unknown;
}

export class Store {
  private docs = new Map<string, Doc>();
  private locks = new Map<string, string>();
  private nextTx = 1;
  readonly log: string[] = [];

  get<T>(path: string): T | undefined {
    return this.docs.get(path)?.value as T | undefined;
  }

  /** A committed single write outside any transaction (setup, admin operations). */
  put(path: string, value: unknown): void {
    const prev = this.docs.get(path);
    this.docs.set(path, { version: (prev?.version ?? 0) + 1, value });
  }

  delete(path: string): void {
    const prev = this.docs.get(path);
    if (prev) this.docs.set(path, { version: prev.version + 1, value: undefined });
  }

  holdLock(path: string, owner: string): void {
    this.locks.set(path, owner);
  }

  releaseLock(path: string, owner: string): void {
    if (this.locks.get(path) === owner) this.locks.delete(path);
  }

  keys(prefix: string): string[] {
    return Array.from(this.docs.keys()).filter((k) => k.startsWith(prefix) && this.docs.get(k)?.value !== undefined);
  }

  begin(): Tx {
    return new Tx(this, `tx${this.nextTx++}`);
  }

  /** Internal: used by Tx. */
  _lock(path: string, tx: string): boolean {
    const holder = this.locks.get(path);
    if (holder !== undefined && holder !== tx) return false;
    this.locks.set(path, tx);
    return true;
  }

  _version(path: string): number {
    return this.docs.get(path)?.version ?? 0;
  }

  _exists(path: string): boolean {
    return this.docs.get(path)?.value !== undefined;
  }

  _releaseAll(tx: string): void {
    for (const [p, owner] of Array.from(this.locks)) if (owner === tx) this.locks.delete(p);
  }
}

type Write = { op: "set" | "create"; path: string; value: unknown };

export class Tx {
  private reads = new Map<string, number>();
  private writes: Write[] = [];
  private done = false;

  constructor(private store: Store, readonly id: string) {}

  lock(path: string): boolean {
    return this.store._lock(path, this.id);
  }

  read<T>(path: string): T | undefined {
    if (!this.reads.has(path)) this.reads.set(path, this.store._version(path));
    return this.store.get<T>(path);
  }

  set(path: string, value: unknown): void {
    this.writes.push({ op: "set", path, value });
  }

  create(path: string, value: unknown): void {
    this.writes.push({ op: "create", path, value });
  }

  /** Validates every read version and every create; applies all writes or none. */
  commit(): "committed" | "conflict" {
    if (this.done) throw new Error("transaction already finished");
    this.done = true;
    const stale = Array.from(this.reads).some(([p, v]) => this.store._version(p) !== v);
    const clash = this.writes.some((w) => w.op === "create" && this.store._exists(w.path));
    if (stale || clash) {
      this.store._releaseAll(this.id);
      return "conflict";
    }
    for (const w of this.writes) {
      this.store.put(w.path, w.value);
      this.store.log.push(`${this.id} ${w.op} ${w.path}`);
    }
    this.store._releaseAll(this.id);
    return "committed";
  }

  abort(): void {
    this.done = true;
    this.store._releaseAll(this.id);
  }
}

// ------------------------------------------------------------------------------------------------
// System
// ------------------------------------------------------------------------------------------------
export class System {
  readonly store = new Store();
  readonly dynamic: Dynamic = {
    now: 1_000_000,
    modelsAvailable: new Set(["chatgpt", "claude", "gemini", "grok", "perplexity"]),
    typeEnabled: { claim: true, research: true },
    queueHealthy: true,
    capacityShed: false,
    rateRemaining: new Map(),
  };
  readonly dispatched: string[] = [];
  readonly audit: AuditEvent[] = [];
  private seq = 0;

  newId(): string {
    this.seq += 1;
    return `ver_${String(this.seq).padStart(24, "0")}`;
  }

  jobs(): string[] {
    return this.store.keys("jobs/");
  }

  reservations(): string[] {
    return this.store.keys("ledger/");
  }

  readonly settlements: string[] = [];
  readonly releases: string[] = [];

  /**
   * Test helper: DELETE through the documented path (handleDelete, Addendum 6) and then one
   * sweeper pass, which completes the deletion when no settlement is outstanding (a queued or
   * terminal job). A running job's deletion stays pending until its terminal transition.
   */
  deleteVerification(scopePath: string, keyId = "live1"): ApiResponse {
    const rec = this.store.get<IdemRecord>(scopePath);
    if (!rec) throw new Error("no record");
    const res = runToEnd(handleDelete(this, keyId, rec.verificationId));
    runToEnd(sweep(this));
    return res;
  }
}

export function idemPath(key: KeyDoc, idempotencyKey: string): string {
  return `orgs/${key.orgId}/idempotency/${key.appId}|${key.mode}|${idempotencyKey}`;
}

// ------------------------------------------------------------------------------------------------
// Validation and canonicalization (error-catalog.md §4, §4.5) — reduced to what the model needs
// ------------------------------------------------------------------------------------------------
export interface ValidRequest {
  type: "claim" | "research";
  models: string[];
  canonical: string;
}

function nfcDeep(v: unknown): unknown {
  if (typeof v === "string") return v.normalize("NFC");
  if (Array.isArray(v)) return v.map(nfcDeep);
  if (v !== null && typeof v === "object") {
    const out: { [k: string]: unknown } = {};
    for (const k of Object.keys(v as object).sort()) out[k.normalize("NFC")] = nfcDeep((v as { [k: string]: unknown })[k]);
    return out;
  }
  return v;
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as { [k: string]: unknown };
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function validateAndCanonicalize(body: unknown, prefer: string | undefined): ValidRequest | ApiResponse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { status: 400, code: "invalid_request" };
  const n = nfcDeep(body) as { [k: string]: unknown };
  if (n.type !== "claim" && n.type !== "research") return { status: 400, code: "invalid_request" };
  const models = Array.isArray(n.models) ? (n.models as unknown[]) : ["chatgpt", "claude"];
  if (!models.every((m) => typeof m === "string")) return { status: 400, code: "invalid_model" };
  if (models.length < 2) return { status: 422, code: "too_few_models" };
  if (models.length > 5) return { status: 422, code: "model_limit_exceeded" };
  return { type: n.type, models: models as string[], canonical: `${canonicalJson(n)}|${n.type}|${prefer ?? ""}` };
}

// ------------------------------------------------------------------------------------------------
// Authorization (steps 3, 5, 6; re-checked inside T-create at step 8b)
// ------------------------------------------------------------------------------------------------
function authorize(key: KeyDoc | undefined, org: OrgDoc | undefined): ApiResponse | null {
  if (!key || key.revoked) return { status: 401, code: "invalid_api_key" };
  if (!org || org.status === "suspended") return { status: 403, code: "org_suspended" };
  if (key.mode === "live" && !org.livePlanActive) return { status: 403, code: "live_key_requires_plan" };
  if (!key.scopes.includes("verifications:write")) return { status: 403, code: "insufficient_scope" };
  return null;
}

/** Steps 9–14: checks that apply ONLY to a request that would create a new job. */
function newJobChecks(sys: System, req: ValidRequest, org: OrgDoc, active: number): ApiResponse | null {
  const d = sys.dynamic;
  if (!d.typeEnabled[req.type]) return { status: 422, code: "type_unavailable" };
  if (req.type === "research" && !org.pipelineAck) return { status: 403, code: "pipeline_processing_not_acknowledged" };
  if (req.models.some((m) => !d.modelsAvailable.has(m))) return { status: 422, code: "model_unavailable" };
  if (req.models.length > org.planMaxModels) return { status: 422, code: "model_limit_exceeded" };
  if (!d.queueHealthy) return { status: 503, code: "queue_unavailable" };
  if (active >= org.concurrencyLimit) return { status: 429, code: "concurrency_limit" };
  if (org.creditsRemaining < creditsFor(req)) return { status: 402, code: "quota_exceeded" };
  if (d.capacityShed) return { status: 503, code: "capacity_protection" };
  return null;
}

export function creditsFor(req: ValidRequest): number {
  return Math.ceil(req.models.length * (req.type === "research" ? 1.5 : 1)) + 1;
}

// ------------------------------------------------------------------------------------------------
// POST /v1/verifications — the documented decision procedure
// ------------------------------------------------------------------------------------------------
export function* handleCreate(sys: System, req: CreateRequest): Generator<void, ApiResponse, void> {
  // Steps 0–2 (global availability, transport, pre-authentication flood limit) read no tenant
  // data and are outside this model.

  // Step 3: authenticate (non-transactional read of the key).
  const key = sys.store.get<KeyDoc>(`keys/${req.keyId}`);
  if (!key || key.revoked) return { status: 401, code: "invalid_api_key" };

  // Step 4: authenticated rate limit. May throttle a replay; never writes, never creates work.
  const left = sys.dynamic.rateRemaining.get(req.keyId);
  if (left !== undefined) {
    if (left <= 0) return { status: 429, code: "rate_limited" };
    sys.dynamic.rateRemaining.set(req.keyId, left - 1);
  }

  // Steps 5–6: current organization state, plan and scope.
  const pre = authorize(key, sys.store.get<OrgDoc>(`orgs/${key.orgId}`));
  if (pre) return pre;

  // Step 7: decode, validate, NFC, canonicalize. Idempotency-Key is required for live keys.
  const v = validateAndCanonicalize(req.body, req.prefer);
  if ("status" in v) return v;
  if (key.mode === "live" && req.idempotencyKey === undefined) return { status: 400, code: "invalid_request" };

  yield;

  // Step 8: T-create. Its FIRST read is the idempotency record.
  const scope = req.idempotencyKey !== undefined ? idemPath(key, req.idempotencyKey) : null;
  for (let attempt = 1; ; attempt++) {
    const tx = sys.store.begin();
    if (scope !== null && !tx.lock(scope)) {
      tx.abort();
      if (attempt >= MAX_TX_ATTEMPTS) return { status: 409, code: "request_in_progress" };
      yield;
      continue;
    }
    const rec = scope !== null ? tx.read<IdemRecord>(scope) : undefined;

    // 8b: re-establish CURRENT authorization inside the transaction, before any replay.
    const key2 = tx.read<KeyDoc>(`keys/${req.keyId}`);
    const org2 = key2 ? tx.read<OrgDoc>(`orgs/${key2.orgId}`) : undefined;
    const denied = authorize(key2, org2);
    if (denied) {
      if (tx.commit() === "conflict") {
        if (attempt >= MAX_TX_ATTEMPTS) return { status: 409, code: "request_in_progress" };
        yield;
        continue;
      }
      return denied;
    }

    // 8c: a live (unexpired) record decides the response; evaluation stops here.
    const liveRec = rec !== undefined && rec.expiresAt > sys.dynamic.now ? rec : undefined;
    if (liveRec !== undefined) {
      if (tx.commit() === "conflict") {
        if (attempt >= MAX_TX_ATTEMPTS) return { status: 409, code: "request_in_progress" };
        yield;
        continue;
      }
      if (liveRec.kind === "deleted") return { status: 410, code: "verification_deleted" };
      if (liveRec.requestHash !== v.canonical) return { status: 409, code: "idempotency_key_reused" };
      return { status: 202, body: liveRec.response, replayed: true };
    }

    // Steps 9–14: new-job-only checks, still inside the transaction.
    // Step 12 reads the ONE concurrency record inside T-create (version-checked at commit).
    const orgId = key2?.orgId as string;
    const conc = tx.read<ConcurrencyDoc>(concurrencyPath(orgId)) ?? { active: 0, anomalies: 0 };
    const month = monthOf(sys.dynamic.now);
    const period = tx.read<PeriodDoc>(periodPath(orgId, month)) ?? { reservedCredits: 0 };
    const reject = newJobChecks(sys, v, org2 as OrgDoc, conc.active);
    if (reject) {
      if (tx.commit() === "conflict") {
        if (attempt >= MAX_TX_ATTEMPTS) return { status: 409, code: "request_in_progress" };
        yield;
        continue;
      }
      return reject;
    }

    yield;

    // Step 15: job + reservation + idempotency record, one commit.
    const id = sys.newId();
    const credits = creditsFor(v);
    const body: AcceptedBody = { object: "verification", id, status: "queued", type: v.type, credits_reserved: credits };
    const org3 = org2 as OrgDoc;
    // Admission: job (with its admission marker), reservation, monthly period counter and the
    // concurrency increment commit together, or none does. Counted only if this commit succeeds.
    tx.create(`jobs/${id}`, { state: "pending_dispatch", orgId, credits, type: v.type, admissionId: id, [ADMISSION_MARKER_FIELD]: true, [RELEASE_MARKER_FIELD]: false, reservedMonth: month, queuedAt: sys.dynamic.now, idemScope: scope ?? undefined } satisfies JobDoc);
    tx.create(`inputs/${id}`, { text: v.canonical }); // class (a) content, purged at deletion
    tx.create(`ledger/reserve_${id}`, { credits, month });
    tx.set(periodPath(orgId, month), { reservedCredits: period.reservedCredits + credits } satisfies PeriodDoc);
    tx.set(`orgs/${orgId}`, { ...org3, creditsRemaining: org3.creditsRemaining - credits });
    tx.set(concurrencyPath(orgId), { ...conc, active: conc.active + 1 } satisfies ConcurrencyDoc);
    if (scope !== null) {
      tx.set(scope, { kind: "committed", requestHash: v.canonical, verificationId: id, response: body, expiresAt: sys.dynamic.now + IDEMPOTENCY_TTL_MS });
    }
    if (tx.commit() === "conflict") {
      if (attempt >= MAX_TX_ATTEMPTS) return { status: 409, code: "request_in_progress" };
      yield;
      continue;
    }
    // After commit: dispatch (transactional outbox). Never on a replay.
    sys.dispatched.push(id);
    return { status: 202, body };
  }
}

// ------------------------------------------------------------------------------------------------
// Job lifecycle: terminal transitions release the concurrency count exactly once (§5B)
// ------------------------------------------------------------------------------------------------
export type JobState = "pending_dispatch" | "queued" | "running" | "synthesizing" | "completed" | "partial" | "failed" | "canceled" | "expired";
const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(["completed", "partial", "failed", "canceled", "expired"]);

export interface JobDoc {
  state: JobState;
  orgId: string | undefined;
  credits: number;
  type: string;
  admissionId?: string;
  concurrencyCounted?: boolean;
  concurrencyReleased?: boolean;
  concurrencyReleaseAnomaly?: boolean;
  reservedMonth?: string;
  /** Purged tombstone (Addendum 6): set only by completeDeletion, after settlement and release. */
  deleted?: boolean;
  cancelRequested?: boolean;
  /** Deletion intent recorded by DELETE; the job stays counted until its terminal transition. */
  deletionRequested?: boolean;
  deletionId?: string;
  idemScope?: string;
  queuedAt?: number;
  leaseExpiries?: number;
  failureCode?: string;
  callsMade?: number;
}

/**
 * The ONLY release path (jobs-and-idempotency.md §5B): the first valid non-terminal → terminal
 * transition of a counted job releases it, in the SAME transaction, against the same record it
 * was admitted to. A job that is already terminal (or deleted) is a no-op, so duplicate workers,
 * retries, sweeper runs, cancellations and deletions cannot release twice. If the record would go
 * negative, the terminal transition still commits; the release is recorded as an anomaly, an
 * audit/alert event is written, and the count is left for an audited repair.
 * `releaseCredits` is the unsettled remainder returned to the organization (billing, separate).
 */
export function* finishJob(sys: System, id: string, to: JobState, releaseCredits?: number, failureCode?: string, result?: unknown): Generator<void, ApiResponse, void> {
  if (!TERMINAL.has(to)) throw new Error(`not a terminal state: ${to}`);
  for (let attempt = 1; ; attempt++) {
    const tx = sys.store.begin();
    const job = tx.read<JobDoc>(`jobs/${id}`);
    // Deletion intent does NOT suppress the transition: a deletion-pending job is released by its
    // terminal transition like any other (Addendum 6). A purged tombstone is always terminal.
    if (!job || TERMINAL.has(job.state)) {
      tx.abort();
      return { status: 200 }; // idempotent: the first terminal transition already released it
    }
    const orgId = job.orgId as string;
    const org = tx.read<OrgDoc>(`orgs/${orgId}`) as OrgDoc;
    const mustRelease = job[ADMISSION_MARKER_FIELD] === true && job[RELEASE_MARKER_FIELD] !== true;
    const conc = mustRelease ? tx.read<ConcurrencyDoc>(concurrencyPath(orgId)) ?? { active: 0, anomalies: 0 } : undefined;
    yield;
    const next: JobDoc = { ...job, state: to, ...(failureCode ? { failureCode } : {}) };
    let anomaly = false;
    if (mustRelease && conc) {
      next[RELEASE_MARKER_FIELD] = true;
      if (conc.active >= 1) tx.set(concurrencyPath(orgId), { ...conc, active: conc.active - 1 });
      else {
        anomaly = true; // never negative: record, alert, leave for an audited repair
        next.concurrencyReleaseAnomaly = true;
        tx.set(concurrencyPath(orgId), { ...conc, anomalies: conc.anomalies + 1 });
      }
    }
    tx.set(`jobs/${id}`, next);
    if (result !== undefined) tx.set(`results/${id}`, result); // written only by the winning transition
    tx.set(`orgs/${orgId}`, { ...org, creditsRemaining: org.creditsRemaining + (releaseCredits ?? 0) });
    if (tx.commit() === "committed") {
      sys.settlements.push(id);
      if (mustRelease && !anomaly) sys.releases.push(id);
      if (anomaly) sys.audit.push({ type: "concurrency.release_anomaly", orgId, detail: id });
      return { status: 200 };
    }
    if (attempt >= MAX_TX_ATTEMPTS * 10) throw new Error("finishJob contention");
    yield;
  }
}

/** Counted, unreleased jobs of an organization (what the record must equal). Non-transactional. */
export function countedActive(sys: System, orgId: string): number {
  return sys.jobs().filter((p) => {
    const j = sys.store.get<JobDoc>(p) as JobDoc;
    return j.orgId === orgId && j[ADMISSION_MARKER_FIELD] === true && j[RELEASE_MARKER_FIELD] !== true;
  }).length;
}

/**
 * Sweeper reconciliation: DETECTION ONLY, never writes the record. The record and the job query are
 * read at ONE read time (a read-only transaction: every read is validated together; a change in
 * between retries the snapshot), so a concurrent admission or release cannot cause a spurious
 * alert. Deletion-pending jobs are counted like any other counted, unreleased job.
 */
export function* detectDriftTx(sys: System, orgId: string): Generator<void, boolean, void> {
  for (;;) {
    const tx = sys.store.begin();
    const stored = tx.read<ConcurrencyDoc>(concurrencyPath(orgId))?.active ?? 0;
    yield;
    let counted = 0;
    for (const p of sys.store.keys("jobs/")) {
      const j = tx.read<JobDoc>(p) as JobDoc;
      if (j.orgId === orgId && j[ADMISSION_MARKER_FIELD] === true && j[RELEASE_MARKER_FIELD] !== true) counted++;
    }
    if (tx.commit() === "conflict") {
      yield;
      continue; // not one consistent read time: take a new snapshot
    }
    if (stored !== counted) sys.audit.push({ type: "concurrency.drift_detected", orgId, detail: `stored=${stored} counted=${counted}` });
    return stored !== counted;
  }
}

export function detectDrift(sys: System, orgId: string): boolean {
  const g = detectDriftTx(sys, orgId);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * Audited operator repair. In ONE transaction: read the concurrency record FIRST, then read every
 * job of the organization (a transactional query in the Admin SDK), recount counted-and-unreleased
 * jobs, and set the record. Every admission and release writes the record, so any of them that
 * commits between this transaction's reads and its commit aborts it, and it retries.
 */
export function* repairConcurrency(sys: System, orgId: string): Generator<void, ApiResponse, void> {
  for (let attempt = 1; ; attempt++) {
    const tx = sys.store.begin();
    const conc = tx.read<ConcurrencyDoc>(concurrencyPath(orgId)) ?? { active: 0, anomalies: 0 };
    yield;
    let count = 0;
    for (const p of sys.store.keys("jobs/")) {
      const j = tx.read<JobDoc>(p) as JobDoc;
      if (j.orgId === orgId && j[ADMISSION_MARKER_FIELD] === true && j[RELEASE_MARKER_FIELD] !== true) count++;
    }
    yield;
    tx.set(concurrencyPath(orgId), { ...conc, active: count });
    if (tx.commit() === "committed") {
      sys.audit.push({ type: "concurrency.repaired", orgId, detail: `from=${conc.active} to=${count}` });
      return { status: 200 };
    }
    if (attempt >= MAX_TX_ATTEMPTS * 10) throw new Error("repair contention");
    yield;
  }
}

/** POST /v1/verifications/{id}/cancel (§6; error-catalog.md §3.1 read-path table). */
export function* handleCancel(sys: System, keyId: string, id: string): Generator<void, ApiResponse, void> {
  const key = sys.store.get<KeyDoc>(`keys/${keyId}`);
  if (!key || key.revoked) return { status: 401, code: "invalid_api_key" };
  const left = sys.dynamic.rateRemaining.get(keyId);
  if (left !== undefined) {
    if (left <= 0) return { status: 429, code: "rate_limited" };
    sys.dynamic.rateRemaining.set(keyId, left - 1);
  }
  const pre = authorize(key, sys.store.get<OrgDoc>(`orgs/${key.orgId}`));
  if (pre) return pre;
  yield;
  const notFound: ApiResponse = { status: 404, code: "verification_not_found" };
  if (!/^ver_[A-Za-z0-9]{24}$/.test(id)) return notFound;
  const job = sys.store.get<JobDoc>(`jobs/${id}`);
  // Tenant binding first: a foreign job, deleted or not, is indistinguishable from none.
  if (!job || job.orgId !== key.orgId) return notFound;
  if (job.deleted || job.deletionRequested) return { status: 410, code: "verification_deleted" };
  if (TERMINAL.has(job.state)) return { status: 409, code: "not_cancelable" };
  if (job.state === "running" || job.state === "synthesizing") {
    sys.store.put(`jobs/${id}`, { ...job, cancelRequested: true });
    return { status: 200 };
  }
  // pending_dispatch / queued: canceled now, full release, in one transaction.
  return yield* finishJob(sys, id, "canceled", job.credits);
}

// ------------------------------------------------------------------------------------------------
// Deletion: cancellation and settlement before purge (Addendum 6; retention-and-deletion.md §3.1)
// ------------------------------------------------------------------------------------------------
export const LEASE_EXPIRY_LIMIT = 3;
export const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;
export const deletionPath = (delId: string): string => `apiDeletions/${delId}`;
export const deletionIdFor = (verId: string): string => `del_${verId.slice(4)}`;

export interface DeletionOp {
  status: "pending" | "completed";
  verificationId: string;
  orgId: string;
  attempts: number;
  blockedBy?: "awaiting_terminal" | "awaiting_release";
}

function isCountedUnreleased(j: JobDoc): boolean {
  return j[ADMISSION_MARKER_FIELD] === true && j[RELEASE_MARKER_FIELD] !== true;
}

/** Shared tenant-bound lookup of the read paths: foreign, nonexistent and malformed are one 404. */
function lookupOwn(sys: System, key: KeyDoc, id: string): JobDoc | null {
  if (!/^ver_[A-Za-z0-9]{24}$/.test(id)) return null;
  const job = sys.store.get<JobDoc>(`jobs/${id}`);
  return job && job.orgId === key.orgId ? job : null;
}

/** GET /v1/verifications/{id} (also /report, /models): 410 from the moment DELETE is accepted. */
export function handleGet(sys: System, keyId: string, id: string): ApiResponse {
  const key = sys.store.get<KeyDoc>(`keys/${keyId}`);
  if (!key || key.revoked) return { status: 401, code: "invalid_api_key" };
  const job = lookupOwn(sys, key, id);
  if (!job) return { status: 404, code: "verification_not_found" };
  if (job.deleted || job.deletionRequested) return { status: 410, code: "verification_deleted" };
  return { status: 200 };
}

/**
 * DELETE /v1/verifications/{id}: creates or reuses ONE idempotent deletion operation and returns
 * 202 with it. Records the deletion intent and requests cancellation in one transaction, and turns
 * the idempotency record into the content-free marker. Never releases or purges by itself.
 */
export function* handleDelete(sys: System, keyId: string, id: string): Generator<void, ApiResponse & { deletion?: DeletionOp & { id: string } }, void> {
  const key = sys.store.get<KeyDoc>(`keys/${keyId}`);
  if (!key || key.revoked) return { status: 401, code: "invalid_api_key" };
  if (!key.scopes.includes("verifications:delete")) return { status: 403, code: "insufficient_scope" };
  if (!lookupOwn(sys, key, id)) return { status: 404, code: "verification_not_found" };
  const delId = deletionIdFor(id);
  for (;;) {
    const tx = sys.store.begin();
    const job = tx.read<JobDoc>(`jobs/${id}`) as JobDoc;
    const existing = tx.read<DeletionOp>(deletionPath(delId));
    if (existing) {
      tx.abort();
      return { status: 202, deletion: { id: delId, ...existing } }; // duplicate DELETE: same operation
    }
    yield;
    const op: DeletionOp = { status: "pending", verificationId: id, orgId: key.orgId, attempts: 0 };
    tx.create(deletionPath(delId), op);
    tx.set(`jobs/${id}`, { ...job, deletionRequested: true, deletionId: delId, ...(TERMINAL.has(job.state) ? {} : { cancelRequested: true }) });
    if (job.idemScope) {
      const rec = tx.read<IdemRecord>(job.idemScope);
      if (rec) tx.set(job.idemScope, { kind: "deleted", verificationId: rec.verificationId, expiresAt: rec.expiresAt });
    }
    if (tx.commit() === "conflict") {
      yield;
      continue;
    }
    // A queued job has no worker to stop: cancel it now (its terminal transition releases it).
    if (job.state === "pending_dispatch" || job.state === "queued") {
      yield* finishJob(sys, id, "canceled", job.credits, "deletion_requested");
    }
    return { status: 202, deletion: { id: delId, ...op } };
  }
}

/**
 * A worker's provider call. Safe boundary: before the call, a job with cancellation requested (or
 * deletion requested) stops; a call already in flight completes and its record is written while the
 * job is still non-terminal. Late-write barrier: no record is written for a terminal or purged job.
 */
export function* workerProviderCall(sys: System, id: string): Generator<void, ApiResponse, void> {
  const before = sys.store.get<JobDoc>(`jobs/${id}`);
  if (!before || before.deleted || TERMINAL.has(before.state)) return { status: 409, code: "late_write_refused" };
  if (before.cancelRequested) return { status: 409, code: "stopped_at_boundary" };
  yield; // the provider call is in flight; it cannot be recalled
  for (;;) {
    const tx = sys.store.begin();
    const job = tx.read<JobDoc>(`jobs/${id}`);
    if (!job || job.deleted || TERMINAL.has(job.state)) {
      tx.abort();
      return { status: 409, code: "late_write_refused" };
    }
    const n = (job.callsMade ?? 0) + 1;
    tx.set(`calls/${id}/${n}`, { text: "raw model text" }); // class (a), purged at deletion
    tx.set(`jobs/${id}`, { ...job, callsMade: n });
    if (tx.commit() === "committed") return { status: 200 };
    yield;
  }
}

/** The worker at a step boundary: stops a job whose cancellation was requested, settling work done. */
export function* workerBoundary(sys: System, id: string): Generator<void, ApiResponse, void> {
  const job = sys.store.get<JobDoc>(`jobs/${id}`);
  if (!job || TERMINAL.has(job.state)) return { status: 200 };
  if (!job.cancelRequested) return { status: 200 };
  const unused = Math.max(0, job.credits - (job.callsMade ?? 0));
  return yield* finishJob(sys, id, "canceled", unused, job.deletionRequested ? "deletion_requested" : "canceled");
}

/**
 * Completes a deletion operation ONLY after settlement and release: the job must be terminal and
 * its admission released. Otherwise the operation stays `pending`, counts the attempt and names
 * what it waits for (observable, retryable). Then, in one transaction: purge content (inputs,
 * calls, results), reduce the job to a minimal tombstone, mark the operation `completed`.
 */
export function* completeDeletion(sys: System, delId: string): Generator<void, ApiResponse, void> {
  for (;;) {
    const tx = sys.store.begin();
    const op = tx.read<DeletionOp>(deletionPath(delId));
    if (!op || op.status === "completed") {
      tx.abort();
      return { status: 200 };
    }
    const id = op.verificationId;
    const job = tx.read<JobDoc>(`jobs/${id}`) as JobDoc;
    const blockedBy = !TERMINAL.has(job.state) ? "awaiting_terminal" : isCountedUnreleased(job) ? "awaiting_release" : undefined;
    yield;
    if (blockedBy) {
      tx.set(deletionPath(delId), { ...op, attempts: op.attempts + 1, blockedBy });
      if (tx.commit() === "conflict") continue;
      return { status: 202 };
    }
    for (const p of [`inputs/${id}`, `results/${id}`, ...sys.store.keys(`calls/${id}/`)]) {
      if (tx.read(p) !== undefined) tx.set(p, undefined);
    }
    tx.set(`jobs/${id}`, {
      state: job.state, orgId: job.orgId, credits: job.credits, type: job.type, admissionId: job.admissionId,
      [ADMISSION_MARKER_FIELD]: job[ADMISSION_MARKER_FIELD], [RELEASE_MARKER_FIELD]: job[RELEASE_MARKER_FIELD],
      deletionRequested: true, deletionId: delId, deleted: true,
    } satisfies JobDoc);
    tx.set(deletionPath(delId), { ...op, status: "completed", attempts: op.attempts + 1, blockedBy: undefined });
    if (tx.commit() === "committed") return { status: 200 };
  }
}

/**
 * Sweeper pass (§4.4): bounded recovery for EVERY non-terminal state, deletion-pending or not.
 * `running` / `synthesizing` with LEASE_EXPIRY_LIMIT expired leases → terminal (`failed:
 * worker_timeout`, or `canceled: deletion_requested` when deletion is pending); `pending_dispatch` /
 * `queued` past the max queue wait (or with deletion pending) → terminal with a full release. Then
 * it retries every pending deletion operation.
 */
export function* sweep(sys: System): Generator<void, ApiResponse, void> {
  for (const p of sys.jobs()) {
    const j = sys.store.get<JobDoc>(p) as JobDoc;
    if (TERMINAL.has(j.state)) continue;
    const id = p.slice("jobs/".length);
    if ((j.state === "running" || j.state === "synthesizing") && (j.leaseExpiries ?? 0) >= LEASE_EXPIRY_LIMIT) {
      const unused = Math.max(0, j.credits - (j.callsMade ?? 0));
      yield* finishJob(sys, id, j.deletionRequested ? "canceled" : "failed", unused, j.deletionRequested ? "deletion_requested" : "worker_timeout");
    } else if ((j.state === "pending_dispatch" || j.state === "queued") && (j.deletionRequested || sys.dynamic.now - (j.queuedAt ?? 0) > MAX_QUEUE_WAIT_MS)) {
      yield* finishJob(sys, id, j.deletionRequested ? "canceled" : "expired", j.credits, j.deletionRequested ? "deletion_requested" : "max_queue_wait");
    }
  }
  for (const p of sys.store.keys("apiDeletions/")) {
    const op = sys.store.get<DeletionOp>(p) as DeletionOp;
    if (op.status === "pending") yield* completeDeletion(sys, p.slice("apiDeletions/".length));
  }
  return { status: 200 };
}

/** Failure codes the failed-job count and ratio exclude as platform-caused (ledger-and-billing.md §4). */
export const PLATFORM_FAULT_CODES: readonly string[] = ["capacity_unavailable", "pipeline_disabled", "worker_timeout", "persistence_failed"];

/** Runs a handler to completion with no interleaving. */
export function runToEnd(gen: Generator<void, ApiResponse, void>): ApiResponse {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}
