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
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cp-faint">Synthesis</p>
      <p className="mt-2 text-xs font-medium text-cp-text">Consensus &amp; disagreements</p>
      <div className="mt-3 space-y-2">
        <div className="h-1.5 w-full rounded-full bg-emerald-900/70" />
        <div className="h-1.5 w-4/5 rounded-full bg-cp-border" />
        <div className="h-1.5 w-full rounded-full bg-amber-900/60" />
      </div>
      <p className="mt-3 font-mono text-[9px] text-cp-faint">Bias signals · Blind spots · Open questions</p>
    </div>
  );
}

function VideoVerificationMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cp-faint">
        <Film className="h-3.5 w-3.5 shrink-0 text-cp-accent" aria-hidden />
        Video · frames · metadata
      </div>
      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
        Verdict · Inconclusive
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[9px] text-cp-muted">
        <div className="rounded border border-cp-border bg-cp-surface p-1.5 text-center">Model A</div>
        <div className="rounded border border-cp-border bg-cp-surface p-1.5 text-center">Model B</div>
        <div className="rounded border border-cp-border bg-cp-surface p-1.5 text-center">Model C</div>
      </div>
      <p className="mt-3 font-mono text-[9px] text-cp-faint">Per-model signals · Paid plans</p>
    </div>
  );
}

function ClaimVerificationMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <div className="rounded-md border border-cp-border bg-cp-surface px-3 py-2 text-xs font-medium text-cp-muted">
        Aggregate verdict · <span className="text-amber-600">Unverifiable</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div className="rounded border border-cp-border bg-cp-surface p-2.5">
          <p className="text-[9px] text-cp-faint">Score</p>
          <p className="text-xl font-bold text-cp-text">37</p>
        </div>
        <div className="rounded border border-cp-border bg-cp-surface p-2.5">
          <p className="text-[9px] text-cp-faint">Confidence</p>
          <p className="font-semibold text-amber-600">Low</p>
        </div>
      </div>
      <p className="mt-3 font-mono text-[9px] text-cp-faint">Per-model evidence · Audit trail</p>
    </div>
  );
}

function ConsensusMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-5 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cp-faint">Consensus</p>
      <p className="mt-1 font-mono text-3xl font-bold text-cp-accent">72</p>
      <div className="mt-1 h-1 w-full rounded-full bg-cp-border">
        <div className="h-1 w-[72%] rounded-full bg-cp-accent/60" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] text-cp-text">
        <div>
          <span className="text-[9px] text-cp-faint">Confidence</span>
          <p className="font-medium text-sky-600">Medium</p>
        </div>
        <div>
          <span className="text-[9px] text-cp-faint">Evidence</span>
          <p className="font-medium capitalize">mixed</p>
        </div>
        <div className="col-span-2">
          <span className="text-[9px] text-cp-faint">Support ratio</span>
          <p className="font-medium">62%</p>
        </div>
      </div>
    </div>
  );
}

function AuditMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <p className="font-mono text-[9px] text-cp-faint">audit.json</p>
      <div className="mt-2 space-y-1 font-mono text-[10px]">
        <p className="text-emerald-500/90">✓ models consulted</p>
        <p className="text-cp-muted">✓ scores · verdict</p>
        <p className="text-cp-muted">✓ consensus · metadata</p>
      </div>
      <p className="mt-3 font-mono text-[9px] text-cp-faint">Export / copy for records</p>
    </div>
  );
}

function GovernanceDashboardMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cp-faint">Governance</p>
      <p className="mt-2 text-xs font-medium text-cp-text">Policy · thresholds</p>
      <div className="mt-2 space-y-1 rounded border border-cp-border bg-cp-surface p-2.5 font-mono text-[10px] text-cp-muted">
        <p className="text-amber-600">Needs review · 3 items</p>
        <p className="text-cp-faint">Approve · block · request changes</p>
      </div>
    </div>
  );
}

function PeerReviewMockup() {
  return (
    <div className="rounded-xl border border-cp-border bg-cp-raised p-4 text-left shadow-[0_4px_32px_rgba(0,0,0,0.4)]">
      <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-cp-faint">Peer review</p>
      <p className="mt-2 text-xs text-cp-text">Reviewer assigned</p>
      <div className="mt-2 rounded border border-sky-200 bg-sky-50 px-2.5 py-2 font-mono text-[10px] text-sky-800">
        Flagged run in their queue — decision logged
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-cp-bg">

      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-4 py-20 sm:py-28">
        {/* Subtle radial glow behind content */}
        <div className="pointer-events-none absolute inset-0 flex items-start justify-center overflow-hidden">
          <div className="h-[500px] w-[800px] rounded-full bg-cp-accent/10 blur-[120px]" />
        </div>

        <div className="relative grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div className="space-y-7 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full border border-cp-accent/20 bg-cp-accent/10 px-4 py-1.5 font-sans text-xs font-medium tracking-wide text-cp-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-cp-accent" />
              Research · Claims · Video · Governance
            </div>

            <h1 className="text-5xl font-normal leading-[1.1] text-cp-text sm:text-6xl lg:text-7xl">
              Don&apos;t trust one{" "}
              <span className="italic text-cp-accent">AI.</span>{" "}
              <br className="hidden sm:block" />
              Verify with five.
            </h1>

            <p className="font-sans text-base leading-relaxed text-cp-muted sm:text-lg">
              ConvergePanel runs your research questions and claims through Claude, GPT, Gemini, Grok, and
              Perplexity simultaneously — showing you where they agree, where they disagree, and what each
              one misses. Paid plans add video verification.
            </p>

            <div className="flex flex-col items-center gap-3 pt-1 sm:flex-row lg:items-start">
              <Link
                href="/signup"
                className="inline-flex w-full items-center justify-center rounded-xl bg-cp-accent px-8 py-3 font-sans text-base font-semibold text-cp-bg shadow-[0_0_24px_rgba(37,99,235,0.25)] transition-all hover:bg-sky-600 hover:shadow-[0_0_32px_rgba(37,99,235,0.35)] sm:w-auto"
              >
                Try it free
              </Link>
              <a
                href="#features"
                className="inline-flex w-full items-center justify-center rounded-xl border border-cp-border bg-cp-surface px-8 py-3 font-sans text-base font-semibold text-cp-muted transition-colors hover:border-cp-accent/30 hover:text-cp-text sm:w-auto"
              >
                See how it works
              </a>
            </div>

            <p className="font-mono text-xs text-cp-faint">
              No credit card required · Free: 8 runs/month · Paid plans: up to 5 models
            </p>
          </div>

          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl border border-cp-border shadow-[0_8px_48px_rgba(0,0,0,0.5)]">
            <Image
              src="/research-hero.png"
              alt="ConvergePanel multi-model research panel"
              fill
              className="object-cover"
              priority
              sizes="(max-width: 768px) 100vw, 50vw"
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-cp-bg/60 via-transparent to-transparent" />
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-cp-border bg-cp-surface py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-2 text-center text-3xl font-normal text-cp-text">
            The problem with asking one AI
          </h2>
          <p className="mb-10 text-center font-mono text-xs text-cp-faint">Every model is confident. Not every model is right.</p>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {[
              {
                title: "Confident errors",
                body: "Every major AI model delivers wrong answers with the same confidence as right ones. A single model can't tell you when it's guessing. When five models answer independently, disagreements surface the uncertainty a single answer hides.",
              },
              {
                title: "Sycophancy by design",
                body: "Models are tuned to agree with you, not correct you. Ask one if your assumption is right and it will often say yes. Ask five: the ones that disagree are often closer to an honest check.",
              },
              {
                title: "No audit trail",
                body: "When a decision goes wrong, \"ChatGPT told me\" is weak evidence. Teams need a record of what was checked, how models split, and how confident the synthesis was — before the decision, not after.",
              },
            ].map(({ title, body }) => (
              <div key={title} className="rounded-xl border border-cp-border bg-cp-raised p-6">
                <div className="mb-3 h-px w-8 bg-cp-accent/40" />
                <h3 className="text-lg font-normal text-cp-text">{title}</h3>
                <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-20 sm:py-28">
        <div className="mb-16 text-center">
          <h2 className="text-3xl font-normal text-cp-text sm:text-4xl">
            Two modes. One trust layer.
          </h2>
          <div className="mx-auto mt-3 h-px w-16 bg-cp-accent/40" />
        </div>

        <div className="space-y-20">
          {/* Research */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">01</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Multi-model research panel</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Ask a serious research question. Five leading models answer independently. ConvergePanel
                synthesizes the results into a structured brief with consensus findings, disagreements, bias
                signals, and blind spots. You see what no single model would surface alone.
              </p>
            </div>
            <ResearchMockup />
          </div>

          {/* Claim Verification */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <ClaimVerificationMockup />
            <div className="lg:order-first">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">02</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Claim verification</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Paste any claim — from a report, an AI output, a strategy doc, or an article. Five models
                evaluate it independently. You get a clear verdict, a consensus score, per-model evidence,
                and a compact audit trail.
              </p>
            </div>
          </div>

          {/* Video */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">03</span>
              <h3 className="mt-2 flex items-center gap-2 text-2xl font-normal text-cp-text">
                <Film className="h-5 w-5 shrink-0 text-cp-accent" aria-hidden />
                Video verification
              </h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Upload a video up to 60 seconds. Three vision-capable AI models independently analyze
                extracted frames and metadata for signs of AI generation or manipulation. You get a clear
                verdict with per-model evidence showing what each model flagged.
              </p>
              <p className="mt-2 font-mono text-[10px] text-amber-600/80">
                ⚠ AI-assisted authenticity review — not forensic analysis.
              </p>
            </div>
            <VideoVerificationMockup />
          </div>

          {/* Consensus */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">04</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Consensus scoring</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Every run produces a consensus score from 0–100 that summarizes how defensible the result
                is given model agreement and evidence signals. Strong agreement means move faster. Weak
                agreement means dig deeper.
              </p>
            </div>
            <ConsensusMockup />
          </div>

          {/* Audit */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <AuditMockup />
            <div className="lg:order-first">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">05</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Audit trail</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Claims and research runs produce a compact, exportable audit record: which models ran,
                structured verdict signals, consensus score, and metadata. Built for teams that need to
                show their work.
              </p>
            </div>
          </div>

          {/* Governance */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">06</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Governance Dashboard</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Set consensus thresholds, flag weak evidence automatically, and review flagged runs before
                they&apos;re acted on. Assign a peer reviewer, approve or block claims, and keep a complete
                audit trail of every decision.
              </p>
              <p className="mt-2 font-mono text-xs font-medium text-cp-accent/80">
                Included on the 5-Model plan.
              </p>
            </div>
            <GovernanceDashboardMockup />
          </div>

          {/* Peer Review */}
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <PeerReviewMockup />
            <div className="lg:order-first">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-cp-accent">07</span>
              <h3 className="mt-2 text-2xl font-normal text-cp-text">Peer review</h3>
              <p className="mt-3 font-sans text-sm leading-relaxed text-cp-muted">
                Assign a colleague as your reviewer. When research or claim verification scores below your
                trust threshold, it shows up in their review queue. They can approve, block, or request
                changes — and each decision is logged for compliance.
              </p>
              <p className="mt-2 font-mono text-xs font-medium text-cp-accent/80">
                Included on the 5-Model plan.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="border-t border-cp-border bg-cp-surface py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-2 text-center text-3xl font-normal text-cp-text">
            Built for people who can&apos;t afford to be wrong
          </h2>
          <div className="mx-auto mb-10 mt-3 h-px w-16 bg-cp-accent/40" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {[
              {
                label: "Researchers & analysts",
                body: "Cross-check findings across models before publishing. See which claims hold up under multi-source scrutiny and which fall apart.",
              },
              {
                label: "Product & strategy teams",
                body: "Test market claims, competitive takes, and strategic assumptions before big bets. The consensus score marks what is defensible on the evidence you have.",
              },
              {
                label: "Compliance & risk teams",
                body: "Every claim verification and research run is evaluated against governance policies. Reviewers approve or block flagged results. The audit log records who reviewed what, when, and why.",
              },
              {
                label: "AI-powered teams",
                body: "If drafts and analysis come from AI, run the outputs through ConvergePanel before you act. Catch mistakes that read as polished and confident.",
              },
              {
                label: "Journalists & fact-checkers",
                body: "Review video clips before publishing. When citizen journalism or a viral clip lands on your desk, run multi-model analysis before you stake your credibility on it.",
              },
              {
                label: "PR & communications",
                body: "Review video before you amplify or respond. Understand authenticity signals before a clip shapes your strategy.",
              },
            ].map(({ label, body }) => (
              <div key={label} className="rounded-xl border border-cp-border bg-cp-raised p-5 transition-colors hover:border-cp-accent/20">
                <h3 className="text-base font-normal text-cp-text">{label}</h3>
                <p className="mt-2 font-sans text-sm leading-relaxed text-cp-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Popular verification workflows */}
      <section className="border-t border-cp-border bg-cp-bg py-14">
        <div className="mx-auto max-w-4xl px-4">
          <h2 className="mb-1 text-center text-xl font-normal text-cp-text">
            Popular verification workflows
          </h2>
          <p className="mb-8 text-center font-mono text-xs text-cp-faint">
            Explore how different teams use ConvergePanel in practice.
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: "Deep research and AI verification", href: "/use-cases/deep-research-and-ai-verification" },
              { label: "AI video verification with multiple models", href: "/use-cases/ai-video-verification" },
              { label: "AI claim verification for content creators", href: "/use-cases/ai-claim-verification-for-content-creators" },
              { label: "AI tools for investigative journalists", href: "/use-cases/ai-tools-for-investigative-journalists" },
              { label: "How to fact-check ChatGPT responses", href: "/use-cases/how-to-fact-check-chatgpt-responses" },
              { label: "How to create an AI audit trail", href: "/use-cases/how-to-create-an-ai-audit-trail" },
              { label: "AI audit trail software", href: "/use-cases/ai-audit-trail-software" },
              { label: "What is an AI consensus score?", href: "/use-cases/what-is-a-consensus-score" },
              { label: "How to verify sources from AI answers", href: "/use-cases/how-to-verify-sources-from-ai-answers" },
              { label: "How to identify blind spots in AI answers", href: "/use-cases/how-to-identify-blind-spots-in-ai-answers" },
              { label: "What is source grounding in AI?", href: "/use-cases/what-is-source-grounding-in-ai" },
            ].map(({ label, href }) => (
              <Link
                key={href}
                href={href}
                className="group flex items-center gap-2.5 rounded-lg border border-cp-border bg-cp-raised px-4 py-3 font-sans text-sm text-cp-muted transition-all hover:border-cp-accent/30 hover:text-cp-text"
              >
                <span className="text-cp-faint transition-colors group-hover:text-cp-accent shrink-0">→</span>
                {label}
              </Link>
            ))}
          </div>
          <p className="mt-6 text-center">
            <Link href="/use-cases" className="font-mono text-xs text-cp-accent transition-colors hover:text-sky-700">
              View all use cases →
            </Link>
          </p>
        </div>
      </section>

      {/* Pricing CTA */}
      <section className="border-t border-cp-border bg-cp-surface py-20">
        <div className="mx-auto max-w-2xl px-4 text-center">
          <h2 className="text-3xl font-normal text-cp-text sm:text-4xl">
            Start free. Upgrade when you need more.
          </h2>
          <p className="mx-auto mt-4 max-w-xl font-sans leading-relaxed text-cp-muted">
            The free plan includes 8 runs per month with up to 2 models per run. Paid plans unlock all five
            models, higher monthly limits, and — on the 5-Model plan — governance dashboards, peer review, and
            a full audit log.
          </p>
          <ul className="mx-auto mt-8 max-w-sm space-y-3 text-left">
            {[
              "Research across 5 AI models",
              "Claim verification with consensus scoring",
              "Video authenticity analysis (paid plans)",
              "Governance dashboard with peer review (5-Model plan)",
              "Full audit trail on every decision",
            ].map((item) => (
              <li key={item} className="flex gap-3 font-sans text-sm">
                <span className="font-mono font-bold text-emerald-500 shrink-0">✓</span>
                <span className="text-cp-muted">{item}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/pricing"
            className="mt-10 inline-flex items-center justify-center rounded-xl bg-cp-accent px-8 py-3 font-sans text-base font-semibold text-cp-bg shadow-[0_0_24px_rgba(37,99,235,0.2)] transition-all hover:bg-sky-600 hover:shadow-[0_0_32px_rgba(37,99,235,0.35)]"
          >
            View pricing
          </Link>
        </div>
      </section>

    </main>
  );
}
