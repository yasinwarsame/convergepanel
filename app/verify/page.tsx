"use client";

/**
 * /verify — Standalone verification page for the Chrome extension.
 *
 * Reads "text" and "source" from URL search params, prefills a textarea,
 * and offers actions: Claim Verification, Deep Research, or Open Main App.
 *
 * Auth guard: unauthenticated users are redirected to /login with the full
 * /verify?... path preserved so they return here after login.
 */

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";

export default function VerifyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading, authReady } = useAuth();

  const rawText = searchParams.get("text") || "";
  const source = searchParams.get("source") || "";

  const [claim, setClaim] = useState("");

  useEffect(() => {
    if (rawText) {
      try {
        setClaim(decodeURIComponent(rawText));
      } catch {
        setClaim(rawText);
      }
    }
  }, [rawText]);

  // Auth guard: redirect unauthenticated users to login with full path preserved
  useEffect(() => {
    if (!authReady) return;
    if (user) return;

    const currentPath = `/verify${window.location.search}`;
    const loginUrl = `/login?redirect=${encodeURIComponent(currentPath)}`;
    router.replace(loginUrl);
  }, [authReady, user, router]);

  const handleClaimVerification = () => {
    router.push(`/?tab=verify&claim=${encodeURIComponent(claim)}`);
  };

  const handleDeepResearch = () => {
    router.push(`/?tab=research&q=${encodeURIComponent(claim)}`);
  };

  // Show loading while auth resolves
  if (!authReady || authLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
          <p className="mt-4 text-sm text-slate-400">Loading ConvergePanel…</p>
        </div>
      </main>
    );
  }

  // Still show loading briefly if user is null (redirect will fire)
  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
          <p className="mt-4 text-sm text-slate-400">Redirecting to sign in…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4 py-12 text-slate-100">
      <div className="mx-auto w-full max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Verify with ConvergePanel
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {source === "extension"
              ? "Sent from the ConvergePanel browser extension. Choose how to verify this text."
              : "Paste or edit the text below, then choose a verification method."}
          </p>
        </div>

        {/* Claim textarea */}
        <div className="rounded-2xl border border-slate-700/60 bg-slate-800/50 p-5 shadow-lg">
          <label
            htmlFor="verify-text"
            className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400"
          >
            Text to verify
          </label>
          <textarea
            id="verify-text"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            rows={6}
            className="w-full resize-y rounded-xl border border-slate-600 bg-slate-900 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40"
            placeholder="Paste a claim, quote, or statement to verify…"
          />
          {claim && (
            <p className="mt-2 text-xs text-slate-500">
              {claim.length} character{claim.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            onClick={handleClaimVerification}
            disabled={!claim.trim()}
            className="flex-1 rounded-xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run Claim Verification
          </button>
          <button
            onClick={handleDeepResearch}
            disabled={!claim.trim()}
            className="flex-1 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run Deep Research
          </button>
          <Link
            href="/"
            className="flex-1 rounded-xl border border-slate-600 bg-slate-800 px-5 py-3 text-center text-sm font-semibold text-slate-200 shadow-sm transition hover:border-slate-500 hover:bg-slate-700"
          >
            Open Main App
          </Link>
        </div>

        {/* Footer note */}
        <p className="mt-8 text-center text-xs text-slate-500">
          ConvergePanel sends your text to multiple AI models for independent verification.
          Results include consensus scoring and governance signals.
        </p>
      </div>
    </main>
  );
}
