/**
 * Public pricing page: plan cards and upgrade CTAs.
 */

import Link from "next/link";
import PricingSection from "@/components/PricingSection";

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 pb-4 pt-12 text-center">
        <h1 className="text-3xl font-bold text-slate-900 sm:text-4xl">Pricing</h1>
        <p className="mx-auto mt-3 max-w-2xl text-slate-600">
          Start free. The 5-Model plan includes governance: dashboards, peer review, and a full audit log
          of review decisions — plus all five models and higher monthly limits.
        </p>
        <p className="mt-4 text-sm text-slate-500">
          <Link href="/signup" className="font-medium text-sky-600 hover:text-sky-700">
            Create a free account
          </Link>{" "}
          — no credit card required.
        </p>
      </div>
      <PricingSection />
    </main>
  );
}
