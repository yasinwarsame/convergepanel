"use client";

/**
 * ErrorBoundaryWrapper Component
 * 
 * Wrapper component that allows the client-side RootErrorBoundary
 * to be used in the server component layout.
 * 
 * This is necessary because Next.js App Router layouts are server components,
 * but error boundaries must be client components.
 */

import { RootErrorBoundary } from "./RootErrorBoundary";

export function ErrorBoundaryWrapper({ children }: { children: React.ReactNode }) {
  return <RootErrorBoundary>{children}</RootErrorBoundary>;
}

