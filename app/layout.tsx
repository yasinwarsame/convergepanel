/**
 * Root layout: global HTML shell, fonts, providers, and metadata.
 */

import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";
import Link from "next/link";
import { DM_Serif_Display, Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import TopNav from "@/components/TopNav";
import { AuthProvider } from "@/components/AuthProvider";
import { ErrorBoundaryWrapper } from "@/components/ErrorBoundaryWrapper";
import { ServiceWorkerUnregister } from "@/components/ServiceWorkerUnregister";
import { PostHogProvider } from "@/components/PostHogProvider";

const dmSerif = DM_Serif_Display({
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-dm-serif",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

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
      <body className={`${dmSerif.variable} ${outfit.variable} ${jetbrainsMono.variable} antialiased bg-cp-bg font-sans`}>
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
            {/* Footer */}
            <footer className="mt-10 border-t border-cp-border bg-cp-surface">
              <div className="mx-auto max-w-5xl px-6 py-8">
                <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
                  {/* Brand + disclaimer */}
                  <div className="max-w-sm">
                    <span className="font-serif text-base font-normal tracking-tight">
                      <span className="text-cp-text">Converge</span>
                      <span className="text-cp-accent">Panel</span>
                    </span>
                    <p className="mt-2 text-[11px] leading-relaxed text-cp-faint">
                      AI-assisted verification for informational purposes only.
                      Not forensic analysis. Not legal evidence.{" "}
                      <Link href="/terms" className="text-cp-muted hover:text-cp-text transition-colors underline underline-offset-2">
                        Terms
                      </Link>{" "}
                      ·{" "}
                      <Link href="/privacy" className="text-cp-muted hover:text-cp-text transition-colors underline underline-offset-2">
                        Privacy
                      </Link>
                    </p>
                    <p className="mt-3 text-[11px] text-cp-faint">
                      © {new Date().getFullYear()} ConvergePanel
                    </p>
                  </div>
                  {/* Nav links */}
                  <nav className="flex flex-wrap items-start gap-x-6 gap-y-2 text-xs text-cp-muted" aria-label="Footer">
                    {[
                      { label: "About", href: "/about" },
                      { label: "Help", href: "/help" },
                      { label: "Pricing", href: "/pricing" },
                      { label: "Contact", href: "/contact" },
                      { label: "Use cases", href: "/use-cases" },
                      { label: "Login", href: "/login" },
                      { label: "Sign up", href: "/signup" },
                    ].map(({ label, href }) => (
                      <Link key={href} href={href} className="hover:text-cp-accent transition-colors">
                        {label}
                      </Link>
                    ))}
                    <a
                      href="mailto:support@convergepanel.com?subject=Feedback"
                      className="hover:text-cp-accent transition-colors"
                    >
                      Feedback
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
