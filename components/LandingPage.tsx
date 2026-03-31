/**
 * Landing Page Component
 *
 * Pre-login marketing: research panel, claim verification, consensus scoring, audit trails.
 */

import Link from "next/link";
import Image from "next/image";
import { Film } from "lucide-react";

function ResearchMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left shadow-inner">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Synthesis</p>
      <p className="mt-2 text-xs font-medium text-slate-200">Consensus &amp; disagreements</p>
      <div className="mt-2 space-y-1.5">
        <div className="h-2 w-full rounded bg-emerald-900/60" />
        <div className="h-2 w-4/5 rounded bg-slate-700" />
        <div className="h-2 w-full rounded bg-amber-900/50" />
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Bias signals · Blind spots · Open questions</p>
    </div>
  );
}

function VideoVerificationMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left shadow-inner">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        <Film className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        Video · frames · metadata
      </div>
      <div className="mt-2 rounded-md bg-slate-800/90 px-2 py-1.5 text-[10px] font-medium text-slate-200">
        Verdict · Inconclusive
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-[9px] text-slate-400">
        <div className="rounded border border-slate-700 bg-slate-950/80 p-1.5 text-center">Model A</div>
        <div className="rounded border border-slate-700 bg-slate-950/80 p-1.5 text-center">Model B</div>
        <div className="rounded border border-slate-700 bg-slate-950/80 p-1.5 text-center">Model C</div>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Per-model signals · Paid plans</p>
    </div>
  );
}

function ClaimVerificationMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left shadow-inner">
      <div className="rounded-md bg-slate-800/90 px-2 py-1.5 text-[10px] font-medium text-slate-200">
        Aggregate verdict · Unverifiable
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded border border-slate-700 bg-slate-950/80 p-2">
          <p className="text-slate-500">Score</p>
          <p className="text-lg font-bold text-white">37</p>
        </div>
        <div className="rounded border border-slate-700 bg-slate-950/80 p-2">
          <p className="text-slate-500">Confidence</p>
          <p className="font-semibold text-sky-300">Low</p>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Per-model evidence · Audit trail</p>
    </div>
  );
}

function ConsensusMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-4 text-left shadow-inner">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Consensus</p>
      <p className="mt-1 text-2xl font-bold text-white">72</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-300">
        <div>
          <span className="text-slate-500">Confidence</span>
          <p className="font-medium text-sky-300">Medium</p>
        </div>
        <div>
          <span className="text-slate-500">Evidence</span>
          <p className="font-medium capitalize">mixed</p>
        </div>
        <div className="col-span-2">
          <span className="text-slate-500">Support ratio</span>
          <p className="font-medium">62%</p>
        </div>
      </div>
    </div>
  );
}

function AuditMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left font-mono text-[9px] text-slate-400 shadow-inner">
      <p className="text-slate-500">audit.json</p>
      <p className="mt-1 text-emerald-600/90">✓ models consulted</p>
      <p className="text-slate-500">✓ scores · verdict</p>
      <p className="mt-2 text-[8px] text-slate-600">Export / copy for records</p>
    </div>
  );
}

function GovernanceDashboardMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left shadow-inner">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Governance</p>
      <p className="mt-2 text-xs font-medium text-slate-200">Policy · thresholds</p>
      <div className="mt-2 space-y-1 rounded border border-slate-700 bg-slate-950/60 p-2 text-[10px] text-slate-400">
        <p className="text-amber-400/90">Needs review · 3 items</p>
        <p className="text-slate-500">Approve · block · request changes</p>
      </div>
    </div>
  );
}

function PeerReviewMockup() {
  return (
    <div className="rounded-lg border border-slate-600 bg-slate-900/90 p-3 text-left shadow-inner">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Peer review</p>
      <p className="mt-2 text-xs text-slate-300">Reviewer assigned</p>
      <div className="mt-2 rounded border border-sky-800/60 bg-sky-950/30 px-2 py-1.5 text-[10px] text-sky-200/90">
        Flagged run in their queue — decision logged
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-slate-50">
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
          <div className="space-y-6 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-sm text-sky-700">
              <span className="h-2 w-2 rounded-full bg-sky-500" />
              Research · Claims · Video (paid) · Governance
            </div>

            <h1 className="text-4xl font-bold text-slate-900 sm:text-5xl lg:text-6xl">
              Don&apos;t trust one AI. Verify with five.
            </h1>

            <p className="text-lg text-slate-600 sm:text-xl">
              ConvergePanel runs your research questions and claims through Claude, GPT, Gemini, Grok, and
              Perplexity simultaneously — and shows you where they agree, where they disagree, and what each
              one misses. Paid plans add video verification: three vision-capable models review frames and
              metadata for authenticity signals.
            </p>

            <div className="flex flex-col items-center gap-4 pt-2 sm:flex-row lg:items-start">
              <Link
                href="/signup"
                className="inline-flex w-full items-center justify-center rounded-xl bg-sky-600 px-8 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-sky-700 sm:w-auto"
              >
                Try it free
              </Link>
              <a
                href="#features"
                className="inline-flex w-full items-center justify-center rounded-xl border border-slate-300 bg-white px-8 py-3 text-base font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 sm:w-auto"
              >
                See how it works
              </a>
            </div>

            <p className="text-sm text-slate-500">
              No credit card required · Free plan: 8 runs/month, up to 2 models per run (paid plans: up to 5
              models)
            </p>
          </div>

          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 shadow-xl">
            <Image
              src="/research-hero.png"
              alt=""
              fill
              className="object-cover"
              priority
              sizes="(max-width: 768px) 100vw, 50vw"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-900/50 via-transparent to-transparent" />
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-slate-200 bg-white py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-10 text-center text-3xl font-bold text-slate-900">
            The problem with asking one AI
          </h2>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-slate-900">Confident errors</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Every major AI model delivers wrong answers with the same confidence as right ones. A single
                model can&apos;t tell you when it&apos;s guessing. When five models answer independently,
                disagreements surface the uncertainty a single answer hides.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-slate-900">Sycophancy by design</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Models are tuned to agree with you, not correct you. Ask one if your assumption is right and
                it will often say yes. Ask five: the ones that disagree are often closer to a honest check.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-slate-900">No audit trail</h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                When a decision goes wrong, &quot;ChatGPT told me&quot; is weak evidence. Teams need a record
                of what was checked, how models split, and how confident the synthesis was — before the
                decision, not after.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-16 sm:py-24">
        <h2 className="mb-12 text-center text-3xl font-bold text-slate-900 sm:text-4xl">
          Two modes. One trust layer.
        </h2>

        <div className="space-y-16">
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Multi-model research panel</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Ask a serious research question. Five leading models answer independently. ConvergePanel
                synthesizes the results into a structured brief with consensus findings, disagreements, bias
                signals, and blind spots. You see what no single model would surface alone.
              </p>
            </div>
            <ResearchMockup />
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <ClaimVerificationMockup />
            <div className="lg:order-first">
              <h3 className="text-xl font-semibold text-slate-900">Claim verification</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Paste any claim — from a report, an AI output, a strategy doc, or an article. Five models
                evaluate it independently. You get a clear verdict (confirmed, disputed, partially true, or
                unverifiable), a consensus score, per-model evidence, and a compact audit trail.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <h3 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
                <Film className="h-6 w-6 text-sky-600 shrink-0" aria-hidden />
                Video verification
              </h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Upload a video up to 60 seconds. Three vision-capable AI models independently analyze
                extracted frames and metadata for signs of AI generation or manipulation. You get a clear
                verdict — Authentic, Likely Manipulated, Inconclusive, or Insufficient — with per-model
                evidence showing what each model flagged.
              </p>
              <p className="mt-2 text-xs text-amber-800/90">
                ⚠️ AI-assisted authenticity review — not forensic analysis.
              </p>
            </div>
            <VideoVerificationMockup />
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Consensus scoring</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Every run produces a consensus score from 0–100 that summarizes how defensible the result is
                given model agreement and evidence signals. Pair it with the confidence label and evidence
                quality: strong agreement suggests you can move faster; weak agreement means dig deeper.
              </p>
            </div>
            <ConsensusMockup />
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <AuditMockup />
            <div className="lg:order-first">
              <h3 className="text-xl font-semibold text-slate-900">Audit trail</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Claims (and research runs) produce a compact, exportable audit record: which models
                ran, structured verdict signals, consensus score, and metadata. Built for teams that need to
                show their work — not only explain it after the fact.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Governance Dashboard</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Set consensus thresholds, flag weak evidence automatically, and review flagged runs before
                they&apos;re acted on. The governance dashboard gives you a structured review flow: assign a
                peer reviewer, approve or block claims and research, and keep a complete audit trail of
                every decision.
              </p>
              <p className="mt-2 text-sm font-medium text-sky-700">
                Included on the 5-Model plan.
              </p>
            </div>
            <GovernanceDashboardMockup />
          </div>

          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
            <PeerReviewMockup />
            <div className="lg:order-first">
              <h3 className="text-xl font-semibold text-slate-900">Peer review</h3>
              <p className="mt-3 text-slate-600 leading-relaxed">
                Assign a colleague as your reviewer. When research or claim verification scores below your
                trust threshold, it shows up in their review queue. They can approve, block, or request
                changes — and each decision is logged for compliance.
              </p>
              <p className="mt-2 text-sm font-medium text-sky-700">
                Included on the 5-Model plan.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="border-t border-slate-200 bg-white py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-10 text-center text-3xl font-bold text-slate-900">
            Built for people who can&apos;t afford to be wrong
          </h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">Researchers &amp; analysts</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Cross-check findings across models before publishing. See which claims hold up under
                multi-source scrutiny and which fall apart.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">Product &amp; strategy teams</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Test market claims, competitive takes, and strategic assumptions before big bets. The
                consensus score marks what is defensible on the evidence you have.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">Compliance &amp; risk teams</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Every claim verification and research run is evaluated against governance policies.
                Reviewers approve or block flagged results. The audit log records who reviewed what, when,
                and why — ready for a compliance review.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">AI-powered teams</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                If drafts and analysis come from AI, run the outputs through ConvergePanel before you act.
                Catch mistakes that read as polished and confident.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">Journalists &amp; fact-checkers</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Review video clips before publishing. When citizen journalism or a viral clip lands on your
                desk, run multi-model analysis before you stake your credibility on it.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="font-semibold text-slate-900">PR &amp; communications</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                Review video before you amplify or respond. Understand authenticity signals before a clip
                shapes your strategy.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing CTA */}
      <section className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">Start free. Upgrade when you need more.</h2>
        <p className="mx-auto mt-4 max-w-xl text-slate-600 leading-relaxed">
          The free plan includes 8 runs per month with up to 2 models per run. Paid plans unlock all five
          models, higher monthly limits, and — on the 5-Model plan — governance dashboards, peer review, and
          a full audit log of review decisions.
        </p>
        <ul className="mx-auto mt-6 max-w-lg space-y-2 text-left text-sm text-slate-700">
          <li className="flex gap-2">
            <span className="text-emerald-600 font-medium shrink-0" aria-hidden>
              ✓
            </span>
            <span>Research across 5 AI models</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600 font-medium shrink-0" aria-hidden>
              ✓
            </span>
            <span>Claim verification with consensus scoring</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600 font-medium shrink-0" aria-hidden>
              ✓
            </span>
            <span>Video authenticity analysis (paid plans)</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600 font-medium shrink-0" aria-hidden>
              ✓
            </span>
            <span>Governance dashboard with peer review (5-Model plan)</span>
          </li>
          <li className="flex gap-2">
            <span className="text-emerald-600 font-medium shrink-0" aria-hidden>
              ✓
            </span>
            <span>Full audit trail on every decision</span>
          </li>
        </ul>
        <Link
          href="/pricing"
          className="mt-8 inline-flex items-center justify-center rounded-xl bg-sky-600 px-8 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-sky-700"
        >
          View pricing
        </Link>
      </section>
    </main>
  );
}
