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

