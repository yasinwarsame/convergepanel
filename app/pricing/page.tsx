/**
 * Public pricing page: plan cards and upgrade CTAs.
 */

import type { Metadata } from "next";
import Link from "next/link";
import PricingSection from "@/components/PricingSection";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Plans for multi-model research, claim verification, video verification (paid), governance on the 5-Model plan, and audit trails.",
  alternates: { canonical: "/pricing" },
  openGraph: { url: "https://convergepanel.com/pricing", title: "Pricing | ConvergePanel" },
};

export default function PricingPage() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-4xl px-4 pb-4 pt-12 text-center">
        <h1 className="text-3xl font-bold text-cp-text sm:text-4xl">Pricing</h1>
        <p className="mx-auto mt-3 max-w-2xl text-cp-muted">
          Start free. Paid plans add video verification (separate monthly allowance; each video also uses one
          panel run). The 5-Model plan includes governance: dashboards, peer review, and a full audit log of
          review decisions — plus all five models and higher monthly limits.
        </p>
        <p className="mt-4 text-sm text-cp-muted">
          <Link href="/signup" className="font-medium text-sky-600 hover:text-sky-700">
            Create a free account
          </Link>{" "}
          — no credit card required.
        </p>
      </div>
      <PricingSection />
      <div className="mx-auto max-w-2xl px-4 pb-12 text-center text-xs text-cp-muted">
        <p className="leading-relaxed">
          All verification features use third-party AI models and are provided for informational and
          decision-support purposes only. Results do not constitute forensic analysis, expert opinion, or legal
          evidence. See our{" "}
          <Link href="/terms" className="font-medium text-sky-600 hover:text-sky-700 hover:underline">
            Terms of Service
          </Link>{" "}
          for the full disclaimer and limitation of liability.
        </p>
      </div>
    </main>
  );
}
