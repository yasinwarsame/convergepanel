/**
 * Root layout: global HTML shell, fonts, providers, and metadata.
 */

import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import TopNav from "@/components/TopNav";
import { AuthProvider } from "@/components/AuthProvider";
import { ErrorBoundaryWrapper } from "@/components/ErrorBoundaryWrapper";
import { ServiceWorkerUnregister } from "@/components/ServiceWorkerUnregister";
import { PostHogProvider } from "@/components/PostHogProvider";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL("https://convergepanel.com"),
    title: {
      default: "ConvergePanel — Multi-model research & claim verification",
      template: "%s | ConvergePanel",
    },
    description:
      "Multi-model AI research, claim verification, video authenticity analysis (paid plans), and governance scoring — with audit trails.",
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      siteName: "ConvergePanel",
      url: "https://convergepanel.com",
      title: "ConvergePanel — Multi-model research & claim verification",
      description:
        "Don't trust one AI. Verify with five. Multi-model research, claim verification, video authenticity, and governance — with audit trails.",
      images: [{ url: "/claim-verification.png", width: 2004, height: 1842, alt: "ConvergePanel" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ConvergePanel — Multi-model research & claim verification",
      description:
        "Don't trust one AI. Verify with five. Multi-model research, claim verification, and video authenticity with audit trails.",
      images: ["/claim-verification.png"],
    },
    icons: {
      icon: [
        { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      ],
      shortcut: "/favicon-32x32.png",
      apple: "/apple-touch-icon.png",
    },
    other: {
      ...Sentry.getTraceData(),
    },
  };
}

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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  name: "ConvergePanel",
                  url: "https://convergepanel.com",
                  logo: { "@type": "ImageObject", url: "https://convergepanel.com/convergepanel-logo.png" },
                },
                {
                  "@type": "WebSite",
                  name: "ConvergePanel",
                  url: "https://convergepanel.com",
                },
              ],
            }).replace(/</g, "\\u003c"),
          }}
        />
        <ServiceWorkerUnregister />
        <PostHogProvider>
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
        </PostHogProvider>
      </body>
    </html>
  );
}
