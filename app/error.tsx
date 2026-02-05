"use client";

/**
 * Error Component
 * 
 * Next.js App Router requires this file to handle errors in the app directory.
 * This component catches errors that occur during rendering, in lifecycle methods,
 * and in constructors of the entire tree below it.
 * 
 * This is a client component that must be named "error.tsx" and export a default
 * function that accepts error and reset props.
 */

import { useEffect } from "react";
import Link from "next/link";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log error to console for debugging
    console.error("[app/error.tsx] Error caught:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center space-y-4 px-4">
      <h2 className="text-2xl font-semibold text-slate-900">
        Something went wrong!
      </h2>
      <p className="text-sm text-slate-600 max-w-md">
        An unexpected error occurred. Please try again or return to the home page.
      </p>
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          Go home
        </Link>
      </div>
      {process.env.NODE_ENV === "development" && error.message && (
        <details className="mt-4 text-xs text-slate-500 max-w-2xl">
          <summary className="cursor-pointer hover:text-slate-700">
            Error details (development only)
          </summary>
          <pre className="mt-2 text-left bg-slate-100 p-3 rounded overflow-auto">
            {error.message}
            {error.stack && (
              <div className="mt-2 text-slate-400">
                {error.stack}
              </div>
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

