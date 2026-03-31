/**
 * Root layout: global HTML shell, fonts, providers, and metadata.
 */

import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import TopNav from "@/components/TopNav";
import { AuthProvider } from "@/components/AuthProvider";
import { ErrorBoundaryWrapper } from "@/components/ErrorBoundaryWrapper";
import { ServiceWorkerUnregister } from "@/components/ServiceWorkerUnregister";

export const metadata: Metadata = {
  title: "ConvergePanel — Multi-model research & claim verification",
  description:
    "Multi-model AI research, claim verification, video authenticity analysis (paid plans), and governance scoring — with audit trails.",
  icons: {
    icon: [{ url: "/convergepanel-logo.png", type: "image/png" }],
    shortcut: "/convergepanel-logo.png",
    apple: "/convergepanel-logo.png",
  },
};

/**
 * Root Layout
 * 
 * PERFORMANCE: The shell (TopNav + children) renders immediately.
 * AuthProvider is optimized to not block rendering - it sets loading=false
 * after a short timeout to unblock the UI.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-slate-50">
        <ServiceWorkerUnregister />
        <ErrorBoundaryWrapper>
          <AuthProvider>
            {/* Shell renders immediately - header is visible right away */}
            <TopNav />
            {/* Children (page content) render in parallel */}
            {children}
            {/* Footer renders with shell */}
            <footer className="mt-10 border-t border-slate-200 bg-white">
              <div className="mx-auto max-w-4xl px-4 py-4 text-xs text-slate-500">
                <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-slate-400">
                  ConvergePanel provides AI-assisted verification for informational purposes only. Not forensic
                  analysis. Not legal evidence.{" "}
                  <Link href="/terms" className="text-slate-600 underline-offset-2 hover:text-slate-800 hover:underline">
                    Terms
                  </Link>{" "}
                  ·{" "}
                  <Link
                    href="/privacy"
                    className="text-slate-600 underline-offset-2 hover:text-slate-800 hover:underline"
                  >
                    Privacy
                  </Link>
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <span>© {new Date().getFullYear()} ConvergePanel</span>
                  <nav className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="Footer">
                    <Link href="/about" className="hover:text-slate-700 transition-colors">
                      About
                    </Link>
                    <Link href="/help" className="hover:text-slate-700 transition-colors">
                      Help
                    </Link>
                    <Link href="/pricing" className="hover:text-slate-700 transition-colors">
                      Pricing
                    </Link>
                    <Link href="/contact" className="hover:text-slate-700 transition-colors">
                      Contact
                    </Link>
                    <Link href="/login" className="hover:text-slate-700 transition-colors">
                      Login
                    </Link>
                    <Link href="/signup" className="hover:text-slate-700 transition-colors">
                      Sign up
                    </Link>
                    <Link href="/terms" className="hover:text-slate-700 transition-colors" title="Includes disclaimers on AI outputs">
                      Terms
                    </Link>
                    <Link href="/privacy" className="hover:text-slate-700 transition-colors">
                      Privacy
                    </Link>
                    <a
                      href="mailto:support@convergepanel.com?subject=Feedback"
                      className="underline hover:text-slate-700 transition-colors"
                    >
                      Send feedback
                    </a>
                  </nav>
                </div>
              </div>
            </footer>
          </AuthProvider>
        </ErrorBoundaryWrapper>
      </body>
    </html>
  );
}
