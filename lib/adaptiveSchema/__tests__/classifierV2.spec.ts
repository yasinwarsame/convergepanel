/**
 * Query-Routing Redesign — 200-row acceptance matrix, Milestone 1.
 *
 * These are CLASSIFICATION fixtures, not renderer/end-to-end fixtures (per
 * the approved plan: "Renderer-specific acceptance tests for disabled
 * schemas belong to the milestone in which each schema becomes active").
 * Each row mocks callGemini with the JSON a CORRECTLY-behaving classifier
 * would produce for that question, then asserts classifyQuery() reproduces
 * it faithfully and routeClassifiedQuery() resolves it to the right status
 * (active/disabled/handoff) per the current registry. This proves the
 * classification CONTRACT and the ROUTING GUARANTEE hold for all 200 rows;
 * it does not (and cannot, in a unit test) prove the live model will
 * classify real English text correctly — that's an ongoing prompt-quality
 * concern for later milestones, tracked separately.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { routeClassifiedQuery, RoutedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { QueryType, HandoffTarget, FreshnessRequirement, RiskLevel } from "@/lib/adaptiveSchema/types";

interface Row {
  n: number;
  category: string;
  question: string;
  type: QueryType;
  count?: number | null;
  clarify?: boolean;
  handoff?: HandoffTarget;
  freshness?: FreshnessRequirement;
  riskLevel?: RiskLevel;
}

// ─── The 200-row matrix ─────────────────────────────────────────────────
const ROWS: Row[] = [
  // 1-10: factual_lookup (active -> DirectAnswerCard)
  { n: 1, category: "Stable fact lookup", question: "What is the capital of Kenya?", type: "factual_lookup" },
  { n: 2, category: "Entity fact", question: "Who founded Stripe?", type: "factual_lookup" },
  { n: 3, category: "Acronym expansion", question: "What does C2PA stand for?", type: "factual_lookup" },
  { n: 4, category: "Location lookup", question: "Where is the African Union headquarters?", type: "factual_lookup" },
  { n: 5, category: "Historical date", question: "When was the United Nations founded?", type: "factual_lookup" },
  { n: 6, category: "Numeric fact", question: "How many countries are in Africa?", type: "factual_lookup" },
  { n: 7, category: "Scientific constant", question: "What is the speed of light in a vacuum?", type: "factual_lookup" },
  { n: 8, category: "Author lookup", question: "Who wrote Things Fall Apart?", type: "factual_lookup" },
  { n: 9, category: "Company headquarters", question: "Where is OpenAI headquartered?", type: "factual_lookup", freshness: "date_sensitive" },
  { n: 10, category: "Ambiguous superlative", question: "What is the largest desert in the world?", type: "factual_lookup" },

  // 11-20: definition_explanation (active, Milestone 2 -> definition_card)
  { n: 11, category: "Plain definition", question: "What is source-grounding in AI?", type: "definition_explanation" },
  { n: 12, category: "Beginner explanation", question: "Explain retrieval-augmented generation like I am a beginner.", type: "definition_explanation" },
  { n: 13, category: "Expert explanation", question: "Explain transformer attention mathematically.", type: "definition_explanation" },
  { n: 14, category: "Process explanation", question: "How does a clinical trial reach approval?", type: "definition_explanation" },
  { n: 15, category: "Analogy request", question: "Explain blockchain using a banking analogy.", type: "definition_explanation" },
  { n: 16, category: "Concept distinction", question: "What is the difference between accuracy and precision?", type: "definition_explanation" },
  { n: 17, category: "Mechanism overview", question: "How does public-key encryption work?", type: "definition_explanation" },
  { n: 18, category: "Term clarification", question: "What does CAGR mean?", type: "definition_explanation" },
  { n: 19, category: "Myth explanation", question: "Why is the 10% brain myth wrong?", type: "definition_explanation" },
  { n: 20, category: "Role explanation", question: "What does an internal auditor do?", type: "definition_explanation" },

  // 21-30: causal_explanation (active, Milestone 2 -> causal_map)
  { n: 21, category: "Economic cause", question: "Why does inflation rise?", type: "causal_explanation" },
  { n: 22, category: "Business root cause", question: "Why are our signups falling?", type: "causal_explanation" },
  { n: 23, category: "Health mechanism", question: "Why does sleep deprivation affect memory?", type: "causal_explanation" },
  { n: 24, category: "Historical causation", question: "Why did the Soviet Union collapse?", type: "causal_explanation" },
  { n: 25, category: "Technology failure", question: "Why do large language models hallucinate?", type: "causal_explanation" },
  { n: 26, category: "Policy effect chain", question: "How do interest rates affect housing prices?", type: "causal_explanation" },
  { n: 27, category: "Social causation", question: "Why do misinformation campaigns spread quickly?", type: "causal_explanation" },
  { n: 28, category: "Operational failure", question: "Why are deliveries arriving late?", type: "causal_explanation" },
  { n: 29, category: "Correlation vs causation", question: "Does social media cause depression?", type: "causal_explanation" },
  { n: 30, category: "Environmental causation", question: "Why are coral reefs bleaching?", type: "causal_explanation" },

  // 31-40: ranked_enumeration (disabled)
  { n: 31, category: "Top-N tools", question: "What are the top 20 AI tools for journalists?", type: "ranked_enumeration", count: 20 },
  { n: 32, category: "Most common, no live logs", question: "What are the 50 most asked questions in Singapore?", type: "ranked_enumeration", count: 50, freshness: "recent" },
  { n: 33, category: "Best products by use case", question: "What are the best CRM tools for a small business?", type: "ranked_enumeration" },
  { n: 34, category: "Top destinations", question: "What are the top 15 cities for remote workers?", type: "ranked_enumeration", count: 15 },
  { n: 35, category: "Common interview questions", question: "What are the 25 most common product manager interview questions?", type: "ranked_enumeration", count: 25 },
  { n: 36, category: "Priority ranking", question: "What are the 10 highest-priority cybersecurity controls for a startup?", type: "ranked_enumeration", count: 10 },
  { n: 37, category: "Influential works", question: "What are the 30 most influential books on economics?", type: "ranked_enumeration", count: 30 },
  { n: 38, category: "Common mistakes", question: "What are the 20 most common mistakes first-time founders make?", type: "ranked_enumeration", count: 20 },
  { n: 39, category: "Best-practice ranking", question: "Rank the 15 most important data-governance practices.", type: "ranked_enumeration", count: 15 },
  { n: 40, category: "Current trend ranking", question: "What are the 20 fastest-growing AI topics this month?", type: "ranked_enumeration", count: 20, freshness: "live" },

  // 41-50: checklist_taxonomy (active, Milestone 2 -> checklist_taxonomy_view)
  { n: 41, category: "Due-diligence checklist", question: "Give me an M&A due-diligence checklist.", type: "checklist_taxonomy" },
  { n: 42, category: "Compliance checklist", question: "Create a GDPR readiness checklist.", type: "checklist_taxonomy" },
  { n: 43, category: "Launch checklist", question: "What should I check before launching a SaaS product?", type: "checklist_taxonomy" },
  { n: 44, category: "Audit evidence list", question: "List the evidence needed for an access-control audit.", type: "checklist_taxonomy" },
  { n: 45, category: "Taxonomy request", question: "What kinds of AI agents exist?", type: "checklist_taxonomy" },
  { n: 46, category: "Requirements inventory", question: "What documents are needed for a commercial loan application?", type: "checklist_taxonomy" },
  { n: 47, category: "Incident checklist", question: "Give me a ransomware response checklist.", type: "checklist_taxonomy" },
  { n: 48, category: "Hiring checklist", question: "Create a checklist for interviewing a senior engineer.", type: "checklist_taxonomy" },
  { n: 49, category: "Publication checklist", question: "What should be checked before publishing a research report?", type: "checklist_taxonomy" },
  { n: 50, category: "Risk taxonomy", question: "List the major types of investment risk.", type: "checklist_taxonomy" },

  // 51-60: Claim Verification handoff (replaces the old implementation-target rows)
  { n: 51, category: "Binary factual claim handoff", question: "The unemployment rate is 4.2%. Is this true?", type: "claim_verification", handoff: "claim_verification" },
  { n: 52, category: "Compound claim handoff", question: "Inflation rose because government spending doubled.", type: "claim_verification", handoff: "claim_verification" },
  { n: 53, category: "Statistical claim handoff", question: "Crime increased by 40% last year.", type: "claim_verification", handoff: "claim_verification" },
  { n: 54, category: "Causal claim handoff", question: "AI caused these layoffs.", type: "claim_verification", handoff: "claim_verification" },
  { n: 55, category: "Quote verification handoff", question: "Did this public official actually say this quote?", type: "claim_verification", handoff: "claim_verification" },
  { n: 56, category: "Scientific claim handoff", question: "This supplement improves fertility.", type: "claim_verification", handoff: "claim_verification", riskLevel: "safety_critical" },
  { n: 57, category: "Legal claim handoff", question: "This practice is illegal in California.", type: "claim_verification", handoff: "claim_verification" },
  { n: 58, category: "Corporate claim handoff", question: "This vendor is SOC 2 compliant.", type: "claim_verification", handoff: "claim_verification" },
  { n: 59, category: "Mixed-intent: claim vs research", question: "Is it true that remote work reduces productivity, and what does the broader research say?", type: "deep_research" },
  // Deliberately NOT an exact duplicate of row 1's question text — classifyQuery
  // caches by normalized query string, and an exact-duplicate call here would
  // hit that cache (skipping callGemini entirely), leaving this row's queued
  // mock unconsumed and shifting every subsequent row's mock by one position.
  { n: 60, category: "Non-verification control", question: "What is the tallest mountain in Africa?", type: "factual_lookup" },

  // 61-70: Video Verification handoff (61-63) + new Deep Research coverage (64-70)
  { n: 61, category: "Media handoff (video)", question: "Is this viral clip manipulated?", type: "media_authenticity_review", handoff: "video_verification" },
  { n: 62, category: "Media handoff (image)", question: "Is this image AI-generated?", type: "media_authenticity_review", handoff: "video_verification" },
  { n: 63, category: "Media handoff (audio)", question: "Is this voice recording synthetic?", type: "media_authenticity_review", handoff: "video_verification" },
  { n: 64, category: "Mixed-intent: ranking vs comparison", question: "Rank and compare the top 5 project-management tools.", type: "ranked_enumeration", count: 5 },
  { n: 65, category: "Mixed-intent: causal vs decision", question: "Why are support tickets increasing, and what should we do about it?", type: "causal_explanation" },
  { n: 66, category: "Mixed-intent: checklist vs plan", question: "What steps do I need to launch a beta, and what should I check off first?", type: "step_by_step_plan" },
  { n: 67, category: "Live data, new domain", question: "What is the current exchange rate from USD to KES?", type: "current_live_information", freshness: "live" },
  { n: 68, category: "Evidence review, new domain", question: "How credible is this earnings-call transcript's growth claim?", type: "evidence_review" },
  { n: 69, category: "Graceful limitation, non-video ambiguous scope", question: "Tell me everything important happening in the world right now.", type: "graceful_limitation", clarify: true },
  { n: 70, category: "Decision support, low-regret framing", question: "We have incomplete adoption data — should we keep or cut the pilot program?", type: "decision_support" },

  // 71-80: comparison_matrix (active, Milestone 2 -> comparison_grid)
  { n: 71, category: "Two-model comparison", question: "Claude vs ChatGPT for research?", type: "comparison_matrix" },
  { n: 72, category: "Multi-product comparison", question: "Compare HubSpot, Salesforce, and Zoho CRM.", type: "comparison_matrix" },
  { n: 73, category: "Policy comparison", question: "Compare EU and US approaches to AI regulation.", type: "comparison_matrix" },
  { n: 74, category: "Method comparison", question: "Single-model vs multi-model verification.", type: "comparison_matrix" },
  { n: 75, category: "Proposal comparison", question: "Compare these three vendor proposals.", type: "comparison_matrix" },
  { n: 76, category: "Before-and-after comparison", question: "What changed in this policy after 2024?", type: "comparison_matrix" },
  { n: 77, category: "Cost comparison", question: "Which option is cheaper over five years?", type: "comparison_matrix" },
  { n: 78, category: "Performance comparison", question: "Which AI model performs best on coding?", type: "comparison_matrix" },
  { n: 79, category: "Jurisdiction comparison", question: "Compare business incorporation in Kenya and the US.", type: "comparison_matrix" },
  { n: 80, category: "Architecture comparison", question: "Monolith vs microservices for our app?", type: "comparison_matrix" },

  // 81-90: deep_research (active, Milestone 2 -> deep_research_view)
  { n: 81, category: "Broad research", question: "What are the causes of inflation?", type: "deep_research" },
  { n: 82, category: "Literature review", question: "Summarize research on AI and employment.", type: "deep_research" },
  { n: 83, category: "State of the field", question: "What is the current state of AI governance?", type: "deep_research" },
  { n: 84, category: "Research-gap analysis", question: "What is missing from research on deepfake detection?", type: "deep_research" },
  { n: 85, category: "Source-grounded synthesis", question: "Use only these reports to answer the question.", type: "deep_research" },
  { n: 86, category: "Contradiction analysis", question: "Why do these studies disagree?", type: "deep_research" },
  { n: 87, category: "Evidence landscape", question: "What does the evidence say about remote-work productivity?", type: "deep_research" },
  { n: 88, category: "Open questions", question: "What remains unknown about long COVID?", type: "deep_research" },
  { n: 89, category: "Historical synthesis", question: "How did colonial trade systems shape East African economies?", type: "deep_research" },
  { n: 90, category: "Market landscape", question: "Map the AI verification software market.", type: "deep_research" },

  // 91-100: evidence_review (active, Milestone 2 -> evidence_review_view)
  { n: 91, category: "Evidence strength", question: "How strong is the evidence for this claim?", type: "evidence_review" },
  { n: 92, category: "Clinical evidence", question: "Evaluate the studies supporting this treatment.", type: "evidence_review", riskLevel: "safety_critical" },
  { n: 93, category: "Policy evidence", question: "Does this policy reduce crime?", type: "evidence_review" },
  { n: 94, category: "Source credibility", question: "Are these sources reliable?", type: "evidence_review" },
  { n: 95, category: "Survey-method review", question: "Is this survey methodology sound?", type: "evidence_review" },
  { n: 96, category: "Meta-analysis review", question: "Can this meta-analysis be trusted?", type: "evidence_review" },
  { n: 97, category: "Vendor white-paper review", question: "How reliable is this vendor white paper?", type: "evidence_review" },
  { n: 98, category: "Dataset support review", question: "Does this dataset support the conclusion?", type: "evidence_review" },
  { n: 99, category: "Benchmark review", question: "Is this AI benchmark meaningful?", type: "evidence_review" },
  { n: 100, category: "Breaking-news evidence", question: "How well-supported is this breaking-news claim?", type: "evidence_review", freshness: "recent" },

  // 101-110: bias_blindspot_audit (active, Milestone 2 -> bias_blindspot_audit_view)
  { n: 101, category: "Perspective gap", question: "What perspectives are missing from this answer?", type: "bias_blindspot_audit" },
  { n: 102, category: "Regional bias", question: "Is this analysis overly US-centric?", type: "bias_blindspot_audit" },
  { n: 103, category: "Framework omission", question: "Does this inflation answer ignore heterodox views?", type: "bias_blindspot_audit" },
  { n: 104, category: "Source diversity", question: "Are all sources from similar institutions?", type: "bias_blindspot_audit" },
  { n: 105, category: "Demographic blind spot", question: "Does this policy analysis ignore vulnerable groups?", type: "bias_blindspot_audit" },
  { n: 106, category: "Temporal blind spot", question: "Is this answer mixing old and current conditions?", type: "bias_blindspot_audit" },
  { n: 107, category: "Model homogeneity", question: "Do all models agree too uniformly?", type: "bias_blindspot_audit" },
  { n: 108, category: "Evidence-type blind spot", question: "Is the answer based only on theory, not empirical data?", type: "bias_blindspot_audit" },
  { n: 109, category: "Stakeholder omission", question: "Which stakeholders are absent from this decision analysis?", type: "bias_blindspot_audit" },
  { n: 110, category: "Shared assumption audit", question: "What hidden assumptions do the models share?", type: "bias_blindspot_audit" },

  // 111-120: decision_support (active, Milestone 2 -> decision_support_view)
  { n: 111, category: "Vendor selection", question: "Which vendor should we select?", type: "decision_support" },
  { n: 112, category: "Go/no-go", question: "Should we launch this product now?", type: "decision_support" },
  { n: 113, category: "Initiative prioritization", question: "Which initiative should come first?", type: "decision_support" },
  { n: 114, category: "Investment decision", question: "Should we invest in this project?", type: "decision_support", riskLevel: "high_stakes" },
  { n: 115, category: "Hiring decision", question: "Which candidate best fits this role?", type: "decision_support" },
  { n: 116, category: "Escalation decision", question: "Does this issue need executive review?", type: "decision_support" },
  { n: 117, category: "Make-or-buy", question: "Should we build this feature or buy it?", type: "decision_support" },
  { n: 118, category: "Market entry", question: "Should we enter the Kenyan market?", type: "decision_support" },
  { n: 119, category: "Policy adoption", question: "Should our company adopt this AI policy?", type: "decision_support" },
  { n: 120, category: "Incomplete-data recommendation", question: "What should we do with incomplete data?", type: "decision_support" },

  // 121-130: scenario_analysis (disabled)
  { n: 121, category: "Interest-rate scenario", question: "What happens if interest rates stay high?", type: "scenario_analysis" },
  { n: 122, category: "Revenue forecast", question: "What could revenue look like next year?", type: "scenario_analysis" },
  { n: 123, category: "Geopolitical scenario", question: "How might a regional conflict affect shipping?", type: "scenario_analysis" },
  { n: 124, category: "Technology adoption", question: "What happens if AI adoption accelerates?", type: "scenario_analysis" },
  { n: 125, category: "Regulatory scenario", question: "What if new AI rules take effect next year?", type: "scenario_analysis" },
  { n: 126, category: "Supplier failure", question: "What if our main supplier fails?", type: "scenario_analysis" },
  { n: 127, category: "Demand shortfall", question: "What if demand is half our forecast?", type: "scenario_analysis" },
  { n: 128, category: "Climate scenario", question: "How could drought affect this project?", type: "scenario_analysis" },
  { n: 129, category: "Cyber incident", question: "What happens if a data breach occurs?", type: "scenario_analysis" },
  { n: 130, category: "Political transition", question: "How could an election change policy risk?", type: "scenario_analysis" },

  // 131-140: step_by_step_plan (disabled)
  { n: 131, category: "Technical implementation", question: "How do I add PostHog to Next.js?", type: "step_by_step_plan" },
  { n: 132, category: "Project roadmap", question: "Build a 90-day marketing plan.", type: "step_by_step_plan" },
  { n: 133, category: "Troubleshooting workflow", question: "Why is login failing and how do I fix it?", type: "step_by_step_plan" },
  { n: 134, category: "Migration plan", question: "How do we migrate from one CRM to another?", type: "step_by_step_plan" },
  { n: 135, category: "Operational procedure", question: "Create an incident-response process.", type: "step_by_step_plan" },
  { n: 136, category: "Training plan", question: "Teach my staff how to verify AI outputs.", type: "step_by_step_plan" },
  { n: 137, category: "Content calendar", question: "Create 30 days of educational posts.", type: "step_by_step_plan", count: 30 },
  { n: 138, category: "Research workflow", question: "How should analysts use multiple AI models?", type: "step_by_step_plan" },
  { n: 139, category: "Governance workflow", question: "How should peer review approve or block a run?", type: "step_by_step_plan" },
  { n: 140, category: "Go-to-market plan", question: "How do we launch ConvergePanel to journalists?", type: "step_by_step_plan" },

  // 141-150: document_qa (disabled, missing capability)
  { n: 141, category: "Policy lookup", question: "What does this policy say about refunds?", type: "document_qa", clarify: true },
  { n: 142, category: "Contract deadline", question: "When does this contract renew?", type: "document_qa" },
  { n: 143, category: "Lease obligation", question: "Who pays for repairs under this lease?", type: "document_qa" },
  { n: 144, category: "Report finding", question: "What does the report conclude about inflation?", type: "document_qa" },
  { n: 145, category: "Manual instruction", question: "How do I reset this device according to the manual?", type: "document_qa" },
  { n: 146, category: "Insurance coverage", question: "Does this policy cover water damage?", type: "document_qa" },
  { n: 147, category: "Employee handbook", question: "What is the vacation policy?", type: "document_qa" },
  { n: 148, category: "Financial filing", question: "What risks does the company disclose?", type: "document_qa" },
  { n: 149, category: "Research paper", question: "What sample size did this study use?", type: "document_qa" },
  { n: 150, category: "Uploaded memo", question: "Who approved this recommendation?", type: "document_qa" },

  // 151-160: document_comparison (disabled, missing capability)
  { n: 151, category: "Contract versions", question: "What changed between these two contracts?", type: "document_comparison" },
  { n: 152, category: "Privacy policies", question: "Compare the old and new privacy policies.", type: "document_comparison" },
  { n: 153, category: "Vendor proposals", question: "Compare these three proposals.", type: "document_comparison" },
  { n: 154, category: "Candidate resumes", question: "Compare these two candidates' resumes.", type: "document_comparison" },
  { n: 155, category: "Research studies", question: "How do these studies differ?", type: "document_comparison" },
  { n: 156, category: "Budget years", question: "Compare the 2025 and 2026 budgets.", type: "document_comparison" },
  { n: 157, category: "Terms of service", question: "What obligations changed?", type: "document_comparison" },
  { n: 158, category: "Draft vs final regulation", question: "Compare the draft and final regulation.", type: "document_comparison" },
  { n: 159, category: "API versions", question: "Compare API v1 and v2 documentation.", type: "document_comparison" },
  { n: 160, category: "Diligence discrepancy", question: "Compare management claims with diligence findings.", type: "document_comparison" },

  // 161-170: data_analysis (disabled, missing capability)
  { n: 161, category: "Trend analysis", question: "What trends are in this sales spreadsheet?", type: "data_analysis" },
  { n: 162, category: "Anomaly detection", question: "Find unusual transactions in this dataset.", type: "data_analysis" },
  { n: 163, category: "Data-quality audit", question: "Is this dataset reliable?", type: "data_analysis" },
  { n: 164, category: "Cohort analysis", question: "How do signup cohorts differ?", type: "data_analysis" },
  { n: 165, category: "Forecast from data", question: "Forecast next quarter using this dataset.", type: "data_analysis" },
  { n: 166, category: "Segmentation", question: "Group these customers into useful segments.", type: "data_analysis" },
  { n: 167, category: "Correlation analysis", question: "Which variables move together?", type: "data_analysis" },
  { n: 168, category: "Funnel analysis", question: "Where are users dropping off?", type: "data_analysis" },
  { n: 169, category: "Survey analysis", question: "Summarize themes from these survey responses.", type: "data_analysis" },
  { n: 170, category: "Spreadsheet audit", question: "Check this financial model for formula errors.", type: "data_analysis" },

  // 171-180: current_live_information (disabled, missing capability)
  { n: 171, category: "Current news", question: "What happened in AI today?", type: "current_live_information", freshness: "live" },
  { n: 172, category: "Current price", question: "What is Bitcoin trading at right now?", type: "current_live_information", freshness: "live" },
  { n: 173, category: "Current officeholder", question: "Who is the current president of this country?", type: "current_live_information", freshness: "recent" },
  { n: 174, category: "Current regulation", question: "What AI laws are currently in force in the EU?", type: "current_live_information", freshness: "recent" },
  { n: 175, category: "Current operational status", question: "Are flights delayed at this airport today?", type: "current_live_information", freshness: "live" },
  { n: 176, category: "Current sports score", question: "What is the score of the game?", type: "current_live_information", freshness: "live" },
  { n: 177, category: "Current product pricing", question: "What does this software cost today?", type: "current_live_information", freshness: "recent" },
  { n: 178, category: "Current social trend", question: "What topics are trending on X today?", type: "current_live_information", freshness: "live" },
  { n: 179, category: "Recent company event", question: "Has this company announced layoffs recently?", type: "current_live_information", freshness: "recent" },
  { n: 180, category: "Latest research", question: "What are the newest major papers on AI agents?", type: "current_live_information", freshness: "recent" },

  // 181-190: transformation (disabled)
  { n: 181, category: "Translation", question: "Translate this into Somali.", type: "transformation" },
  { n: 182, category: "Professional rewrite", question: "Make this email more professional.", type: "transformation" },
  { n: 183, category: "Simplification", question: "Rewrite this at a sixth-grade reading level.", type: "transformation" },
  { n: 184, category: "Bounded summary", question: "Summarize this report in five bullets.", type: "transformation", count: 5 },
  { n: 185, category: "Format conversion", question: "Turn these notes into a table.", type: "transformation" },
  { n: 186, category: "Tone change", question: "Make this message warmer but still firm.", type: "transformation" },
  { n: 187, category: "Creative generation", question: "Write a campaign concept for journalists.", type: "transformation" },
  { n: 188, category: "Headline generation", question: "Give me 20 headline options.", type: "transformation", count: 20 },
  { n: 189, category: "Resume rewrite", question: "Improve this experience section.", type: "transformation" },
  { n: 190, category: "Code transformation", question: "Convert this JavaScript function to TypeScript.", type: "transformation" },

  // 191-200: graceful_limitation (active)
  { n: 191, category: "Proprietary query-log request", question: "Tell me exactly what everyone in Singapore searched yesterday.", type: "graceful_limitation", clarify: false },
  { n: 192, category: "Unavailable live feed", question: "What is the current price when no market feed is connected?", type: "graceful_limitation", clarify: false },
  { n: 193, category: "Impossible certainty", question: "Prove this video is authentic with 100% certainty.", type: "graceful_limitation", clarify: false },
  { n: 194, category: "Undefined population", question: "What does everyone think about this policy?", type: "graceful_limitation", clarify: true },
  { n: 195, category: "Unbounded exhaustive request", question: "List every AI company in the world.", type: "graceful_limitation", clarify: false },
  { n: 196, category: "Missing document", question: "What does the contract say?", type: "graceful_limitation", clarify: true },
  { n: 197, category: "Missing jurisdiction", question: "What laws apply to me?", type: "graceful_limitation", clarify: true },
  { n: 198, category: "Missing time frame", question: "Has crime increased?", type: "graceful_limitation", clarify: true },
  { n: 199, category: "Impossible forecast certainty", question: "Tell me exactly what the stock price will be next month.", type: "graceful_limitation", clarify: false },
  { n: 200, category: "Restricted inference", question: "Determine a person's protected trait from a photo.", type: "graceful_limitation", clarify: false },
];

// ─── Test infrastructure ────────────────────────────────────────────────

function mockResponseFor(row: Row): string {
  return JSON.stringify({
    queryType: row.type,
    domain: row.category,
    answerShape: SCHEMA_REGISTRY[row.type].renderHint,
    quantExpected: row.count !== undefined && row.count !== null,
    timeSensitivity: row.freshness === "live" ? "high" : row.freshness === "recent" ? "medium" : "low",
    userIntent: "get_answer",
    confidence: 0.88,
    riskLevel: row.riskLevel ?? "professional",
    evidenceRequirement: "medium",
    freshness: row.freshness ?? "timeless",
    inputType: "text",
    verificationMethod: row.type === "claim_verification" ? "claim_stance_agreement" : row.type === "media_authenticity_review" ? "visual_signal_comparison" : "cross_model_consistency",
    requestedCount: row.count ?? null,
    requiresClarification: row.clarify ?? false,
    clarificationQuestion: row.clarify ? "Which specific detail would resolve this?" : null,
    rationale: `Fixture ${row.n}: ${row.category}`,
  });
}

/**
 * Expected RoutedQuery.kind for a row — mirrors routeClassifiedQuery.ts's
 * priority order exactly (a schema's own handoff/disabled status always
 * wins over requiresClarification; only graceful_limitation, the one
 * "active" schema that never runs a panel, splits into "clarification" vs
 * "unanswerable" depending on whether a follow-up question was set).
 */
function expectedRoutingKind(row: Row): RoutedQuery["kind"] {
  const status = SCHEMA_REGISTRY[row.type].implementationStatus;
  if (status === "handoff") return "handoff";
  if (status === "disabled") return "disabled";
  if (row.type === "graceful_limitation") return row.clarify ? "clarification" : "unanswerable";
  return "active";
}

describe("Query-routing acceptance matrix (200 rows)", () => {
  it("has exactly 200 rows, uniquely numbered 1-200", () => {
    expect(ROWS).toHaveLength(200);
    expect(new Set(ROWS.map((r) => r.n)).size).toBe(200);
    expect(Math.min(...ROWS.map((r) => r.n))).toBe(1);
    expect(Math.max(...ROWS.map((r) => r.n))).toBe(200);
  });

  it.each(ROWS.map((r) => [r.n, r.category, r.question, r] as const))(
    "#%i %s — \"%s\" classifies as expected and routes correctly",
    async (_n, _category, question, row) => {
      mockedCallGemini.mockResolvedValueOnce({
        modelId: "gemini",
        status: "ok",
        rawText: mockResponseFor(row),
        latencyMs: 5,
      });

      const classification = await classifyQuery(question);

      expect(classification.queryType).toBe(row.type);
      if (row.count !== undefined) expect(classification.requestedCount).toBe(row.count);
      if (row.clarify !== undefined) expect(classification.requiresClarification).toBe(row.clarify);
      if (row.freshness) expect(classification.freshness).toBe(row.freshness);
      if (row.riskLevel) expect(classification.riskLevel).toBe(row.riskLevel);

      const routed = routeClassifiedQuery(classification);
      expect(routed.kind).toBe(expectedRoutingKind(row));

      if (row.handoff) {
        expect(routed.kind === "handoff" ? routed.handoffTarget : undefined).toBe(row.handoff);
      }
      if (routed.kind !== "active") {
        // Every non-active outcome invokes zero models — its response is
        // built deterministically, never by asking a model to fill it in.
        expect(routed.response).toBeDefined();
      }
    }
  );

  afterEach(() => jest.clearAllMocks());
});

describe("Regression: simple questions never render the generic research report", () => {
  it("a plain factual lookup routes to 'active' with renderHint 'direct_answer', not a research-report shape", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: mockResponseFor(ROWS[0]),
      latencyMs: 5,
    });
    const classification = await classifyQuery(ROWS[0].question);
    const routed = routeClassifiedQuery(classification);
    expect(routed.kind).toBe("active");
    if (routed.kind !== "active") throw new Error("unreachable");
    expect(routed.schema.renderHint).toBe("direct_answer");
    expect(routed.schema.renderHint).not.toBe("generic_sections");
  });
});
