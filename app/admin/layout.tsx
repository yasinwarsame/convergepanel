"use client";

/**
 * Admin section layout: client-side gate (Firebase custom claims) before rendering
 * dashboard children; complements server-side checks in /api/admin/* routes.
 */

import { useAuth } from "@/components/AuthProvider";
import { useAdminPortalAccess } from "@/hooks/useAdminPortalAccess";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect } from "react";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { loading } = useAuth();
  const { canAccess, isSystemAdmin, gateReady, user } = useAdminPortalAccess();
  const router = useRouter();

  useEffect(() => {
    if (loading || !gateReady) {
      return;
    }

    console.log("[admin] Auth state:", {
      hasUser: !!user,
      canAccess,
      userEmail: user?.email,
    });

    if (!user) {
      router.push("/login?next=/admin");
      return;
    }

    if (!canAccess) {
      router.push("/");
      return;
    }
  }, [user, loading, gateReady, canAccess, router]);

  if (loading || !gateReady) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm tracking-wide">Checking admin access…</p>
        </div>
      </div>
    );
  }

  if (!user || !canAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 text-gray-600">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm tracking-wide">Redirecting…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="flex">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 min-h-screen">
          <div className="p-6">
            <h2 className="text-xl font-bold text-gray-900 mb-6">Admin</h2>
            <nav className="space-y-2">
              <Link
                href="/admin"
                className="block px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Overview
              </Link>
              {/*
                Phase FIRST-ADMIN-C3: both destinations gate on the `admin`
                custom claim and render nothing without it, so an
                ADMIN_PORTAL-only administrator following these links got a
                sidebar and a silently blank pane — no message, no redirect.
                The pages remain the authoritative gate; these links simply stop
                advertising destinations the caller cannot use.
              */}
              {isSystemAdmin && (
                <>
                  <Link
                    href="/admin/keys"
                    className="block px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    API Keys
                  </Link>
                  <Link
                    href="/admin/users"
                    className="block px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    Users
                  </Link>
                </>
              )}
            </nav>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-8">
          {/* Back to Dashboard Button */}
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 font-medium hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:rounded mb-6 transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            <span>Back to Dashboard</span>
          </Link>
          {children}
        </main>
      </div>
    </div>
  );
}

