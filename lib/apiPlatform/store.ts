/**
 * API platform identity store (API-1a). Every mutation and its security audit event are written in the
 * SAME Firestore transaction (PRD §12.1 `apiAuditEvents`: "in same transaction as the mutation"), so a
 * mutation can never commit without its audit row, and vice versa.
 *
 * Callers are management routes that have ALREADY authorized the actor (management.ts). These functions
 * still enforce org binding (an app/key of another org is "not_found") and never trust caller-supplied
 * org, plan or scope beyond validation.
 */
import { newAppId, newAuditId, newOrgId, isAppId, isKeyId, isOrgId } from "@/lib/apiPlatform/ids";
import { mintApiKey, type KeyMode, type PepperSet } from "@/lib/apiPlatform/keys";
import { appPath, auditPath, computeApiOrgMembershipId, keyPath, membershipPath, orgPath } from "@/lib/apiPlatform/tenantPaths";
import type { FirestoreLike, TransactionLike } from "@/lib/apiPlatform/firestorePort";
import {
  API_SCOPES,
  DEFAULT_KEY_SCOPES,
  type ApiAuditEventRecord,
  type ApiScope,
  type AuditEventType,
} from "@/lib/apiPlatform/types";

export type StoreFailure =
  | "invalid_input"
  | "not_found"
  | "org_not_active"
  | "app_not_active"
  | "already_revoked"
  | "peppers_unavailable";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; reason: StoreFailure };

export interface StoreContext {
  readonly db: FirestoreLike;
  readonly actorUid: string;
  readonly requestId: string;
  readonly now: number;
}

/** Max rotation overlap (tenancy-and-auth.md §4.5). */
export const MAX_ROTATION_OVERLAP_SECONDS = 30 * 24 * 3600;
const NAME_RE = /^[\p{L}\p{N} ._\-–—()&,'/]{1,80}$/u;

function audit(
  tx: TransactionLike,
  ctx: StoreContext,
  type: AuditEventType,
  orgId: string,
  subject: ApiAuditEventRecord["subject"],
): void {
  const auditId = newAuditId();
  const row: ApiAuditEventRecord = {
    auditId,
    type,
    orgId,
    actor: { kind: "user", uid: ctx.actorUid },
    at: ctx.now,
    requestId: ctx.requestId,
    subject,
  };
  tx.create(ctx.db.doc(auditPath(auditId)), row as unknown as Record<string, unknown>);
}

const validUid = (uid: unknown): uid is string => typeof uid === "string" && uid.length > 0 && uid.length <= 128;

/** Creates an org (status active, no API plan) with the actor as its single owner. */
export async function createOrganization(ctx: StoreContext, input: { name: string }): Promise<StoreResult<{ orgId: string }>> {
  if (!validUid(ctx.actorUid) || typeof input.name !== "string" || !NAME_RE.test(input.name)) return { ok: false, reason: "invalid_input" };
  const orgId = newOrgId();
  const membershipId = computeApiOrgMembershipId(orgId, ctx.actorUid);
  await ctx.db.runTransaction(async (tx) => {
    tx.create(ctx.db.doc(orgPath(orgId)), {
      orgId, name: input.name, status: "active", apiPlan: null, createdBy: ctx.actorUid, createdAt: ctx.now,
    });
    tx.create(ctx.db.doc(membershipPath(membershipId)), {
      membershipId, orgId, uid: ctx.actorUid, role: "owner", status: "active", createdAt: ctx.now,
    });
    audit(tx, ctx, "org.created", orgId, {});
    audit(tx, ctx, "member.added", orgId, { membershipRole: "owner" });
  });
  return { ok: true, value: { orgId } };
}

export async function createApplication(ctx: StoreContext, input: { orgId: string; name: string }): Promise<StoreResult<{ appId: string }>> {
  if (!isOrgId(input.orgId) || typeof input.name !== "string" || !NAME_RE.test(input.name)) return { ok: false, reason: "invalid_input" };
  const appId = newAppId();
  return ctx.db.runTransaction(async (tx) => {
    const org = await tx.get(ctx.db.doc(orgPath(input.orgId)));
    if (!org.exists) return { ok: false, reason: "not_found" } as const;
    if (org.data()?.status !== "active") return { ok: false, reason: "org_not_active" } as const;
    tx.create(ctx.db.doc(appPath(appId)), {
      appId, orgId: input.orgId, name: input.name, status: "active", createdBy: ctx.actorUid, createdAt: ctx.now,
    });
    audit(tx, ctx, "app.created", input.orgId, { appId });
    return { ok: true, value: { appId } } as const;
  });
}

export function normalizeScopes(requested: readonly unknown[] | undefined): readonly ApiScope[] | null {
  if (requested === undefined) return [...DEFAULT_KEY_SCOPES].sort();
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > API_SCOPES.length) return null;
  const set = new Set<ApiScope>();
  for (const s of requested) {
    if (typeof s !== "string" || !(API_SCOPES as readonly string[]).includes(s)) return null;
    set.add(s as ApiScope);
  }
  return [...set].sort();
}

export interface CreatedKey {
  readonly keyId: string;
  readonly prefix: string;
  /** Returned ONCE to the caller for display; never stored. */
  readonly displaySecret: string;
}

interface KeyInput {
  readonly orgId: string;
  readonly appId: string;
  readonly mode: KeyMode;
  readonly scopes?: readonly unknown[];
  readonly appScoped?: boolean;
  readonly expiresAt?: number | null;
}

function validateKeyInput(input: KeyInput, now: number): readonly ApiScope[] | null {
  if (!isOrgId(input.orgId) || !isAppId(input.appId) || (input.mode !== "live" && input.mode !== "test")) return null;
  if (input.appScoped !== undefined && typeof input.appScoped !== "boolean") return null;
  if (input.expiresAt != null && (!Number.isInteger(input.expiresAt) || input.expiresAt <= now)) return null;
  return normalizeScopes(input.scopes);
}

/** Mints a key for an active app of an active org; the key doc is tx.create'd (a keyId collision aborts). */
export async function createApiKey(ctx: StoreContext, input: KeyInput, peppers: PepperSet): Promise<StoreResult<CreatedKey>> {
  const scopes = validateKeyInput(input, ctx.now);
  if (!scopes) return { ok: false, reason: "invalid_input" };
  const minted = mintApiKey(input.mode, peppers);
  if (!minted.ok) return { ok: false, reason: "peppers_unavailable" };
  const k = minted.key;
  return ctx.db.runTransaction(async (tx) => {
    const org = await tx.get(ctx.db.doc(orgPath(input.orgId)));
    const app = await tx.get(ctx.db.doc(appPath(input.appId)));
    if (!org.exists || !app.exists || app.data()?.orgId !== input.orgId) return { ok: false, reason: "not_found" } as const;
    if (org.data()?.status !== "active") return { ok: false, reason: "org_not_active" } as const;
    if (app.data()?.status !== "active") return { ok: false, reason: "app_not_active" } as const;
    tx.create(ctx.db.doc(keyPath(k.keyId)), {
      keyId: k.keyId, orgId: input.orgId, appId: input.appId, mode: k.mode, scopes, appScoped: input.appScoped ?? true,
      verifier: k.verifier, hashVersion: 1, prefix: k.prefix, createdBy: ctx.actorUid, createdAt: ctx.now,
      expiresAt: input.expiresAt ?? null, revokedAt: null, revokedBy: null, rotatedTo: null,
    });
    audit(tx, ctx, "api_key.created", input.orgId, { appId: input.appId, credentialPrefix: k.prefix });
    return { ok: true, value: { keyId: k.keyId, prefix: k.prefix, displaySecret: k.displaySecret } } as const;
  });
}

/** Immediate revocation (no positive cache anywhere). A key of another org is "not_found". */
export async function revokeApiKey(ctx: StoreContext, input: { orgId: string; keyId: string }): Promise<StoreResult<{ prefix: string }>> {
  if (!isOrgId(input.orgId) || !isKeyId(input.keyId)) return { ok: false, reason: "invalid_input" };
  return ctx.db.runTransaction(async (tx) => {
    const ref = ctx.db.doc(keyPath(input.keyId));
    const snap = await tx.get(ref);
    const d = snap.data();
    if (!snap.exists || !d || d.orgId !== input.orgId) return { ok: false, reason: "not_found" } as const;
    if (d.revokedAt !== null && d.revokedAt !== undefined) return { ok: false, reason: "already_revoked" } as const;
    tx.update(ref, { revokedAt: ctx.now, revokedBy: ctx.actorUid });
    audit(tx, ctx, "api_key.revoked", input.orgId, { appId: String(d.appId), credentialPrefix: String(d.prefix) });
    return { ok: true, value: { prefix: String(d.prefix) } } as const;
  });
}

/**
 * Rotation: a new key with the same org/app/mode/scopes/appScoped; the old key expires after `overlapSeconds`
 * (0 = revoked now). One transaction: new key + old key update + audit.
 */
export async function rotateApiKey(
  ctx: StoreContext,
  input: { orgId: string; keyId: string; overlapSeconds: number },
  peppers: PepperSet,
): Promise<StoreResult<CreatedKey>> {
  if (!isOrgId(input.orgId) || !isKeyId(input.keyId)) return { ok: false, reason: "invalid_input" };
  if (!Number.isInteger(input.overlapSeconds) || input.overlapSeconds < 0 || input.overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS) {
    return { ok: false, reason: "invalid_input" };
  }
  return ctx.db.runTransaction(async (tx) => {
    const oldRef = ctx.db.doc(keyPath(input.keyId));
    const old = await tx.get(oldRef);
    const d = old.data();
    if (!old.exists || !d || d.orgId !== input.orgId) return { ok: false, reason: "not_found" } as const;
    if (d.revokedAt !== null && d.revokedAt !== undefined) return { ok: false, reason: "already_revoked" } as const;
    if (d.expiresAt !== null && !(typeof d.expiresAt === "number" && d.expiresAt > ctx.now)) return { ok: false, reason: "already_revoked" } as const;
    const org = await tx.get(ctx.db.doc(orgPath(input.orgId)));
    const app = await tx.get(ctx.db.doc(appPath(String(d.appId))));
    if (!org.exists || !app.exists || app.data()?.orgId !== input.orgId) return { ok: false, reason: "not_found" } as const;
    if (org.data()?.status !== "active") return { ok: false, reason: "org_not_active" } as const;
    if (app.data()?.status !== "active") return { ok: false, reason: "app_not_active" } as const;
    const mode = d.mode === "live" ? "live" : d.mode === "test" ? "test" : null;
    const scopes = normalizeScopes(Array.isArray(d.scopes) ? (d.scopes as unknown[]) : undefined);
    if (!mode || !scopes || typeof d.appScoped !== "boolean") return { ok: false, reason: "invalid_input" } as const;
    const minted = mintApiKey(mode, peppers);
    if (!minted.ok) return { ok: false, reason: "peppers_unavailable" } as const;
    const k = minted.key;
    tx.create(ctx.db.doc(keyPath(k.keyId)), {
      keyId: k.keyId, orgId: input.orgId, appId: d.appId, mode, scopes, appScoped: d.appScoped,
      verifier: k.verifier, hashVersion: 1, prefix: k.prefix, createdBy: ctx.actorUid, createdAt: ctx.now,
      expiresAt: null, revokedAt: null, revokedBy: null, rotatedTo: null,
    });
    const oldExpiry = typeof d.expiresAt === "number" ? Math.min(d.expiresAt, ctx.now + input.overlapSeconds * 1000) : ctx.now + input.overlapSeconds * 1000;
    tx.update(oldRef, input.overlapSeconds === 0
      ? { rotatedTo: k.keyId, revokedAt: ctx.now, revokedBy: ctx.actorUid }
      : { rotatedTo: k.keyId, expiresAt: oldExpiry });
    audit(tx, ctx, "api_key.rotated", input.orgId, {
      appId: String(d.appId), credentialPrefix: k.prefix, replacedCredentialPrefix: String(d.prefix),
    });
    return { ok: true, value: { keyId: k.keyId, prefix: k.prefix, displaySecret: k.displaySecret } } as const;
  });
}
