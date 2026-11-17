/**
 * API principal guard (API-1a; PRD §7.2; tenancy-and-auth.md §4–5). Modelled on the S2-b decision
 * pattern (typed decision, fail closed, no cache, one principal) but a SEPARATE credential type:
 * it never consults Firebase Auth, custom claims, ADMIN_EMAILS or any administrator tier, and no
 * administrator module is reachable from it (pinned by apiPrincipalBoundary.spec.ts).
 *
 * Order of checks (PRD §7.2): parse → peppers → key lookup → hash (+ hashVersion) → revoked / expired / mode →
 * org + app → then the only two 403s that reveal nothing new to the key holder (org_suspended,
 * live_key_requires_plan) → scope. Every key failure is the same `invalid_api_key`.
 * Cookies are ignored entirely.
 *
 * READ-ONLY (owner ruling R-7): authentication performs no write of any kind. `PrincipalDeps` exposes only
 * readers, records are read through own-field copies and never modified, and a key hashed under the previous
 * pepper is NOT rehashed on use. Pinned by lib/apiPlatform/__tests__/principalReadOnly.spec.ts.
 */
import { burnVerification, keyHashMatches, parseApiKey, type KeyMode, type PepperSet } from "@/lib/apiPlatform/keys";
import { API_SCOPES, type ApiScope } from "@/lib/apiPlatform/types";
import type { ApiErrorCode } from "@/lib/apiPlatform/errors";
import { isApprovedApiPlanId } from "@/lib/apiPlatform/apiPlans";

export interface ApiPrincipal {
  readonly kind: "api_key";
  readonly orgId: string;
  readonly appId: string;
  readonly keyId: string;
  readonly credentialPrefix: string;
  readonly mode: KeyMode;
  readonly scopes: readonly ApiScope[];
  readonly appScoped: boolean;
}

export type PrincipalDecision =
  | { readonly ok: true; readonly principal: ApiPrincipal }
  | { readonly ok: false; readonly code: Extract<ApiErrorCode, "invalid_api_key" | "org_suspended" | "live_key_requires_plan" | "insufficient_scope" | "api_unavailable"> };

export interface PrincipalDeps {
  readonly peppers: () => PepperSet;
  /** One document read each; return null when absent. Throwing → 503. */
  readonly getKey: (keyId: string) => Promise<Record<string, unknown> | null>;
  readonly getOrg: (orgId: string) => Promise<Record<string, unknown> | null>;
  readonly getApp: (appId: string) => Promise<Record<string, unknown> | null>;
  readonly now: () => number;
}

const AUTH_RE = /^Bearer (\S+)$/;
const deny = (code: Extract<PrincipalDecision, { ok: false }>["code"]): PrincipalDecision => ({ ok: false, code });

/**
 * A null-prototype copy of a stored record's OWN enumerable fields (null for a non-object). Every check below
 * reads the copy, so an inherited property (Object.prototype pollution, a class instance, a crafted
 * prototype) can never satisfy one. Reading only: the stored record is never modified.
 */
function ownRecord(r: unknown): Record<string, unknown> | null {
  return typeof r === "object" && r !== null && !Array.isArray(r) ? Object.assign(Object.create(null) as Record<string, unknown>, r) : null;
}

function orgHasActiveApiPlan(org: Record<string, unknown>): boolean {
  const plan = ownRecord(org.plan);
  return !!plan && plan.status === "active" && isApprovedApiPlanId(plan.planId);
}

export async function requireApiPrincipal(headers: Headers, scope: ApiScope, deps: PrincipalDeps): Promise<PrincipalDecision> {
  if (!(API_SCOPES as readonly string[]).includes(scope)) return deny("api_unavailable"); // programming error: fail closed
  try {
    const m = AUTH_RE.exec(headers.get("authorization") ?? "");
    const parsed = m ? parseApiKey(m[1]) : null;
    if (!parsed) return deny("invalid_api_key");

    const peppers = deps.peppers();
    if (peppers.status !== "available") return deny("api_unavailable");

    const key = ownRecord(await deps.getKey(parsed.keyId));
    if (!key) {
      burnVerification(parsed, peppers);
      return deny("invalid_api_key");
    }
    if (key.keyId !== parsed.keyId || !keyHashMatches(parsed, key.hash, peppers)) return deny("invalid_api_key");
    if (key.hashVersion !== 1) return deny("invalid_api_key"); // unknown hash scheme: never accepted
    if (key.mode !== parsed.mode) return deny("invalid_api_key");
    if (key.revokedAt !== null) return deny("invalid_api_key"); // undefined (malformed) also denies
    const now = deps.now();
    if (key.expiresAt !== null && !(typeof key.expiresAt === "number" && key.expiresAt > now)) return deny("invalid_api_key");
    if (typeof key.orgId !== "string" || typeof key.appId !== "string") return deny("invalid_api_key");
    if (typeof key.appScoped !== "boolean" || !Array.isArray(key.scopes)) return deny("invalid_api_key");

    const [org, app] = (await Promise.all([deps.getOrg(key.orgId), deps.getApp(key.appId)])).map(ownRecord);
    if (!org || org.orgId !== key.orgId) return deny("invalid_api_key");
    if (!app || app.appId !== key.appId || app.orgId !== key.orgId || app.status !== "active") return deny("invalid_api_key");
    if (org.status === "suspended") return deny("org_suspended");
    if (org.status !== "active") return deny("invalid_api_key"); // canceled or unknown
    if (parsed.mode === "live" && !orgHasActiveApiPlan(org)) return deny("live_key_requires_plan");

    const scopes = (key.scopes as unknown[]).filter((s): s is ApiScope => typeof s === "string" && (API_SCOPES as readonly string[]).includes(s));
    if (!scopes.includes(scope)) return deny("insufficient_scope");

    return {
      ok: true,
      principal: Object.freeze({
        kind: "api_key",
        orgId: key.orgId,
        appId: key.appId,
        keyId: parsed.keyId,
        credentialPrefix: `cpk_${parsed.mode}_${parsed.keyId}`,
        mode: parsed.mode,
        scopes: Object.freeze([...scopes]),
        appScoped: key.appScoped,
      }),
    };
  } catch {
    return deny("api_unavailable");
  }
}
