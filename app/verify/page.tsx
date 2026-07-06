"use client";

/**
 * /verify — Standalone verification page for the Chrome extension.
 *
 * Reads "text" and "source" from URL search params, prefills a textarea,
 * and shows the selected text to ALL visitors. Unauthenticated users see a
 * signup CTA; authenticated users get the action buttons.
 */

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";

export default function VerifyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, authReady } = useAuth();

  const rawText = searchParams.get("text") || "";
  const source = searchParams.get("source") || "";

  // Initialize synchronously so the textarea and char count render immediately.
  // searchParams.get() already URL-decodes, so no further decoding is needed.
  // The effect keeps claim in sync if the URL changes (e.g. post-signup redirect).
  const [claim, setClaim] = useState(rawText);
  useEffect(() => { setClaim(rawText); }, [rawText]);

  const handleClaimVerification = () => {
    router.push(`/?tab=verify&claim=${encodeURIComponent(claim)}`);
  };

  const handleDeepResearch = () => {
    router.push(`/?tab=research&q=${encodeURIComponent(claim)}`);
  };

  const signupHref = `/signup?redirect=${encodeURIComponent(`/verify${window?.location?.search ?? ""}`)}`;
  const loginHref  = `/login?redirect=${encodeURIComponent(`/verify${window?.location?.search ?? ""}`)}`;

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
            onChange={(e) => setClaim(e.target.value)}
            rows={6}
            className="w-full resize-y rounded-xl border border-cp-border bg-cp-raised px-4 py-3 text-sm text-cp-text placeholder:text-cp-faint focus:border-cp-accent focus:outline-none focus:ring-2 focus:ring-cp-primary-soft"
            placeholder="Paste a claim, quote, or statement to verify…"
          />
          {claim && (
            <p className="mt-2 text-xs text-cp-faint">
              {claim.length} character{claim.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Actions — differ by auth state */}
        {!authReady ? (
          /* Tiny spinner while auth resolves — text is already visible above */
          <div className="mt-6 flex justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-cp-border border-t-cp-accent" />
          </div>
        ) : user ? (
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
