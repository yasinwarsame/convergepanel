/**
 * Landing Page Component
 * 
 * This is the pre-login marketing overview page shown to logged-out users.
 * It explains how ConvergePanel works and encourages signup/login.
 * 
 * When a user is authenticated, they should be redirected to the main panel interface.
 */

import Link from "next/link";
import Image from "next/image";
import PricingSection from "./PricingSection";

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-4 py-16 sm:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          {/* Text Content */}
          <div className="text-center lg:text-left space-y-6">
            {/* Tag */}
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-sm text-sky-600">
              <span className="h-2 w-2 rounded-full bg-sky-400"></span>
              Multi-LLM Expert Panel • Trust your answers
            </div>
            
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-slate-900">
              Know when to trust AI,{" "}
              <span className="text-sky-600">not just what it says.</span>
            </h1>
            
            {/* Hero description: same Deep Research / multi-LLM expert panel story
                as the signup page, for consistent messaging. */}
            <p className="text-lg sm:text-xl text-slate-600">
              ConvergePanel is a{" "}
              <span className="font-semibold text-sky-600">deep-research</span>, multi-LLM expert panel. Every question is treated like a research brief, not a quick chat reply.
            </p>

            {/* Feature list */}
            <ul className="space-y-3 text-left text-slate-700">
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Treats every query as a <strong className="text-slate-900">deep research</strong> brief.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Synthesizes a unified answer across top AI models.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Maps where the models strongly agree vs. diverge.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Surfaces possible <strong className="text-slate-900">biases and blind spots</strong> in each answer.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Builds a trust summary so you see consensus, uncertainty, and risk.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Includes a <strong className="text-slate-900">Verification Gate</strong> — an instant decision-readiness signal for every synthesis.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Tags claims as <strong className="text-slate-900">low stakes, important, or decision-critical</strong> so you focus review where it matters.</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-sky-600 mt-1">•</span>
                <span>Flags whether conclusions appear <strong className="text-slate-900">source-backed, model-reasoned, or mixed</strong>.</span>
              </li>
            </ul>

            <p className="text-base text-slate-600 pt-2">
              Built for researchers, founders, analysts, and anyone who needs the deepest possible answer—not just a single AI opinion.
            </p>

            <div className="flex flex-col sm:flex-row items-center lg:items-start gap-4 pt-4">
              <Link
                href="/signup"
                className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-8 py-3 text-base font-semibold text-white shadow-sm hover:bg-sky-700 transition-colors w-full sm:w-auto"
              >
                Sign up free
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-8 py-3 text-base font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-colors w-full sm:w-auto"
              >
                Log in
              </Link>
            </div>

            <p className="text-sm text-slate-500 pt-2">
              No credit card required · 8 free Deep Research panel runs per month
            </p>
          </div>

          {/* Research Image */}
          <div className="relative w-full aspect-[4/3] rounded-2xl overflow-hidden shadow-xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
            <Image
              src="/research-hero.png"
              alt="Deep research and AI analysis workspace with data visualizations and neural network graphics"
              fill
              className="object-cover"
              priority
              sizes="(max-width: 768px) 100vw, 50vw"
              // Fallback if image doesn't exist yet
              onError={(e) => {
                // Hide image container if image fails to load
                (e.target as HTMLElement).parentElement?.parentElement?.classList.add('hidden');
              }}
            />
            {/* Overlay gradient for better text contrast if needed */}
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/50 via-transparent to-transparent pointer-events-none" />
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="max-w-4xl mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-12">
          How it works
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-sky-100 text-sky-600 font-bold text-xl mb-4">
              1
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Ask one research question
            </h3>
            <p className="text-slate-600">
              Type your question once—no more hopping between AI tabs.
            </p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-sky-100 text-sky-600 font-bold text-xl mb-4">
              2
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              Run your expert panel
            </h3>
            <p className="text-slate-600">
              ConvergePanel sends it to multiple models in parallel and standardizes their answers.
            </p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-sky-100 text-sky-600 font-bold text-xl mb-4">
              3
            </div>
            <h3 className="text-xl font-semibold text-slate-900 mb-2">
              See consensus and disagreement
            </h3>
            <p className="text-slate-600">
              Get a unified answer, a trust summary, and an agreement map that shows who agrees with what.
            </p>
          </div>
        </div>
      </section>

      {/* Verification Gate Section */}
      <section className="max-w-4xl mx-auto px-4 py-16">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-600 mb-4 shadow-sm">
            New feature
          </div>
          <h2 className="text-3xl font-bold text-slate-900 mb-3">
            Verification Gate
          </h2>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            Every synthesis now comes with a decision-readiness signal. Know at a
            glance whether the models broadly agree, where they diverge, and what
            needs a closer look before you act.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-semibold text-emerald-900">Broadly consistent</span>
            </div>
            <p className="text-sm text-emerald-800">
              Models show broad agreement with supporting evidence. Suitable for
              exploratory use — cross-check key claims before formal decisions.
            </p>
          </div>

          <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="font-semibold text-amber-900">Needs human review</span>
            </div>
            <p className="text-sm text-amber-800">
              Disagreements, contested claims, or bias signals detected. Review
              the flagged areas and verify disputed premises independently.
            </p>
          </div>

          <div className="rounded-xl border-2 border-red-200 bg-red-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              <span className="font-semibold text-red-900">Low confidence</span>
            </div>
            <p className="text-sm text-red-800">
              Missing sources and low model confidence. Treat as hypothesis only
              — request sources and verify before acting.
            </p>
          </div>
        </div>

        <div className="mt-8 text-center space-y-3">
          <p className="text-slate-600">
            The gate tells you <strong className="text-slate-900">why</strong> it
            reached its assessment and gives you <strong className="text-slate-900">recommended next steps</strong> tailored
            to the specific issues detected — no guesswork.
          </p>
          <p className="text-xs text-slate-400">
            Verification Gate is an advisory signal derived from model comparison. It is not a guarantee of
            correctness and is not a substitute for independent professional review.
          </p>
        </div>
      </section>

      {/* Claim Severity, Source Grounding & Panel Verdict */}
      <section className="max-w-4xl mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-4">
          More than consensus — actionable clarity
        </h2>
        <p className="text-lg text-slate-600 text-center max-w-2xl mx-auto mb-10">
          Every synthesis comes with built-in signals that help you decide what
          to trust, what to verify, and what to share.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Claim Severity */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>
                Decision-critical
              </span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Claim Severity Tags
            </h3>
            <p className="text-sm text-slate-600">
              Shows which claims are low stakes, important, or decision-critical
              so not every sentence gets treated with the same weight.
            </p>
          </div>

          {/* Source Grounding */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-700">
                Source-backed
              </span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Source-Grounding Flags
            </h3>
            <p className="text-sm text-slate-600">
              Indicates whether a claim appears source-backed, model-reasoned,
              or mixed/unclear — so you know how much to verify.
            </p>
          </div>

          {/* Panel Verdict */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                Shareable
              </span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Panel Verdict Card
            </h3>
            <p className="text-sm text-slate-600">
              A compact decision artifact with the question, top consensus, top
              disagreement, blind spot, grounding signal, and gate result — ready
              to copy and share.
            </p>
          </div>
        </div>
      </section>

      {/* Who It's For Section */}
      <section className="max-w-3xl mx-auto px-4 py-16">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-8">
          Who it's for
        </h2>
        
        <div className="bg-white rounded-xl border border-slate-200 p-8 shadow-sm">
          <ul className="space-y-4 text-slate-700">
            <li className="flex items-start gap-3">
              <span className="text-sky-600 mt-1">✓</span>
              <span><strong className="text-slate-900">Founders & entrepreneurs</strong> making strategic decisions and need multiple perspectives</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-sky-600 mt-1">✓</span>
              <span><strong className="text-slate-900">Analysts & researchers</strong> who need to verify claims and identify consensus</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-sky-600 mt-1">✓</span>
              <span><strong className="text-slate-900">Students & academics</strong> conducting research and writing papers</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-sky-600 mt-1">✓</span>
              <span><strong className="text-slate-900">Professionals</strong> who need trustworthy answers for important decisions</span>
            </li>
          </ul>
        </div>
      </section>

      {/* Pricing Section */}
      <PricingSection />
    </main>
  );
}

