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
export type Scope = "verifications:write" | "verifications:read";

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
  concurrencyLimit: number;
  running: number;
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

  /** DELETE /v1/verifications/{id} (retention-and-deletion.md §3.1), reduced to its effect here. */
  deleteVerification(scopePath: string): void {
    const rec = this.store.get<IdemRecord>(scopePath);
    if (!rec) throw new Error("no record");
    // A non-terminal job is canceled first (retention-and-deletion.md §3.1), which releases it.
    const before = this.store.get<JobDoc>(`jobs/${rec.verificationId}`);
    runToEnd(finishJob(this, rec.verificationId, "canceled", before?.credits));
    const job = this.store.get<JobDoc>(`jobs/${rec.verificationId}`) as JobDoc;
    // The marker is content-free: no request hash, no response body.
    this.store.put(scopePath, { kind: "deleted", verificationId: rec.verificationId, expiresAt: rec.expiresAt });
    this.store.put(`jobs/${rec.verificationId}`, { ...job, deleted: true });
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
function newJobChecks(sys: System, req: ValidRequest, org: OrgDoc): ApiResponse | null {
  const d = sys.dynamic;
  if (!d.typeEnabled[req.type]) return { status: 422, code: "type_unavailable" };
  if (req.type === "research" && !org.pipelineAck) return { status: 403, code: "pipeline_processing_not_acknowledged" };
  if (req.models.some((m) => !d.modelsAvailable.has(m))) return { status: 422, code: "model_unavailable" };
  if (req.models.length > org.planMaxModels) return { status: 422, code: "model_limit_exceeded" };
  if (!d.queueHealthy) return { status: 503, code: "queue_unavailable" };
  if (org.running >= org.concurrencyLimit) return { status: 429, code: "concurrency_limit" };
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
    const reject = newJobChecks(sys, v, org2 as OrgDoc);
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
    tx.create(`jobs/${id}`, { state: "pending_dispatch", orgId: key2?.orgId, credits, type: v.type } satisfies JobDoc);
    tx.create(`ledger/reserve_${id}`, { credits });
    tx.set(`orgs/${key2?.orgId}`, { ...org3, creditsRemaining: org3.creditsRemaining - credits, running: org3.running + 1 });
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
export type JobState = "pending_dispatch" | "queued" | "running" | "completed" | "partial" | "failed" | "canceled" | "expired";
const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(["completed", "partial", "failed", "canceled", "expired"]);

export interface JobDoc {
  state: JobState;
  orgId: string | undefined;
  credits: number;
  type: string;
  deleted?: boolean;
  cancelRequested?: boolean;
}

/**
 * Moves a job to a terminal state and releases its active-job count in the SAME transaction.
 * Conditional on the job being non-terminal, so a repeated or concurrent release is a no-op.
 * `releaseCredits` is the unsettled remainder returned to the organization.
 */
export function* finishJob(sys: System, id: string, to: JobState, releaseCredits?: number): Generator<void, ApiResponse, void> {
  if (!TERMINAL.has(to)) throw new Error(`not a terminal state: ${to}`);
  for (let attempt = 1; ; attempt++) {
    const tx = sys.store.begin();
    const job = tx.read<JobDoc>(`jobs/${id}`);
    if (!job || job.deleted || TERMINAL.has(job.state)) {
      tx.abort();
      return { status: 200 }; // idempotent: already released
    }
    const org = tx.read<OrgDoc>(`orgs/${job.orgId}`) as OrgDoc;
    if (org.running <= 0) throw new Error("reconciliation fault: active-job count would go negative");
    yield;
    tx.set(`jobs/${id}`, { ...job, state: to });
    tx.set(`orgs/${job.orgId}`, { ...org, running: org.running - 1, creditsRemaining: org.creditsRemaining + (releaseCredits ?? 0) });
    if (tx.commit() === "committed") return { status: 200 };
    if (attempt >= MAX_TX_ATTEMPTS * 10) throw new Error("finishJob contention");
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
  if (job.deleted) return { status: 410, code: "verification_deleted" };
  if (TERMINAL.has(job.state)) return { status: 409, code: "not_cancelable" };
  if (job.state === "running") {
    sys.store.put(`jobs/${id}`, { ...job, cancelRequested: true });
    return { status: 200 };
  }
  // pending_dispatch / queued: canceled now, full release, in one transaction.
  return yield* finishJob(sys, id, "canceled", job.credits);
}

/** Runs a handler to completion with no interleaving. */
export function runToEnd(gen: Generator<void, ApiResponse, void>): ApiResponse {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}
