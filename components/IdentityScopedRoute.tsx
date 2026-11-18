"use client";

/**
 * PR #329 R4 (owner A2) — the hash-frozen home page (`app/page.tsx`) keeps its
 * React state (`claimInput`, `question`, results, ...) across an identity
 * change: when account A signs out and B signs in without a full reload, B saw
 * A's draft (pre-existing). The frozen file is not edited; instead the root
 * layout wraps the page children in this component, which REMOUNTS the "/"
 * page subtree whenever the signed-in identity changes, so no React state of
 * one identity survives into another.
 *
 * Decided at RENDER time (a render-phase state update, applied by React before
 * anything commits), so not one frame of the old page renders under the new
 * identity. Rules:
 *   - the first known identity of a page load does NOT remount (cold load:
 *     unknown -> A or unknown -> anonymous keeps whatever is on screen);
 *   - a token refresh for the same uid does not remount;
 *   - any other change (A -> B, A -> signed out, signed out -> B) remounts.
 * Only paths in IDENTITY_SCOPED_PATHS are scoped; on every other route the key
 * never changes, so it renders exactly as before (/verify keys its own body by
 * identity already). Navigation never changes the key.
 */
import { Fragment, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

export const IDENTITY_SCOPED_PATHS: ReadonlySet<string> = new Set(["/"]);

export function IdentityScopedRoute({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { authReady, user } = useAuth();
  const identity = authReady ? (user?.uid ? `uid:${user.uid}` : "anon") : null;
  const scoped = pathname !== null && IDENTITY_SCOPED_PATHS.has(pathname);
  const [scope, setScope] = useState<{ last: string | null; generation: number }>({ last: null, generation: 0 });
  let current = scope;
  if (identity !== null && identity !== scope.last) {
    // The key changes ONLY for an identity change while a scoped page is shown; navigating between routes never
    // changes it, so other routes keep their exact previous behaviour.
    const remount = scope.last !== null && scoped;
    current = { last: identity, generation: scope.generation + (remount ? 1 : 0) };
    setScope(current);
  }
  return <Fragment key={`identity-${current.generation}`}>{children}</Fragment>;
}
