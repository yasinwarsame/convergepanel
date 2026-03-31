/**
 * Pricing Section Component
 * 
 * Displays the three subscription plans with features and CTAs.
 * Supports monthly/annual toggle for paid plans.
 * Used on the landing page for marketing.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { PLAN_CONFIGS, PlanId, BillingInterval } from "@/lib/plans";
import { useAuth } from "@/components/AuthProvider";

export default function PricingSection() {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");

  return (
    <section className="max-w-7xl mx-auto px-4 py-16 sm:py-24">
      {/* Section Header */}
      <div className="text-center mb-12">
        <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4">
          Plans and limits
        </h2>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          Start free with two models per run. The 5-Model plan adds structured review: policy thresholds,
          optional peer review, a review queue, and an audit log of decisions.
        </p>
      </div>

      {/* Monthly/Annual Toggle (only for paid plans) */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex rounded-lg bg-slate-100 p-1">
          <button
            onClick={() => setBillingInterval("month")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              billingInterval === "month"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setBillingInterval("year")}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              billingInterval === "year"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Annual
            <span className="ml-1 text-xs text-sky-600">(Save 20%)</span>
          </button>
        </div>
      </div>

      {/* Pricing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12">
        {/* Free Plan */}
        <PricingCard planId="free" billingInterval={billingInterval} />

        {/* Research Lite Plan */}
        <PricingCard planId="lite" billingInterval={billingInterval} />

        {/* Full Panel Plan */}
        <PricingCard planId="full" billingInterval={billingInterval} />
      </div>

      <div className="mx-auto mt-14 max-w-4xl overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[320px] text-left text-sm text-slate-700">
          <caption className="sr-only">Plan comparison including video verification</caption>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="px-4 py-3 font-semibold text-slate-900">Feature</th>
              <th className="px-4 py-3 font-semibold text-slate-900">Free</th>
              <th className="px-4 py-3 font-semibold text-slate-900">3-Model</th>
              <th className="px-4 py-3 font-semibold text-slate-900">5-Model</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100">
              <td className="px-4 py-3">Video verifications / month</td>
              <td className="px-4 py-3 text-slate-500">—</td>
              <td className="px-4 py-3">5</td>
              <td className="px-4 py-3">20</td>
            </tr>
            <tr className="border-b border-slate-100">
              <td className="px-4 py-3">Vision models per video</td>
              <td className="px-4 py-3 text-slate-500">—</td>
              <td className="px-4 py-3">3</td>
              <td className="px-4 py-3">3</td>
            </tr>
            <tr>
              <td className="px-4 py-3">Video governance review</td>
              <td className="px-4 py-3 text-slate-500">—</td>
              <td className="px-4 py-3 text-slate-500">—</td>
              <td className="px-4 py-3">✓</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-amber-800/90">
        ⚠️ Video verification is an AI-assisted authenticity review — not forensic analysis.
      </p>
    </section>
  );
}

interface PricingCardProps {
  planId: PlanId;
  billingInterval: BillingInterval;
}

function PricingCard({ planId, billingInterval }: PricingCardProps) {
  const config = PLAN_CONFIGS[planId];
  const isHighlighted = config.highlight;
  const isFree = planId === "free";
  const { user } = useAuth();

  // Calculate displayed price based on interval
  const displayPrice = isFree
    ? 0
    : billingInterval === "month"
    ? config.monthlyPriceUsd
    : config.yearlyPriceUsd || 0;

  const displayPricePerMonth = isFree
    ? null
    : billingInterval === "year" && config.yearlyPriceUsd
    ? config.yearlyPriceUsd / 12
    : config.monthlyPriceUsd;

  // For paid plans: if user is not signed in, redirect to signup page
  // Otherwise, redirect to billing page with plan parameters
  const getPaidPlanHref = () => {
    if (!user) {
      return "/signup";
    }
    return `/billing?plan=${planId}&interval=${billingInterval}`;
  };

  return (
    <div
      className={`relative rounded-2xl p-8 ${
        isHighlighted
          ? "bg-sky-50 ring-2 ring-sky-200 shadow-lg scale-105"
          : "bg-white ring-1 ring-slate-200 shadow-sm"
      }`}
    >
      {/* Badge */}
      {config.badge && (
        <div className="absolute -top-4 left-1/2 transform -translate-x-1/2">
          <span className="inline-flex items-center rounded-full bg-sky-600 px-4 py-1 text-xs font-semibold text-white">
            {config.badge}
          </span>
        </div>
      )}

      {/* Plan Name */}
      <h3 className="text-2xl font-bold text-slate-900 mb-2">{config.name}</h3>

      {/* Price */}
      <div className="mb-4">
        {isFree ? (
          <span className="text-4xl font-bold text-slate-900">Free</span>
        ) : (
          <>
            <span className="text-4xl font-bold text-slate-900">${displayPrice.toFixed(2)}</span>
            <span className="text-lg text-slate-600">
              {" "}
              / {billingInterval === "month" ? "month" : "year"}
            </span>
            {billingInterval === "year" && displayPricePerMonth && (
              <p className="text-sm text-slate-500 mt-1">
                ${displayPricePerMonth.toFixed(2)} / month
              </p>
            )}
          </>
        )}
      </div>

      {/* Tagline */}
      <p className="text-sm text-slate-600 mb-6">{config.tagline}</p>

      {/* Features List */}
      <ul className="space-y-3 mb-8">
        {config.features.map((feature, index) => (
          <li key={index} className="flex items-start">
            <svg
              className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span className="text-sm text-slate-700">{feature}</span>
          </li>
        ))}
        {planId === "free" && (
          <li className="flex items-start">
            <span
              className="mr-2 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-sm font-bold text-slate-400"
              aria-hidden
            >
              ✗
            </span>
            <span className="text-sm text-slate-500">Video verification (paid plans only)</span>
          </li>
        )}
        {planId === "lite" && (
          <>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">5 video verifications per month</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">3 AI vision models review each video</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">Metadata review and AI-creation tool markers</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">
                Per-model evidence with manipulation and authenticity signals
              </span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">Governance status badges on your results</span>
            </li>
            <li className="flex items-start">
              <span
                className="mr-2 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-sm font-bold text-slate-400"
                aria-hidden
              >
                ✗
              </span>
              <span className="text-sm text-slate-500">
                Governance Dashboard <span className="text-slate-400">(5-Model plan)</span>
              </span>
            </li>
            <li className="flex items-start">
              <span
                className="mr-2 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-sm font-bold text-slate-400"
                aria-hidden
              >
                ✗
              </span>
              <span className="text-sm text-slate-500">
                Peer review <span className="text-slate-400">(5-Model plan)</span>
              </span>
            </li>
          </>
        )}
        {planId === "full" && (
          <>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">20 video verifications per month</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">3 AI vision models review each video</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">Metadata review and AI-creation tool markers</span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">
                Per-model evidence with manipulation and authenticity signals
              </span>
            </li>
            <li className="flex items-start">
              <svg
                className="h-5 w-5 text-sky-500 mr-2 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span className="text-sm text-slate-700">
                Video results in governance review and audit trail (5-Model plan)
              </span>
            </li>
          </>
        )}
        {planId === "free" && (
          <li className="flex items-start">
            <span
              className="mr-2 mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-sm font-bold text-slate-400"
              aria-hidden
            >
              ✗
            </span>
            <span className="text-sm text-slate-500">Governance features (upgrade to access)</span>
          </li>
        )}
      </ul>

      {/* Positioning Text (if present) */}
      {config.positioningText && (
        <p className="text-xs text-slate-500 italic mb-6">{config.positioningText}</p>
      )}

      {/* CTA Button */}
      {isFree ? (
        <Link
          href="/signup"
          className={`block w-full text-center rounded-xl px-6 py-3 text-base font-semibold transition-colors ${
            isHighlighted
              ? "bg-sky-600 text-white hover:bg-sky-700"
              : "bg-slate-900 text-white hover:bg-slate-800"
          }`}
        >
          Start for free
        </Link>
      ) : (
        <Link
          href={getPaidPlanHref()}
          className={`block w-full text-center rounded-xl px-6 py-3 text-base font-semibold transition-colors ${
            isHighlighted
              ? "bg-sky-600 text-white hover:bg-sky-700"
              : "bg-slate-900 text-white hover:bg-slate-800"
          }`}
        >
          {planId === "full" ? "Get Full Panel" : "Get Research Lite"}
        </Link>
      )}
    </div>
  );
}

