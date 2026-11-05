/**
 * Operator Production access — the grant READER (owner ruling on I-1/I-2 MAJOR-2, 2026-11-04).
 *
 * Firebase isolation refuses the Production project outside the Vercel Production deployment. Four reviewed operator
 * maintenance scripts must still reach Production deliberately. They do it through ONE narrow path:
 *
 *   scripts/lib/operatorProductionAccess.ts (imported first by each script) creates a frozen grant in this process, only
 *   when the operator names the target on the command line (`--confirm-project=<id>`), and only in a local operator
 *   shell. lib/firebase/admin.ts consults `readOperatorGrant()` ONLY to lift a Production refusal, and ONLY when the grant
 *   names exactly the project the credentials resolved to.
 *
 * Not an environment switch: no variable turns it on. The grant exists only if code in this very process created it
 * from explicit argv. This reader independently refuses any grant inside Vercel (VERCEL / VERCEL_ENV present), inside a
 * Next.js server (NEXT_RUNTIME present), or when NODE_ENV is "production", so web request handlers and Preview builds
 * can never use it even if the grant module were imported there (static tests also forbid that import).
 */

export const OPERATOR_GRANT_KEY = Symbol.for("convergepanel.firebase.operatorProductionGrant.v1");

export interface OperatorProductionGrant {
  readonly version: 1;
  readonly projectId: string;
  readonly operation: string;
  readonly mode: "read-only" | "write";
  readonly grantedAt: string;
}

/** Shared by the grant writer and this reader: may an operator grant exist in this process at all? */
export function operatorShellRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.VERCEL !== undefined && env.VERCEL !== "") return "running inside Vercel (VERCEL is set)";
  if (env.VERCEL_ENV !== undefined && env.VERCEL_ENV !== "") return "running inside a Vercel build or runtime (VERCEL_ENV is set)";
  if (env.NEXT_RUNTIME !== undefined && env.NEXT_RUNTIME !== "") return "running inside a Next.js server (NEXT_RUNTIME is set)";
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  return null;
}

export function readOperatorGrant(): OperatorProductionGrant | null {
  if (operatorShellRefusal() !== null) return null;
  const g = (globalThis as Record<symbol, unknown>)[OPERATOR_GRANT_KEY] as Partial<OperatorProductionGrant> | undefined;
  if (!g || typeof g !== "object" || !Object.isFrozen(g)) return null;
  const desc = Object.getOwnPropertyDescriptor(globalThis, OPERATOR_GRANT_KEY);
  if (!desc || desc.writable || desc.configurable) return null; // must be the immutable slot the writer creates
  if (g.version !== 1 || typeof g.projectId !== "string" || g.projectId.length === 0) return null;
  if (typeof g.operation !== "string" || g.operation.length === 0 || (g.mode !== "read-only" && g.mode !== "write")) return null;
  if (typeof g.grantedAt !== "string") return null;
  return g as OperatorProductionGrant;
}
