/**
 * Pillar pages for the /solutions/[slug] SEO cluster.
 *
 * Each pillar anchors one vertical (M&A, CRE) and links out to every spoke
 * page in lib/learn/pages.ts that belongs to it. See README-SEO.md for the
 * cluster architecture and how these feed the sitemap + IndexNow.
 */

export interface PillarSection {
  heading: string;
  paragraphs: string[];
}

export interface PillarPage {
  slug: string;
  cluster: "ma" | "cre";
  publishedAt: string;
  /** <title> base — " | ConvergePanel" is appended by the route. Keep ≤ 60 chars total. */
  title: string;
  metaDescription: string;
  h1: string;
  intro: string[];
  sections: PillarSection[];
  /** Honest limitations — rendered near the bottom, before the CTA. */
  limitations: string[];
  cta: string;
}

export const PILLARS: PillarPage[] = [
  {
    slug: "ma-due-diligence",
    cluster: "ma",
    publishedAt: "2026-07-25",
    title: "AI Verification Layer for M&A Due Diligence",
    metaDescription:
      "Deal teams already use AI to draft diligence research. ConvergePanel verifies the conclusion before it reaches the IC memo — not another extraction tool.",
    h1: "An AI Verification Layer for M&A Due Diligence",
    intro: [
      "A due diligence note built by one AI model can read as complete and still rest on a single blind spot nobody checked. Deal teams have already folded ChatGPT, Claude, and similar tools into diligence research — drafting company summaries, market context, and risk call-outs in days instead of the week or two that work used to take. What most teams haven't built is a step that checks whether the AI's conclusion actually holds up before it goes into the IC memo.",
      "ConvergePanel is that step. It is not a data room, a contract-extraction tool, or a lease-abstraction service — those tools tell you what a document says. ConvergePanel runs a question or a draft finding through multiple AI models at once and shows you where they agree, where they split, and what each one is basing its answer on. The question it answers isn't \"what does this filing say.\" It's \"can I defend this conclusion to the committee.\"",
    ],
    sections: [
      {
        heading: "Why one model's confidence isn't a diligence process",
        paragraphs: [
          "A single model gives you one framing, shaped by one slice of training data, delivered in the same confident tone whether the underlying claim is well-evidenced or thinly supported. Nothing in the output signals which is which. An analyst reading a fluent summary has no way to tell whether \"customer concentration appears manageable\" reflects a genuine read of the accounts or a plausible-sounding guess.",
          "The problem compounds under deal timeline pressure. There usually isn't time to independently re-derive every AI-assisted finding from source documents before the IC meeting — which means the fluent version is what travels forward, untested, unless something forces a second, independent read.",
        ],
      },
      {
        heading: "What a verification layer actually checks",
        paragraphs: [
          "ConvergePanel runs the same question or draft conclusion through multiple models simultaneously and structures the comparison around four things: consensus (where models independently converge on a finding), disagreement (where they split, and on what basis), source grounding (which claims are tied to something checkable versus asserted as fact), and bias exposure (whether the agreement reflects independent confirmation or a training-data pattern all the models share).",
          "None of these four outputs is a verdict. Consensus across models is a stronger signal than one model's opinion, but it is not proof — models trained on overlapping public data can converge on the same wrong assumption about a sector or a deal structure. Disagreement is the more actionable signal: it tells you exactly which claim needs a human to go check the source before it's repeated in a memo.",
        ],
      },
      {
        heading: "Where this fits next to the tools you already use",
        paragraphs: [
          "ConvergePanel sits downstream of document processing, not instead of it. Your data room, your extraction tool, your comp-set builder — those produce the inputs and first-pass outputs. ConvergePanel is the layer that reviews the AI-generated conclusions those tools (or a chatbot) already produced, before a person signs their name to them in an IC memo, a lender package, or an LP update.",
          "It does not replace legal, financial, or accounting diligence, and it does not certify that a finding is correct. What it produces is a structured, exportable record of what was checked, where models agreed, where they didn't, and what still needs a qualified professional's judgment — the audit trail a committee, lender, or LP asks for when they ask how a conclusion was reached.",
        ],
      },
      {
        heading: "Illustrative example",
        paragraphs: [
          "A mid-market industrials target's AI-drafted diligence packet describes customer concentration as manageable and cites a specific top-account percentage. Run through a panel, the models converge on the general characterization but split on the underlying calculation — one model treating two commonly-owned entities as separate customers, another combining them into a single relationship that meaningfully changes the concentration figure. Neither read is unreasonable on its own; the disagreement is exactly the finding the committee needs before treating \"manageable\" as settled.",
          "The deal team traces the specific ownership structure directly, confirms the combined reading is correct, and revises the concentration figure before it reaches the IC memo — the kind of correction a single AI pass, read once and accepted without a second look, would have missed entirely. The revised figure, along with the panel comparison that surfaced it, becomes part of the record attached to the memo.",
        ],
      },
      {
        heading: "Who this helps",
        paragraphs: [
          "Corp dev leads and deal team analysts use it to check an AI-drafted finding before it goes into an IC memo. Compliance officers and general counsel use it to build the audit trail an LP or regulator expects when AI assisted a due diligence conclusion. Fund managers use it to document a consistent verification policy across every acquisition, not just the deals where someone happened to double-check something. Analysts preparing for an investment committee use it to know, before the meeting, which assumptions are likely to draw a challenge.",
        ],
      },
    ],
    limitations: [
      "ConvergePanel does not access your data room or extract terms from documents directly — it reviews the conclusions and claims that came out of that process.",
      "Model consensus is a confidence signal, not proof. Models trained on similar data can share the same blind spot.",
      "It does not replace legal, financial, or accounting due diligence, or the judgment of a qualified deal professional.",
    ],
    cta: "Run your first panel free — 2 models per run.",
  },
  {
    slug: "cre-due-diligence",
    cluster: "cre",
    publishedAt: "2026-07-25",
    title: "Verify AI-Assisted CRE Due Diligence",
    metaDescription:
      "Investors already use AI to draft lease reads and market context. ConvergePanel verifies the conclusion before it shapes the underwriting model.",
    h1: "Verify AI-Assisted CRE Due Diligence Before You Close",
    intro: [
      "An AI-drafted read on a lease's renewal terms, a submarket's rent-growth trend, or a comp set's cap rates can look thorough and still rest on one model's single pass through the materials. Investors, underwriters, and asset managers have already folded AI into CRE due diligence — summarizing leases, drafting market context, flagging obvious red flags — often faster than a junior analyst could get through the same documents. What's missing in most workflows is a step that checks whether that AI-generated read is actually right before it shapes an underwriting model or a lender package.",
      "ConvergePanel is that step. It is not a lease-abstraction tool, a data room, or a contract-extraction platform — those tools tell you what a lease or a filing says. ConvergePanel runs a question or a draft conclusion through multiple AI models at once and shows you where they agree, where they split, and what each is basing its read on. The question it answers isn't \"what does the lease say.\" It's \"can I underwrite on this, and can I defend it to my committee or my lender.\"",
    ],
    sections: [
      {
        heading: "Why one model's read of a lease or a comp set isn't enough",
        paragraphs: [
          "A single model's characterization of a lease's renewal option, escalation clause, or termination right reads with the same confidence whether it accurately parsed a dense, cross-referenced provision or missed a qualifying clause three paragraphs later. Underwriting assumptions carry the same risk — a rent-growth or cap-rate assumption pulled from one model's synthesis of market commentary looks identical whether it reflects the current submarket or a stale, more favorable comp.",
          "There's rarely a natural point in a live acquisition timeline that forces a second, independent read of an AI-generated lease characterization or market assumption before it's built into a model — which means whatever the first model said is what the underwriting quietly inherits.",
        ],
      },
      {
        heading: "What a verification layer actually checks",
        paragraphs: [
          "ConvergePanel runs the same question through multiple models and structures the comparison around consensus (where models independently converge), disagreement (where they split, and on what basis), source grounding (whether a claim ties back to something checkable in the lease, filing, or market data), and bias exposure (whether agreement reflects genuine corroboration or a shared blind spot).",
          "None of these is a verdict on its own. Consensus across models raises confidence, but models can converge on the same outdated market read if they're drawing on overlapping public data. Disagreement is the more actionable output — it names the exact assumption or lease provision that needs a human to trace back to the source before it shapes a valuation.",
        ],
      },
      {
        heading: "Where this fits next to the tools you already use",
        paragraphs: [
          "ConvergePanel sits downstream of lease abstraction, data rooms, and comp databases — it doesn't replace them. Those tools produce the extracted terms and first-pass market data; ConvergePanel reviews the AI-generated conclusions built on top of that data before someone signs off on an underwriting model, a lender package, or an LP update.",
          "It doesn't replace legal, appraisal, or underwriting judgment, and it doesn't certify that an assumption is correct. What it produces is a structured, exportable record of what was checked and where models agreed or disagreed — the documentation an LP, lender, or investment committee increasingly expects when AI assisted the analysis.",
        ],
      },
      {
        heading: "Illustrative example",
        paragraphs: [
          "An AI-drafted underwriting narrative for a multifamily acquisition assumes a specific rent-growth trajectory drawn from one model's synthesis of submarket commentary. Run through a panel, one model corroborates the assumption; two others suggest a materially more conservative trajectory, citing recent absorption data the first model's training didn't weight as heavily. The disagreement doesn't resolve which number is right — it tells the underwriter exactly which specific assumption is thin enough to warrant a direct broker call or an in-person site visit before the final offer price gets locked firmly in place.",
          "The team adjusts the underwriting to a more conservative range and documents the panel comparison alongside the decision — a materially stronger position if the assumption is later questioned by a lender or an LP, compared with a single model's assumption accepted without a second, independent read.",
        ],
      },
      {
        heading: "Who this helps",
        paragraphs: [
          "Underwriters use it to check an AI-generated read on comps, rent-growth assumptions, or lease terms before committing to an offer price. Fund managers use it to build the audit-ready documentation an LP or lender due diligence process expects. Asset managers use it to catch an AI misread of a lease provision or a market statistic before it shapes a valuation. Institutional investors and joint-venture partners use it to establish a consistent, firm-wide verification policy rather than relying on individual analysts' habits, which matters most when a fund's entire process is being evaluated across its whole portfolio of assets rather than judged one deal at a time.",
        ],
      },
    ],
    limitations: [
      "ConvergePanel does not abstract lease terms or extract data from filings directly — it reviews the conclusions and assumptions that came out of that process.",
      "Model consensus is a confidence signal, not proof. Models trained on similar market commentary can share the same stale assumption.",
      "It does not replace appraisal, legal, or underwriting judgment from a qualified real estate professional.",
    ],
    cta: "Run your first panel free — 2 models per run.",
  },
];

export function getPillarBySlug(slug: string): PillarPage | undefined {
  return PILLARS.find((p) => p.slug === slug);
}
