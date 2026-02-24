import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import TopNav from "@/components/TopNav";
import { AuthProvider } from "@/components/AuthProvider";
import { ErrorBoundaryWrapper } from "@/components/ErrorBoundaryWrapper";
import { ServiceWorkerUnregister } from "@/components/ServiceWorkerUnregister";

export const metadata: Metadata = {
  title: "ConvergePanel - Multi-LLM Expert Panel",
  description: "Send one question to multiple AI models and get a unified answer",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  other: {
    "api-health": "/api/health",
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
              <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3 text-xs text-slate-500">
                <span>© {new Date().getFullYear()} ConvergePanel.</span>
                <div className="flex items-center gap-3">
                  <Link href="/terms" className="hover:text-slate-700 transition-colors">
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
                </div>
              </div>
            </footer>
          </AuthProvider>
        </ErrorBoundaryWrapper>
      </body>
    </html>
  );
}
