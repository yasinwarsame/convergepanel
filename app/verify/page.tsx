"use client";

/**
 * /verify — Standalone verification page for the Chrome extension.
 *
 * Shows the text the extension selected (or the user typed), a signup CTA to
 * signed-out visitors and the action buttons to signed-in users.
 *
 * Privacy remediation PR #329:
 *   - R2: the text lives in a bounded, expiring, identity-bound pending input
 *     in this tab's sessionStorage (lib/client/verifyPrefill.ts), never in the
 *     address bar; the signup/login `redirect=` carries `source` only.
 *   - R3 (review MAJOR-2): what the textarea DISPLAYS is derived from storage
 *     and the current identity on every render (no React copy), the page body
 *     is keyed by identity (nothing survives an identity change), and nothing
 *     is shown until auth is ready. The layout's ContentHandoffMigrator
 *     captures `#text=` (current extension) / `?text=` (legacy) before any
 *     effect runs. Run / Deep Research hand the text to the main app through
 *     the one-time tab-scoped hand-off — no claim text in the URL.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import {
  appHandoffHref,
  consumePendingVerifyInput,
  pendingVerifyInputExpiresAt,
  readVisiblePendingVerifyInput,
  subscribeTabHandoffs,
  sweepTabHandoffs,
  tabStorage,
  updatePendingVerifyInput,
  verifyReturnPath,
} from "@/lib/client/verifyPrefill";

/** Identity key for the page body: `unknown` until auth is ready, then `anon` or `uid:<uid>`. */
function verifyIdentityKey(authReady: boolean, uid: string | null | undefined): string {
  if (!authReady) return "unknown";
  return uid ? `uid:${uid}` : "anon";
}

export default function VerifyPage() {
  const { user, authReady } = useAuth();
  const viewer = authReady ? user?.uid ?? null : undefined;
  return <VerifyPageBody key={verifyIdentityKey(authReady, user?.uid)} viewer={viewer} />;
}

/**
 * `viewer`: undefined = identity not yet known; null = anonymous; else the
 * signed-in uid. Keyed by identity in VerifyPage, so a new identity always
 * mounts a fresh body.
 */
function VerifyPageBody({ viewer }: { viewer: string | null | undefined }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const source = searchParams.get("source") || "";

  // DERIVED, never copied: re-read from storage for THIS viewer on every render and every hand-off change.
  const claim = useSyncExternalStore(
    subscribeTabHandoffs,
    () => readVisiblePendingVerifyInput(tabStorage(), viewer),
    () => ""
  );

  // Expired / malformed records are removed from storage on mount (never during render).
  useEffect(() => {
    sweepTabHandoffs(tabStorage());
  }, []);

  // An abandoned pending input disappears from the screen at its expiry, not only on the next interaction.
  const [, rerender] = useState(0);
  useEffect(() => {
    const at = pendingVerifyInputExpiresAt(tabStorage());
    if (at === null) return;
    const t = setTimeout(() => rerender((n) => n + 1), Math.max(0, at - Date.now()) + 5);
    return () => clearTimeout(t);
  }, [claim]);

  const identityKnown = viewer !== undefined;

  const handleClaimChange = (value: string) => {
    if (!identityKnown) return;
    updatePendingVerifyInput(tabStorage(), value, viewer ?? null);
  };

  const handleDiscard = () => {
    consumePendingVerifyInput(tabStorage());
  };

  const handOff = (kind: "verify" | "research") => {
    if (typeof viewer !== "string" || !claim.trim()) return;
    // `/?tab=<kind>` with the text in the one-time hand-off (legacy URL only if sessionStorage is blocked).
    const href = appHandoffHref(kind, claim, viewer);
    consumePendingVerifyInput(tabStorage());
    router.push(href);
  };
  const handleClaimVerification = () => handOff("verify");
  const handleDeepResearch = () => handOff("research");

  const returnPath = verifyReturnPath(source);
  const signupHref = `/signup?redirect=${encodeURIComponent(returnPath)}`;
  const loginHref  = `/login?redirect=${encodeURIComponent(returnPath)}`;

  return (
    <main className="min-h-screen bg-cp-bg px-4 py-12 text-cp-text">
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-cp-text sm:text-3xl">
            Verify with ConvergePanel
          </h1>
          <p className="mt-2 text-sm text-cp-muted">
            {source === "extension"
              ? "Sent from the ConvergePanel browser extension. Choose how to verify this text."
              : "Paste or edit the text below, then choose a verification method."}
          </p>
        </div>

        {/* Claim textarea — visible to everyone */}
        <div className="rounded-[14px] border border-cp-border bg-cp-surface p-5 shadow-sm">
          <label
            htmlFor="verify-text"
            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-cp-faint"
          >
            Text to verify
          </label>
          <textarea
            id="verify-text"
            value={claim}
            onChange={(e) => handleClaimChange(e.target.value)}
            disabled={!identityKnown}
            rows={6}
            className="w-full resize-y rounded-xl border border-cp-border bg-cp-raised px-4 py-3 text-sm text-cp-text placeholder:text-cp-faint focus:border-cp-accent focus:outline-none focus:ring-2 focus:ring-cp-primary-soft"
            placeholder="Paste a claim, quote, or statement to verify…"
          />
          {claim && (
            <div className="mt-2 flex items-center justify-between text-xs text-cp-faint">
              <p>
                {claim.length} character{claim.length !== 1 ? "s" : ""}
              </p>
              <button
                type="button"
                onClick={handleDiscard}
                className="font-semibold text-cp-muted underline-offset-2 hover:text-cp-text hover:underline"
              >
                Discard text
              </button>
            </div>
          )}
        </div>

        {/* Actions — differ by auth state */}
        {!identityKnown ? (
          /* Tiny spinner while auth resolves — text is already visible above */
          <div className="mt-6 flex justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-cp-border border-t-cp-accent" />
          </div>
        ) : typeof viewer === "string" ? (
          /* Authenticated: action buttons */
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              onClick={handleClaimVerification}
              disabled={!claim.trim()}
              className="flex-1 rounded-[11px] bg-cp-primary px-5 py-3 text-sm font-semibold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run Claim Verification
            </button>
            <button
              onClick={handleDeepResearch}
              disabled={!claim.trim()}
              className="flex-1 rounded-[11px] border border-cp-border bg-cp-surface px-5 py-3 text-sm font-semibold text-cp-text shadow-sm transition hover:bg-cp-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cp-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run Deep Research
            </button>
            <Link
              href="/"
              onClick={() => consumePendingVerifyInput(tabStorage())}
              className="flex-1 rounded-[11px] border border-cp-border bg-cp-surface px-5 py-3 text-center text-sm font-semibold text-cp-text shadow-sm transition hover:border-cp-faint hover:bg-cp-raised"
            >
              Open Main App
            </Link>
          </div>
        ) : (
          /* Unauthenticated: signup CTA */
          <div className="mt-6 rounded-[14px] border border-cp-border bg-cp-primary-tint px-6 py-6 text-center">
            <p className="mb-1 text-base font-semibold text-cp-text">
              Create a free account to verify this
            </p>
            <p className="mb-5 text-sm text-cp-muted">
              ConvergePanel runs your text through 5 AI models simultaneously and returns a panel verdict — free to try.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link
                href={signupHref}
                className="rounded-[11px] bg-cp-primary px-6 py-3 text-sm font-bold text-white shadow-[0_2px_8px_rgba(37,99,235,0.3)] transition hover:bg-cp-accent"
              >
                Create free account →
              </Link>
              <Link
                href={loginHref}
                className="rounded-[11px] border border-cp-border bg-cp-surface px-6 py-3 text-sm font-semibold text-cp-text transition hover:border-cp-faint hover:bg-cp-raised"
              >
                Log in
              </Link>
            </div>
          </div>
        )}

        {/* Footer note */}
        <p className="mt-8 text-center text-xs text-cp-faint">
          ConvergePanel sends your text to multiple AI models for independent verification.
          Results include consensus scoring and governance signals.
        </p>
      </div>
    </main>
  );
}
