export interface PSEOPage {
  slug: string;
  title: string;
  h1: string;
  audience: string;
  audienceDetail: string;
  problem: string;
  solution: string;
  workflow: string[];
  useCases: string[];
  cta: string;
  category: string;
  metaDescription: string;
}

export interface PSEOCategory {
  label: string;
  color: string;
  tailwindText: string;
  tailwindBg: string;
  tailwindBorder: string;
  tailwindDot: string;
}

export const CATEGORIES: Record<string, PSEOCategory> = {
  "claim-verification": {
    label: "Claim Verification",
    color: "#2563eb",
    tailwindText: "text-blue-700",
    tailwindBg: "bg-blue-50",
    tailwindBorder: "border-blue-200",
    tailwindDot: "bg-blue-600",
  },
  "video-verification": {
    label: "Video Verification",
    color: "#7c3aed",
    tailwindText: "text-violet-700",
    tailwindBg: "bg-violet-50",
    tailwindBorder: "border-violet-200",
    tailwindDot: "bg-violet-600",
  },
  research: {
    label: "Research",
    color: "#059669",
    tailwindText: "text-emerald-700",
    tailwindBg: "bg-emerald-50",
    tailwindBorder: "border-emerald-200",
    tailwindDot: "bg-emerald-600",
  },
  governance: {
    label: "Governance",
    color: "#d97706",
    tailwindText: "text-amber-700",
    tailwindBg: "bg-amber-50",
    tailwindBorder: "border-amber-200",
    tailwindDot: "bg-amber-600",
  },
  "thought-leadership": {
    label: "Thought Leadership",
    color: "#dc2626",
    tailwindText: "text-red-700",
    tailwindBg: "bg-red-50",
    tailwindBorder: "border-red-200",
    tailwindDot: "bg-red-600",
  },
  glossary: {
    label: "Glossary",
    color: "#0891b2",
    tailwindText: "text-cyan-700",
    tailwindBg: "bg-cyan-50",
    tailwindBorder: "border-cyan-200",
    tailwindDot: "bg-cyan-600",
  },
  "how-to": {
    label: "How-To",
    color: "#4f46e5",
    tailwindText: "text-indigo-700",
    tailwindBg: "bg-indigo-50",
    tailwindBorder: "border-indigo-200",
    tailwindDot: "bg-indigo-600",
  },
};

export const PAGES: PSEOPage[] = [
  {
    slug: "claim-verification-for-journalists",
    title: "Claim Verification for Journalists",
    h1: "AI Claim Verification Built for Newsrooms",
    audience: "Journalists",
    audienceDetail: "Reporters, editors, and fact-checkers working on deadline",
    problem:
      "A single AI model can confidently state something false. Journalists can't afford to publish a claim verified by one source — especially when that source is an AI that doesn't flag its own uncertainty.",
    solution:
      "ConvergePanel runs your claim through five leading AI models simultaneously and returns a structured verdict: consensus score, per-model evidence, disagreements, and an audit trail you can attach to your notes.",
    workflow: [
      "Paste the claim you're checking into Claim Verification mode",
      "ConvergePanel queries GPT, Claude, Grok, Perplexity, and Gemini independently",
      "You receive a consensus score (0–100), per-model ratings, and flagged disagreements",
      "Export the audit bundle as a verification record for your editor",
    ],
    useCases: [
      "Checking a politician's statistical claim before publication",
      "Verifying quotes attributed to public figures across multiple sources",
      "Cross-referencing breaking news claims when primary sources are unavailable",
    ],
    cta: "Try claim verification free — models included",
    category: "claim-verification",
    metaDescription:
      "Verify claims with 5 AI models at once. ConvergePanel gives journalists consensus scores, per-model evidence, and audit trails — not just one AI's guess.",
  },
  {
    slug: "claim-verification-for-researchers",
    title: "Claim Verification for Researchers",
    h1: "Multi-Model Claim Verification for Academic Research",
    audience: "Researchers",
    audienceDetail: "Academic researchers, PhD candidates, and research assistants",
    problem:
      "Literature reviews and meta-analyses require checking dozens of factual claims. A single AI model can hallucinate citations, fabricate statistics, or miss nuance — and you won't always catch it.",
    solution:
      "ConvergePanel cross-checks claims across five models to surface where they agree, where they conflict, and where evidence is weak. You see the shape of certainty before you cite anything.",
    workflow: [
      "Enter a factual claim from a paper or dataset",
      "Five models independently assess accuracy with supporting evidence",
      "Review the consensus score, disagreements, and evidence quality ratings",
      "Use the structured output to decide whether further primary-source verification is needed",
    ],
    useCases: [
      "Spot-checking statistics cited in literature reviews",
      "Verifying historical claims in interdisciplinary research",
      "Assessing whether a widely-cited finding has been contested or retracted",
    ],
    cta: "Start verifying research claims — free tier available",
    category: "claim-verification",
    metaDescription:
      "Cross-check research claims with 5 AI models. ConvergePanel surfaces consensus, contradictions, and evidence quality so researchers know what to trust.",
  },
  {
    slug: "claim-verification-for-analysts",
    title: "Claim Verification for Analysts",
    h1: "Structured Claim Verification for Intelligence & Business Analysts",
    audience: "Analysts",
    audienceDetail: "Business intelligence, competitive intelligence, and policy analysts",
    problem:
      "Analyst work depends on accurate inputs. When you're synthesizing reports from multiple sources, a single wrong data point compounds through your entire analysis. AI tools that give you one confident answer don't show you the uncertainty underneath.",
    solution:
      "ConvergePanel returns structured disagreement — not just an answer. When five models split on a claim, that's a signal to dig deeper. When they converge, you can move faster.",
    workflow: [
      "Paste a claim, data point, or assertion from a report",
      "Five models evaluate it independently",
      "Review the consensus score to gauge reliability",
      "Flag low-consensus items for manual verification in your workflow",
    ],
    useCases: [
      "Checking market-size claims in competitor reports",
      "Verifying regulatory assertions before including them in briefings",
      "Triaging a batch of claims by confidence level to prioritize manual review",
    ],
    cta: "Verify your first claim — no credit card required",
    category: "claim-verification",
    metaDescription:
      "Analysts: verify claims with 5 AI models at once. ConvergePanel shows consensus, splits, and evidence quality — so you know where to dig deeper.",
  },
  {
    slug: "video-authenticity-review-for-fact-checkers",
    title: "Video Authenticity Review for Fact-Checkers",
    h1: "AI Video Authenticity Review for Fact-Checking Teams",
    audience: "Fact-checkers",
    audienceDetail: "Professional fact-checkers at newsrooms, NGOs, and verification organizations",
    problem:
      "Deepfakes and AI-generated video are increasingly realistic. A single detection tool has blind spots. Fact-checkers need multiple signals — not one model's guess — before making a call.",
    solution:
      "ConvergePanel's Video Verification mode sends extracted frames to three vision-capable AI models (GPT-4o, Claude, Gemini). Each independently looks for synthetic artifacts, manipulation indicators, and generation signatures. You get a consensus verdict, not a single opinion.",
    workflow: [
      "Upload a video clip (up to 60 seconds)",
      "ConvergePanel extracts frames and metadata",
      "Three vision models independently review for manipulation and generation signals",
      "You receive a verdict, consensus score, and per-model evidence with specific signals flagged",
    ],
    useCases: [
      "Checking whether a viral social media video shows signs of AI generation",
      "Reviewing campaign footage flagged by readers or tipsters",
      "Adding a structured AI-review step to your fact-checking workflow",
    ],
    cta: "Try video verification on your next flagged clip",
    category: "video-verification",
    metaDescription:
      "3 vision-capable AI models review your video for deepfake and manipulation signals. ConvergePanel gives fact-checkers a consensus verdict — not one tool's guess.",
  },
  {
    slug: "video-authenticity-review-for-researchers",
    title: "Video Authenticity Review for Researchers",
    h1: "Multi-Model Video Authenticity Analysis for Research",
    audience: "Researchers",
    audienceDetail: "Media researchers, misinformation scholars, and digital forensics students",
    problem:
      "Studying video manipulation at scale requires consistent, structured analysis. Manual frame-by-frame review doesn't scale, and single-model detectors produce inconsistent results across video types.",
    solution:
      "ConvergePanel provides structured multi-model video review with per-model evidence, consensus scoring, and exportable results — giving researchers a repeatable analysis framework rather than ad-hoc tool outputs.",
    workflow: [
      "Upload a video sample (up to 60 seconds)",
      "Three vision-capable models independently analyze extracted frames",
      "Review per-model evidence: manipulation signals, authenticity signals, compression artifacts",
      "Export structured results for your dataset or paper",
    ],
    useCases: [
      "Building a labeled dataset of AI-generated vs. authentic video",
      "Comparing multi-model consensus against ground-truth labels",
      "Documenting detection methodology for reproducible research",
    ],
    cta: "Start structured video analysis — see how models compare",
    category: "video-verification",
    metaDescription:
      "Researchers: analyze video authenticity with 3 vision AI models. ConvergePanel provides structured, exportable results with consensus scoring.",
  },
  {
    slug: "deep-research-with-multiple-ai-models",
    title: "Deep Research with Multiple AI Models",
    h1: "Why Deep Research Requires More Than One AI Model",
    audience: "Knowledge workers",
    audienceDetail: "Anyone doing research-level work — analysts, strategists, students, consultants",
    problem:
      "Each AI model has different training data, different biases, and different blind spots. Asking one model a complex question gives you one perspective dressed up as the answer.",
    solution:
      "ConvergePanel's Research mode runs your question through five models simultaneously and synthesizes a structured brief: key findings, where models agree, where they disagree, bias signals, and open questions still worth investigating.",
    workflow: [
      "Type a complex research question",
      "Five models answer independently",
      "ConvergePanel synthesizes a brief showing consensus, disagreements, and bias signals",
      "You see the full landscape of AI opinion — not just one model's take",
    ],
    useCases: [
      "Investigating a policy question where expert opinion is divided",
      "Comparing perspectives on an emerging technology's risks and benefits",
      "Getting a balanced starting point before committing to a research direction",
    ],
    cta: "Ask your first research question — 2 models free",
    category: "research",
    metaDescription:
      "Run complex research questions through 5 AI models at once. ConvergePanel synthesizes consensus, disagreements, and bias signals into one structured brief.",
  },
  {
    slug: "why-not-trust-one-ai-model-for-serious-decisions",
    title: "Why Not Trust One AI Model for Serious Decisions",
    h1: "Why You Shouldn't Trust a Single AI Model for Serious Decisions",
    audience: "Decision-makers",
    audienceDetail: "Team leads, executives, analysts, and anyone using AI for high-stakes work",
    problem:
      "AI models are confidently wrong on a regular basis. They hallucinate sources, fabricate statistics, and present contested claims as settled fact. When you rely on one model, you inherit all of its blind spots with none of the warning signs.",
    solution:
      "ConvergePanel shows you where models agree and where they don't. Disagreement is the signal. When five models converge on an answer, your confidence is well-placed. When they split, you know exactly where to apply human judgment.",
    workflow: [
      "Submit a question or claim",
      "See how five models independently respond",
      "The consensus score quantifies agreement strength",
      "Disagreements and bias signals tell you where to look harder",
    ],
    useCases: [
      "Before including an AI-generated data point in a board presentation",
      "When an AI answer 'feels right' but the stakes are high",
      "Anywhere you'd want a second opinion — but from five models, not two",
    ],
    cta: "See disagreement in action — try a free panel run",
    category: "thought-leadership",
    metaDescription:
      "One AI model gives you confidence. Five AI models give you accuracy. Learn why multi-model verification matters for serious decisions.",
  },
  {
    slug: "ai-governance-workflow-for-enterprise-teams",
    title: "AI Governance Workflow for Enterprise Teams",
    h1: "AI Governance Workflows: Peer Review, Audit Trails, and Policy Gates",
    audience: "Enterprise teams",
    audienceDetail: "Compliance officers, ops managers, and teams subject to AI governance requirements",
    problem:
      "Enterprise AI use creates liability. If your team relies on AI outputs for decisions, you need a trail showing what was checked, who reviewed it, and whether it met your policies — before it reaches the final deliverable.",
    solution:
      "ConvergePanel's governance layer checks every run against configurable policies. Low consensus scores, weak evidence, or sensitive topics automatically flag results for peer review. Each review decision is logged with who approved, blocked, or requested changes — and why.",
    workflow: [
      "Set governance policies: consensus thresholds, sensitive-topic flags, evidence-quality minimums",
      "Team members run research or verification as normal",
      "Results that fall below policy thresholds are automatically flagged",
      "Assigned peer reviewers approve, block, or request changes in the governance dashboard",
      "Every decision is recorded in the audit log",
    ],
    useCases: [
      "Regulated industries (finance, healthcare) that need AI-use documentation",
      "Teams publishing AI-assisted reports that need editorial sign-off",
      "Organizations building internal AI-use policies and needing enforcement tooling",
    ],
    cta: "See the governance dashboard — start a 5-model trial",
    category: "governance",
    metaDescription:
      "Enterprise AI governance: automatic policy checks, peer review workflows, and full audit trails. ConvergePanel makes AI verification auditable.",
  },
  {
    slug: "what-is-a-verification-gate",
    title: "What Is a Verification Gate?",
    h1: "What Is a Verification Gate in AI Workflows?",
    audience: "AI-curious professionals",
    audienceDetail: "Anyone evaluating AI tools for team workflows",
    problem:
      "Most AI tools let you generate outputs freely with no checkpoint between 'AI said it' and 'we acted on it.' That gap is where errors become costly.",
    solution:
      "A Verification Gate is a structured checkpoint where AI output is evaluated before it moves downstream. In ConvergePanel, this means every result is scored for consensus, evidence quality, and policy compliance — and low-scoring results are held for human review before they're used.",
    workflow: [
      "AI generates an output (research brief, claim verdict, video review)",
      "The Verification Gate evaluates: consensus score, evidence quality, sensitive-topic flags",
      "Passing results flow through; flagged results are held for peer review",
      "The gate decision is recorded in the audit log",
    ],
    useCases: [
      "Preventing low-confidence AI claims from reaching published reports",
      "Ensuring sensitive topics always get human review",
      "Meeting internal AI-use policies with auditable enforcement",
    ],
    cta: "See Verification Gates in action",
    category: "glossary",
    metaDescription:
      "A Verification Gate is a checkpoint where AI output is evaluated before you act on it. Learn how ConvergePanel uses consensus scoring and policy checks.",
  },
  {
    slug: "what-is-a-panel-verdict",
    title: "What Is a Panel Verdict?",
    h1: "What Is a Panel Verdict in Multi-Model AI?",
    audience: "AI-curious professionals",
    audienceDetail: "Anyone learning about multi-model verification approaches",
    problem:
      "When you ask one AI a question, you get an answer. When you ask five, you get five answers. How do you turn that into something actionable?",
    solution:
      "A Panel Verdict is ConvergePanel's synthesized output from running multiple models. It includes an aggregate rating (accurate / partially accurate / inaccurate / unverifiable), a consensus score (0–100), per-model evidence, and flagged disagreements — structured so you can act on it, not just read it.",
    workflow: [
      "Submit a claim to the panel",
      "Each model independently rates it and provides evidence",
      "ConvergePanel aggregates ratings into a single Panel Verdict",
      "You see the verdict, consensus score, and per-model breakdowns",
    ],
    useCases: [
      "Getting a single actionable output from five AI models",
      "Understanding not just 'what do the models say' but 'how much do they agree'",
      "Documenting AI-assisted verification with structured evidence",
    ],
    cta: "Run your first Panel Verdict — free",
    category: "glossary",
    metaDescription:
      "A Panel Verdict aggregates ratings from 5 AI models into one structured output: verdict, consensus score, and per-model evidence. Learn how it works.",
  },
  {
    slug: "what-is-source-grounding-in-ai",
    title: "What Is Source-Grounding in AI?",
    h1: "What Is Source-Grounding — and Why Does It Matter for AI Trust?",
    audience: "AI-curious professionals",
    audienceDetail: "Professionals evaluating AI reliability for their work",
    problem:
      "AI models generate plausible-sounding answers regardless of whether they have good evidence. Without source-grounding, you can't tell the difference between 'the model found strong evidence' and 'the model made something up.'",
    solution:
      "Source-grounding means tying AI claims back to retrievable evidence. In ConvergePanel, each model's output includes evidence quality ratings and, where available, citations — so you can see whether a verdict rests on solid ground or thin air.",
    workflow: [
      "Submit a question or claim",
      "Models return answers with evidence and (where available) citations",
      "ConvergePanel rates evidence quality per model",
      "You see which answers are grounded and which are speculative",
    ],
    useCases: [
      "Distinguishing AI-generated reasoning from AI-retrieved evidence",
      "Prioritizing well-grounded claims over speculative ones in reports",
      "Teaching teams to evaluate AI output critically",
    ],
    cta: "See evidence quality scoring in a free panel run",
    category: "glossary",
    metaDescription:
      "Source-grounding ties AI claims to retrievable evidence. Learn why it matters and how ConvergePanel rates evidence quality across 5 models.",
  },
  {
    slug: "single-model-vs-multi-model-verification",
    title: "Single-Model vs Multi-Model Verification",
    h1: "Single-Model vs Multi-Model AI Verification: What's the Difference?",
    audience: "Decision-makers",
    audienceDetail: "Anyone comparing AI verification approaches",
    problem:
      "Most people use one AI model at a time — ChatGPT or Claude or Gemini. Each gives confident answers. But how do you know when that confidence is misplaced?",
    solution:
      "Multi-model verification runs the same question through multiple models and compares results. ConvergePanel structures this comparison: consensus scores, disagreement maps, and per-model evidence make the difference between single-model and multi-model immediately visible.",
    workflow: [
      "Single-model: ask one AI → get one answer → hope it's right",
      "Multi-model: ask five AIs → see where they agree and disagree → know where to trust",
      "ConvergePanel automates the multi-model approach with structured synthesis",
    ],
    useCases: [
      "Understanding why your ChatGPT answer might be wrong",
      "Evaluating whether multi-model adds value for your use case",
      "Building a case for multi-model verification in your organization",
    ],
    cta: "Compare single vs multi-model — run a free panel",
    category: "thought-leadership",
    metaDescription:
      "One AI model gives confidence. Multiple models give accuracy. Compare single-model vs multi-model AI verification and see why disagreement is the signal.",
  },
  {
    slug: "ai-claim-verification-for-finance-teams",
    title: "AI Claim Verification for Finance Teams",
    h1: "Multi-Model Claim Verification for Finance Professionals",
    audience: "Finance teams",
    audienceDetail: "Financial analysts, risk managers, investment researchers, and compliance officers",
    problem:
      "Financial decisions rest on data accuracy. When AI models hallucinate statistics, fabricate market data, or present outdated figures as current, the cost isn't embarrassment — it's capital at risk.",
    solution:
      "ConvergePanel lets finance teams verify claims, data points, and market assertions against five models before they enter models, reports, or recommendations. Low consensus scores become automatic hold signals.",
    workflow: [
      "Paste a financial claim, statistic, or market assertion",
      "Five models independently verify with evidence",
      "Review consensus score and flag items below your threshold",
      "Export audit trail for compliance documentation",
    ],
    useCases: [
      "Verifying earnings claims before including them in analyst reports",
      "Checking regulatory assertions in due-diligence documents",
      "Adding an AI verification layer to research note workflows",
    ],
    cta: "Verify a financial claim — try the free panel",
    category: "claim-verification",
    metaDescription:
      "Finance teams: verify claims with 5 AI models before they reach reports or clients. ConvergePanel provides consensus scoring and audit trails.",
  },
  {
    slug: "ai-claim-verification-for-policy-teams",
    title: "AI Claim Verification for Policy Teams",
    h1: "AI-Powered Claim Verification for Policy Analysis",
    audience: "Policy teams",
    audienceDetail: "Policy analysts, government researchers, think-tank staff, and legislative aides",
    problem:
      "Policy work depends on accurate claims — about program outcomes, budget impacts, comparative data, and expert consensus. AI can fabricate any of these convincingly. One bad data point in a policy brief can undermine months of work.",
    solution:
      "ConvergePanel lets policy teams cross-check claims across five models before they enter briefs, memos, or testimony. The structured output shows exactly where models agree and where they don't — turning AI from a risk into a verification layer.",
    workflow: [
      "Enter a policy claim or statistic you need to verify",
      "Five models independently assess with evidence",
      "The consensus score tells you how safe the claim is to cite",
      "Export structured evidence for your brief or memo",
    ],
    useCases: [
      "Checking statistical claims about program outcomes",
      "Verifying comparative international data in policy memos",
      "Cross-referencing claims in submitted public comments or testimony",
    ],
    cta: "Verify a policy claim — start free",
    category: "claim-verification",
    metaDescription:
      "Policy teams: cross-check claims with 5 AI models. ConvergePanel shows where models agree and disagree — so your briefs rest on verified data.",
  },
  {
    slug: "ai-video-review-for-media-teams",
    title: "AI Video Review for Media Teams",
    h1: "AI Video Authenticity Review for Media and Communications Teams",
    audience: "Media teams",
    audienceDetail: "Social media managers, communications directors, PR teams, and brand safety officers",
    problem:
      "Deepfakes and AI-generated video increasingly target brands, executives, and public figures. Media teams need a fast way to check whether a circulating video is authentic before deciding how to respond.",
    solution:
      "ConvergePanel's Video Verification mode runs three vision-capable AI models against extracted frames to check for AI generation signatures, synthetic artifacts, and manipulation indicators — giving you a structured assessment in minutes, not hours.",
    workflow: [
      "Upload the flagged video (up to 60 seconds)",
      "Three vision models independently analyze frames and metadata",
      "Review the consensus verdict and per-model signals",
      "Use the structured output to inform your team's response",
    ],
    useCases: [
      "Checking whether a viral video of your CEO is authentic or generated",
      "Reviewing user-submitted video content before amplification",
      "Adding an AI-review step to crisis communications protocols",
    ],
    cta: "Review a video clip — see what 3 models find",
    category: "video-verification",
    metaDescription:
      "Media teams: check video authenticity with 3 vision AI models. ConvergePanel detects deepfake signals and provides a structured consensus verdict.",
  },
  {
    slug: "ai-peer-review-for-high-stakes-workflows",
    title: "AI Peer Review for High-Stakes Workflows",
    h1: "Structured AI Peer Review for High-Stakes Decisions",
    audience: "Enterprise teams",
    audienceDetail: "Teams where AI-assisted outputs feed into consequential decisions",
    problem:
      "When AI outputs inform high-stakes decisions — hiring, investing, publishing, regulating — there's no 'undo.' But most AI tools have zero review layer between 'model generated it' and 'someone acted on it.'",
    solution:
      "ConvergePanel's governance layer adds peer review to AI-assisted workflows. Results that fall below consensus or evidence thresholds are automatically flagged. An assigned reviewer approves, blocks, or requests changes — and every decision is logged.",
    workflow: [
      "Run a research query, claim verification, or video review",
      "Governance policies auto-flag results below your thresholds",
      "Peer reviewer receives flagged items in their dashboard",
      "They approve, block, or request changes — each action is logged",
    ],
    useCases: [
      "Editorial teams requiring sign-off before publishing AI-verified claims",
      "Compliance teams auditing AI-assisted research outputs",
      "Any team that needs a paper trail for AI-informed decisions",
    ],
    cta: "Add peer review to your AI workflow",
    category: "governance",
    metaDescription:
      "Add structured peer review to AI-assisted decisions. ConvergePanel auto-flags low-confidence results and logs every review action for compliance.",
  },
  {
    slug: "how-to-compare-chatgpt-claude-gemini-grok-perplexity-for-research",
    title: "How to Compare ChatGPT, Claude, Gemini, Grok, and Perplexity for Research",
    h1: "How to Compare ChatGPT, Claude, Gemini, Grok, and Perplexity — Without Using All Five Separately",
    audience: "Researchers and knowledge workers",
    audienceDetail: "Anyone who has tried multiple AI models and wants a structured comparison",
    problem:
      "You probably already know different models give different answers. But comparing them manually — opening five tabs, pasting the same question, reading five responses, trying to figure out where they actually disagree — takes forever and produces no structured output.",
    solution:
      "ConvergePanel runs all five models on your question in one click and synthesizes the results: where they agree, where they split, what each one emphasizes, and what none of them address. You get the comparison without the tab-switching.",
    workflow: [
      "Enter your research question once",
      "ConvergePanel queries GPT, Claude, Gemini, Grok, and Perplexity simultaneously",
      "Review the synthesized brief: consensus, disagreements, bias signals, open questions",
      "Drill into individual model responses if you want the raw detail",
    ],
    useCases: [
      "Settling a debate about which model is 'right' on a complex question",
      "Getting a comprehensive view before committing to one model's framing",
      "Understanding each model's strengths and biases for your domain",
    ],
    cta: "Compare all five models — start with 2 free",
    category: "research",
    metaDescription:
      "Compare ChatGPT, Claude, Gemini, Grok, and Perplexity in one click. ConvergePanel shows where they agree, where they split, and what they miss.",
  },
  {
    slug: "ai-trust-dashboard-for-decision-support",
    title: "AI Trust Dashboard for Decision Support",
    h1: "The AI Trust Dashboard: Consensus, Confidence, and Evidence at a Glance",
    audience: "Decision-makers",
    audienceDetail: "Leaders and teams who use AI outputs to inform decisions",
    problem:
      "AI gives you answers. It doesn't give you a trust score. You're left guessing whether the output is well-supported or the model just sounded confident.",
    solution:
      "ConvergePanel's structured output is effectively a trust dashboard: consensus scores, evidence quality ratings, confidence labels, and disagreement maps — all computed from multi-model comparison. You see how trustworthy the output is, not just what it says.",
    workflow: [
      "Run any query — research, claim verification, or video review",
      "Review the consensus score (0–100) and evidence quality ratings",
      "Check disagreement signals and bias flags",
      "Use governance thresholds to automate trust decisions",
    ],
    useCases: [
      "Quickly assessing whether an AI output is decision-ready",
      "Setting team-wide thresholds for 'good enough to act on'",
      "Building a culture of measured AI trust rather than blind acceptance",
    ],
    cta: "See the trust dashboard — run a free panel",
    category: "governance",
    metaDescription:
      "ConvergePanel's trust dashboard shows consensus scores, evidence quality, and disagreement signals — so you know how trustworthy AI output really is.",
  },
  {
    slug: "how-to-verify-a-viral-claim-with-ai",
    title: "How to Verify a Viral Claim with AI",
    h1: "How to Verify a Viral Claim Using Multi-Model AI",
    audience: "General audience",
    audienceDetail: "Anyone who sees a viral claim and wants to check it before sharing",
    problem:
      "Viral claims spread faster than corrections. Asking one AI whether something is true just gives you one more opinion. You need structured verification — not another confident guess.",
    solution:
      "ConvergePanel lets you paste any claim and see what five AI models think. The consensus score tells you whether the claim is well-supported, disputed, or unverifiable. It takes 30 seconds instead of 30 minutes of manual searching.",
    workflow: [
      "Copy the viral claim — headline, tweet, or quote",
      "Paste it into ConvergePanel's Claim Verification mode",
      "Five models independently rate it: accurate, partially accurate, inaccurate, or unverifiable",
      "Read the consensus score and per-model evidence to make your own judgment",
    ],
    useCases: [
      "Checking a viral statistic before sharing it on social media",
      "Verifying a headline that seems too dramatic to be true",
      "Settling a debate with structured evidence instead of competing Google searches",
    ],
    cta: "Verify a claim right now — free",
    category: "how-to",
    metaDescription:
      "Paste a viral claim. Get a verdict from 5 AI models in seconds. ConvergePanel shows consensus, disagreements, and evidence — so you share facts, not fiction.",
  },
  {
    slug: "how-to-review-a-suspicious-video-with-ai",
    title: "How to Review a Suspicious Video with AI",
    h1: "How to Review a Suspicious Video Using AI — Step by Step",
    audience: "General audience",
    audienceDetail: "Anyone who encounters a video that looks potentially fake or manipulated",
    problem:
      "You see a video that doesn't look right — maybe the lighting is off, the audio doesn't match, or the person's movements seem unnatural. You have no way to check it systematically without specialized forensic tools.",
    solution:
      "ConvergePanel's Video Verification mode lets you upload the clip and get a structured review from three vision-capable AI models. Each flags specific signals — synthetic artifacts, manipulation indicators, generation signatures — so you see evidence, not just a guess.",
    workflow: [
      "Upload the suspicious video (up to 60 seconds)",
      "ConvergePanel extracts frames and sends them to GPT-4o, Claude, and Gemini",
      "Each model independently reports what it found: manipulation signals, authenticity signals, compression notes",
      "You get a consensus verdict and can drill into each model's evidence",
    ],
    useCases: [
      "Checking whether a video shared in a group chat is AI-generated",
      "Reviewing footage before reporting it to a platform or news outlet",
      "Understanding what AI manipulation signals look like in practice",
    ],
    cta: "Upload a video and see what 3 models find",
    category: "how-to",
    metaDescription:
      "Upload a suspicious video. 3 vision AI models check for deepfake signals, manipulation artifacts, and generation signatures. Get a structured verdict.",
  },
];

export function getPageBySlug(slug: string): PSEOPage | undefined {
  return PAGES.find((p) => p.slug === slug);
}
