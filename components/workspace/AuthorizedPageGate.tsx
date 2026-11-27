"use client";

/**
 * ZCA (D-4) — the shared state frame for a neutral workspace shell.
 *
 * Renders identity-specific children ONLY for a `ready` resource (see useAuthorizedResource):
 *   loading      → a neutral placeholder (identical for every visitor)
 *   signed_out   → redirect to sign-in (no request was sent; nothing is shown)
 *   unauthorized → a neutral "sign in again" notice (the bearer was refused; nothing is shown)
 *   not_found    → the page's 404 (`notFound()`), exactly as the server render used to answer
 *   unavailable  → a neutral retryable error
 */
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { notFound, usePathname, useRouter } from "next/navigation";
import type { AuthorizedResource } from "@/hooks/useAuthorizedResource";

export function AuthorizedPageGate<T>({
  resource,
  children,
}: {
  resource: AuthorizedResource<T> & { retry: () => void };
  children: (data: T) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const signedOut = resource.status === "signed_out";

  useEffect(() => {
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname ?? "/workspace")}`);
  }, [signedOut, pathname, router]);

  switch (resource.status) {
    case "ready":
      return <>{children(resource.data)}</>;
    case "not_found":
      notFound();
    // notFound() throws; nothing below runs for this case.
    // eslint-disable-next-line no-fallthrough
    case "unauthorized":
      return (
        <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14" data-testid="authorized-page-unauthorized">
          <p className="text-sm text-cp-muted">
            We couldn&apos;t confirm your access to this page.{" "}
            <Link href="/login" className="font-medium text-cp-accent underline-offset-2 hover:underline">
              Sign in again
            </Link>
            .
          </p>
        </main>
      );
    case "unavailable":
      return (
        <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14" data-testid="authorized-page-unavailable">
          <p className="text-sm text-cp-muted">Something went wrong while loading this page.</p>
          <button
            type="button"
            onClick={resource.retry}
            className="mt-2 text-sm font-medium text-cp-accent underline-offset-2 hover:underline"
          >
            Try again
          </button>
        </main>
      );
    case "loading":
    case "signed_out":
    default:
      return (
        <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14" aria-busy="true" data-testid="authorized-page-loading">
          <div className="h-4 w-40 animate-pulse rounded bg-cp-border-soft" />
          <div className="mt-3 h-7 w-72 animate-pulse rounded bg-cp-border-soft" />
        </main>
      );
  }
}
