"use client";

/**
 * RootErrorBoundary Component
 * 
 * React Error Boundary that catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing the entire app.
 * 
 * This prevents the app from showing a blank screen when an unexpected error occurs.
 * Errors are logged to the console for debugging.
 * 
 * Usage: Wrap the main app content in app/layout.tsx with this boundary.
 */

import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  /**
   * Update state so the next render will show the fallback UI
   * This is called when an error is thrown in any child component
   */
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  /**
   * Log error details to console for debugging
   * This is called after an error is caught
   */
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[RootErrorBoundary] Caught error:", error);
    console.error("[RootErrorBoundary] Error info:", errorInfo);
    console.error("[RootErrorBoundary] Error stack:", error.stack);
  }

  /**
   * Render fallback UI when an error is caught
   * Otherwise, render children normally
   */
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center text-center space-y-3 px-4">
          <p className="text-base font-semibold text-slate-100">
            Something went wrong loading ConvergePanel.
          </p>
          <p className="text-sm text-slate-400 max-w-md">
            Please refresh the page. If the problem persists, check the console or contact support.
          </p>
          {this.state.error && (
            <details className="mt-4 text-xs text-slate-500 max-w-2xl">
              <summary className="cursor-pointer hover:text-slate-400">
                Technical details (click to expand)
              </summary>
              <pre className="mt-2 text-left bg-slate-800 p-3 rounded overflow-auto">
                {this.state.error.toString()}
                {this.state.error.stack && (
                  <div className="mt-2 text-slate-400">
                    {this.state.error.stack}
                  </div>
                )}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

