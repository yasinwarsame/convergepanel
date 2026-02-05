"use client";

/**
 * Global Error Component
 * 
 * Next.js App Router requires this file to handle errors in the root layout.
 * This component catches errors that occur in the root layout.tsx file itself.
 * 
 * IMPORTANT: This must be a client component and must include <html> and <body> tags
 * because it replaces the entire root layout when an error occurs.
 */

import { useEffect } from "react";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // Log error to console for debugging
    console.error("[app/global-error.tsx] Global error caught:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased bg-slate-50">
        <div className="flex min-h-screen flex-col items-center justify-center text-center space-y-4 px-4">
          <h2 className="text-2xl font-semibold text-slate-900">
            Something went wrong!
          </h2>
          <p className="text-sm text-slate-600 max-w-md">
            A critical error occurred while loading the application. Please refresh the page.
          </p>
          <button
            onClick={reset}
            className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Try again
          </button>
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
      </body>
    </html>
  );
}

