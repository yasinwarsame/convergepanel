/**
 * Privacy Policy accuracy pins (R4 Track C, R4o).
 *
 * Three parts that must move together:
 *  1. CODE FACTS — what the live code (cabbdbb) actually does with questions,
 *     attachments, context, answers, audit rows and telemetry. Each fact is
 *     registered under an id with `fact(id, …)`. If one fails, the CODE changed:
 *     re-check the policy text before updating the test.
 *  2. CLOSED-WORLD POLICY TEXT — every sentence the page renders must appear,
 *     verbatim, in APPROVED_SENTENCES, tagged with the fact that backs it. An
 *     added, removed, narrowed or reworded sentence fails. "code:<id>" tags must
 *     name a registered code fact; "owner:PP-nn" marks a statement that is still
 *     OPEN on the owner/legal checklist; "trace:<x>" points at the provider-input
 *     trace; "reviewed" marks text checked by earlier independent reviews but not
 *     pinned to code here.
 *  3. PLACEHOLDERS — the unresolved legal placeholders, so none can be filled in
 *     silently (owner/legal checklist 12-…-completion-checklist.md).
 */
import fs from "fs";
import nodePath from "path";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";

const mockCallGemini = jest.fn();
jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: (...args: unknown[]) => mockCallGemini(...args),
}));

import PrivacyPage from "@/app/privacy/page";
import { planAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { authoritativeSynthesisInputs } from "@/lib/synthesis/authoritativeRunInputs";
import { splitQuestionAndContext } from "@/lib/questionContext";

const ROOT = nodePath.resolve(__dirname, "../../..");
const src = (rel: string) => fs.readFileSync(nodePath.join(ROOT, rel), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function renderedText(): string {
  const html = renderToStaticMarkup(PrivacyPage());
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every sentence the page renders (headings excluded), in order. */
function policySentences(): string[] {
  const html = renderToStaticMarkup(PrivacyPage());
  const text = decode(
    html
      .replace(/<h[12]\b[^>]*>[\s\S]*?<\/h[12]>/g, "\n")
      .replace(/<\/?(p|li|ul|section|div|main)\b[^>]*>/g, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z"\[(])/));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(nodePath.join(ROOT, dir), { withFileTypes: true })) {
    const rel = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const REGISTERED_FACTS = new Set<string>();
/** A code-derived fact: registered at collection time, so the closed-world table can require it. */
function fact(id: string, name: string, fn: () => unknown) {
  REGISTERED_FACTS.add(id);
  it(`[code:${id}] ${name}`, fn as jest.ProvidesCallback);
}

/**
 * The REAL research-tab attach handler from app/page.tsx, extracted from the
 * source and executed (no copy of its logic lives in this test). Returns the
 * textarea value after attaching `fileText` to a box that held `prev`.
 */
function runResearchAttach(prev: string, fileText: string): string {
  const page = src("app/page.tsx");
  const start = page.indexOf("{/* File attach — Research tab */}");
  const end = page.indexOf("{/* File attach — Verify tab", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = page.slice(start, end);
  const open = block.indexOf("onExtracted={");
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  let close = -1;
  for (let i = open + "onExtracted=".length; i < block.length; i++) {
    if (block[i] === "{") depth++;
    else if (block[i] === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  expect(close).toBeGreaterThan(open);
  const handlerSource = block.slice(open + "onExtracted={".length, close);
  const js = ts.transpileModule(`const __handler = ${handlerSource};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let value = prev;
  const setQuestion = (u: string | ((p: string) => string)) => {
    value = typeof u === "function" ? u(value) : u;
  };
  const make = new Function("setQuestion", "setResearchAttachedFile", "setError", `${js}; return __handler;`);
  const handler = make(setQuestion, () => undefined, () => undefined) as (text: string, fileName: string) => void;
  handler(fileText, "attached.txt");
  return value;
}

/** What run-panel does with the textarea before the Gemini classifier (route.ts:210-211, :234). */
async function geminiCallsForResearchInput(textarea: string) {
  mockCallGemini.mockReset();
  mockCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, latencyMs: 0 });
  const { question, context } = splitQuestionAndContext(textarea);
  await planAdaptiveRun(question.trim(), ["chatgpt", "claude"], context);
  return mockCallGemini.mock.calls;
}

const FILE_SENTINEL = "PRIVPOL_ATTACHED_FILE_SENTINEL";
const FILE_TEXT = `Quarterly report.\n${FILE_SENTINEL} revenue rose 4%.`;

describe("code facts", () => {
  // Every callGemini call site outside the connector itself, with its exact
  // first argument. The second argument (context) must be the literal `null`.
  const GEMINI_AUX_CALLERS: Record<string, string[]> = {
    "lib/adaptiveSchema/classifier.ts": ["trimmedQuery"],
    "lib/adaptiveSchema/alignment.ts": ["userMessage", "userMessage"],
    "lib/adaptiveSchema/biasDetection.ts": ['`Question: "${question}"\\n\\n${responsesBlock}`'],
    "lib/adaptiveSchema/coverageAudit.ts": ["userMessage"],
    "lib/adaptiveSchema/synthesisReport.ts": ["userMessage"],
  };

  fact("gemini-aux", "the only callGemini callers are the five auxiliary modules, and each passes a null context", () => {
    const callers = [...walk("lib"), ...walk("app")].filter(
      (f) => f !== "lib/connectors/gemini.ts" && src(f).includes("callGemini(")
    );
    expect(callers.sort()).toEqual(Object.keys(GEMINI_AUX_CALLERS).sort());
    for (const [file, firstArgs] of Object.entries(GEMINI_AUX_CALLERS)) {
      const text = src(file);
      expect(count(text, "callGemini(")).toBe(firstArgs.length);
      for (const firstArg of new Set(firstArgs)) {
        expect(count(text, `callGemini(${firstArg}, null, GEMINI_API_KEY`)).toBe(firstArgs.filter((a) => a === firstArg).length);
      }
    }
  });

  fact("gemini-aux", "both research routes classify the split question (not the raw text) and pass the context only as the third argument", () => {
    for (const route of ["app/api/run-panel/route.ts", "app/api/workspaces/[workspaceId]/runs/route.ts"]) {
      const text = src(route);
      expect(text).toContain("const { question: parsedQuestion, context } = splitQuestionAndContext(question);");
      expect(text).toContain("const trimmedQuestion = parsedQuestion.trim();");
      expect(text).toContain("planAdaptiveRun(trimmedQuestion, selectedModels as ModelId[], context)");
    }
    // The question the post-run Gemini steps receive is that same trimmedQuestion.
    expect(src("lib/runPanelExecution.ts")).toMatch(/finalizeAdaptiveRun\(\s*adaptivePlan\.schema,\s*results,\s*trimmedQuestion,/);
  });

  fact("gemini-aux", "classification sends the question to Gemini without a separate context", async () => {
    const calls = await geminiCallsForResearchInput("Why did inflation persist after 2021? PRIVPOL_QUESTION_SENTINEL\n\nContext:\nPRIVPOL_CONTEXT_SENTINEL");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain("PRIVPOL_CONTEXT_SENTINEL");
      expect(call[1]).toBeNull();
    }
    expect(calls.some((c) => String(c[0]).includes("PRIVPOL_QUESTION_SENTINEL"))).toBe(true);
  });

  fact("split", "with no \"Context:\" line the whole text is the question and there is no context", () => {
    const raw = `First line.\n${FILE_SENTINEL}\nMore text.`;
    expect(splitQuestionAndContext(raw)).toEqual({ question: raw.trim(), context: null });
  });

  fact("split", "text after the first line starting with \"Context:\" (any case, leading spaces ignored) is the context", () => {
    expect(splitQuestionAndContext("Q here\n  context: C1\nmore\nContext: C2")).toEqual({
      question: "Q here",
      context: "context: C1\nmore\nContext: C2",
    });
  });

  fact("split", "text that begins with a \"Context:\" line is treated as the question AND as context", () => {
    const raw = `Context:\n${FILE_SENTINEL} body`;
    const { question, context } = splitQuestionAndContext(raw);
    expect(question).toBe(raw);
    expect(context).toBe(raw);
  });

  fact("attach", "attaching to an EMPTY research box puts the file text in the box with no \"Context:\" line", () => {
    expect(runResearchAttach("", FILE_TEXT)).toBe(FILE_TEXT);
    expect(runResearchAttach("   \n ", FILE_TEXT)).toBe(FILE_TEXT);
  });

  fact("attach", "attaching after a typed question appends the file text under a \"Context:\" line", () => {
    expect(runResearchAttach("Is revenue up?", FILE_TEXT)).toBe(`Is revenue up?\n\nContext:\n${FILE_TEXT}`);
    // A leading "Context:" in the file is not doubled.
    expect(runResearchAttach("Is revenue up?", `Context: ${FILE_TEXT}`)).toBe(`Is revenue up?\n\nContext:\n${FILE_TEXT}`);
  });

  fact("attach", "attached-file text reaches the Gemini classifier when the box was empty, and not when a question was typed", async () => {
    const emptyBox = await geminiCallsForResearchInput(runResearchAttach("", FILE_TEXT));
    expect(emptyBox.some((c) => String(c[0]).includes(FILE_SENTINEL))).toBe(true);
    const typed = await geminiCallsForResearchInput(runResearchAttach("Is revenue up?", FILE_TEXT));
    expect(typed.length).toBeGreaterThan(0);
    for (const call of typed) expect(JSON.stringify(call)).not.toContain(FILE_SENTINEL);
  });

  fact("attach", "attached files are read in the browser: no network call in the extractor, same-origin PDF worker", () => {
    const extractor = src("lib/client/extractFileText.ts");
    expect(extractor).not.toMatch(/\bfetch\(|XMLHttpRequest|axios/);
    expect(extractor).toContain("return `/vendor/pdfjs/${version}/pdf.worker.min.mjs`;");
    const button = src("components/FileAttachButton.tsx");
    expect(button).toContain('import { extractFileText, isFileSupported } from "@/lib/client/extractFileText";');
    expect(button).not.toMatch(/\bfetch\(/);
  });

  fact("synthesis", "synthesis receives the question together with the persisted context", () => {
    const result = authoritativeSynthesisInputs({
      question: "Q",
      questionContext: "Context:\nPRIVPOL_CONTEXT_SENTINEL",
      runDocument: {
        question: "Q",
        perModel: [
          { modelId: "chatgpt", status: "ok", rawTextTruncated: "answer one" },
          { modelId: "claude", status: "ok", rawTextTruncated: "answer two" },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toContain("PRIVPOL_CONTEXT_SENTINEL");
    expect(result.value.rows.map((r) => r.text)).toEqual(["answer one", "answer two"]);
  });

  fact("synthesis", "synthesis sends that question to OpenAI, with Anthropic as the fallback, and never to Gemini", () => {
    const route = src("app/api/synthesize-panel/route.ts");
    expect(route).toContain("const question = authoritative.value.question;");
    expect(route).toContain('import OpenAI from "openai";');
    expect(route).toContain('import Anthropic from "@anthropic-ai/sdk";');
    expect(route).toContain("callClaudeFallback(fullPrompt");
    expect((route.match(/\$\{question\.trim\(\)\}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(route).not.toMatch(/callGemini|connectors\/gemini|GEMINI_API_KEY/);
  });

  fact("deepseek", "the DeepSeek fallback receives the question and the context", () => {
    expect(src("lib/panel.ts")).toContain("callDeepSeek(question, modelId, dsKey, context)");
  });

  fact("paid-audit", "governance evaluation audit rows: paid plans only; 200-char excerpt, account ID, and the email stored on the record", () => {
    const text = src("lib/governance/evaluateAndStore.ts");
    expect(text).toContain('if (entitlements.planId === "free") {\n      return null;');
    expect(text).toContain('question: (params.input.question || "").substring(0, 200),');
    expect(text).toContain("runOwnerUid: ownerUid,");
    expect(count(text, 'const runOwnerEmail = typeof parentData.userEmail === "string" ? parentData.userEmail : "";')).toBe(2);
    expect(count(text, "runOwnerEmail =")).toBe(2); // no other assignment
  });

  fact("paid-audit", "review-decision audit rows carry the owner's email, falling back to the user profile", () => {
    const text = src("app/api/governance/review/route.ts");
    expect(text).toContain('let runOwnerEmail = typeof runData.userEmail === "string" ? runData.userEmail.trim() : "";');
    expect(text).toContain('const ownerDoc = await adminDb.collection("users").doc(rowOwnerUid).get();');
    expect(text).toMatch(/runOwnerUid: rowOwnerUid,\s*runOwnerEmail,\s*question: auditQuestion,/);
  });

  fact("staff-audit", "staff override/delete audit rows take the owner email only from the record itself", () => {
    const text = src("app/api/admin/runs/[runId]/route.ts");
    expect(count(text, "runOwnerEmail:")).toBe(2);
    expect(count(text, 'runOwnerEmail: typeof prev.userEmail === "string" ? prev.userEmail : "",')).toBe(2);
    expect(text).not.toMatch(/collection\("users"\)/);
    expect(text).toContain("const question = collection === \"runs\" ? REDACTED_ADMIN_AUDIT_QUESTION : auditQuestionFromDoc(collection, prev);");
  });

  fact("staff-audit", "only video records store userEmail; claim and research records do not", () => {
    for (const f of [
      "lib/firestore/verifications.ts",
      "lib/firestore/teamClaimVerifications.ts",
      "lib/firestore/runs.ts",
      "lib/firestore/teamWorkspaceRuns.ts",
    ]) {
      expect(src(f)).not.toMatch(/userEmail|\bemail\b/);
    }
    expect(src("app/api/verify-video/route.ts")).toMatch(/userId: uid,\s*userEmail,\s*type: "video_verification",\s*fileName,/);
    expect(src("lib/firestore/teamVideoVerifications.ts")).toMatch(/userId: args\.uid,\s*userEmail: args\.userEmail,\s*type: "video_verification",/);
    // The claim route reads the email only for the legacy team copy, after the record is saved.
    const claim = src("app/api/verify-claim/route.ts");
    expect(claim.indexOf('let userEmail = "";')).toBeGreaterThan(claim.indexOf("saveClaimVerification("));
  });

  fact("video", "video verification is paid-only, and its audit excerpt is the file name, duration and resolution", () => {
    for (const route of ["app/api/verify-video/route.ts", "app/api/workspaces/[workspaceId]/video-verifications/route.ts"]) {
      const text = src(route);
      expect(text).toContain('if (plan === "free") {');
      expect(text).toContain("question: `Video verification: ${fileName} (${metadata.duration}s, ${metadata.width}x${metadata.height})`,");
    }
    expect(src("app/api/verify-video/route.ts")).toMatch(/fileName,\s*verdict: aggregateVerdict,[\s\S]*?metadata,\s*metadataAnalysis: \{/);
  });

  fact("retention", "no plan-based history retention is enforced: historyRetentionDays is only declared", () => {
    const users = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("hooks")].filter((f) =>
      src(f).includes("historyRetentionDays")
    );
    expect(users.filter((f) => f !== "app/privacy/page.tsx" && f !== "app/help/page.tsx")).toEqual(["lib/plans.ts"]);
  });

  fact("sentry", "client Sentry: default PII on (IP), replay 5% of sessions and 100% on error, replay masking left at SDK defaults", () => {
    const client = src("instrumentation-client.ts");
    expect(client).toContain("sendDefaultPii: true,");
    expect(client).toContain("replaysSessionSampleRate: 0.05,");
    expect(client).toContain("replaysOnErrorSampleRate: 1.0,");
    expect(client).toContain("integrations: [Sentry.replayIntegration()],");
    expect(client).not.toMatch(/maskAllText|maskAllInputs|unmask/);
    const lock = JSON.parse(src("package-lock.json"));
    const installed = JSON.parse(src("node_modules/@sentry/replay/package.json")).version;
    expect(lock.packages["node_modules/@sentry/replay"].version).toBe(installed);
    const replay = src("node_modules/@sentry/replay/build/npm/cjs/index.js");
    expect(replay).toMatch(/maskAllText = true,\s*maskAllInputs = true,\s*blockAllMedia = true,/);
  });

  fact("posthog", "client PostHog: proxied via /ingest, autocapture and session recording not disabled in code, identify with email/name", () => {
    const provider = src("components/PostHogProvider.tsx");
    const init = provider.slice(provider.indexOf("posthog.init(key, {"), provider.indexOf("});", provider.indexOf("posthog.init(key, {")));
    expect(init).toContain('api_host: "/ingest",');
    expect(init).toContain("capture_exceptions: true,");
    expect(init).not.toMatch(/autocapture|disable_session_recording|session_recording|ip:\s*false|mask/);
    expect(src("next.config.js")).toContain('destination: "https://us.i.posthog.com/:path*",');
    expect(src("app/signup/page.tsx")).toContain("posthog.identify(user.uid, { email: user.email ?? undefined, name: name.trim() || undefined });");
    expect(src("app/login/page.tsx")).toContain("posthog.identify(user.uid, { email: user.email ?? undefined });");
    expect(src("lib/adaptiveSchema/analytics.ts")).toContain("queryType: classification.queryType,");
  });
});

/**
 * CLOSED WORLD: every rendered sentence, verbatim, with the fact behind it.
 * A sentence missing from this table, or a table row missing from the page,
 * fails. Re-verify the backing fact before changing any row.
 */
const APPROVED_SENTENCES: Array<[string, string]> = [
  ["Last updated: [REVISION DATE — OWNER VERIFY]", "owner:PP-02"],
  ["ConvergePanel (\"we\", \"our\", \"us\") is committed to protecting your privacy.", "reviewed"],
  ["This Privacy Policy explains how we collect, use, and protect your information when you use the ConvergePanel web application or the ConvergePanel Verify browser extension.", "reviewed"],
  ["Who is responsible for your data.", "reviewed"],
  ["The ConvergePanel service is operated by [LEGAL ENTITY NAME — OWNER VERIFY], [REGISTERED ADDRESS — OWNER VERIFY], which is responsible for the personal information described in this policy.", "owner:PP-01"],
  ["You can contact us at support@convergepanel.com .", "reviewed"],
  ["This policy may be updated as we add features and improve our service.", "reviewed"],
  ["We collect the following information:", "reviewed"],
  ["Account Information: Email address, display name (if provided), the answers you give during onboarding (such as your role, use case, how often you expect to use the app and how you heard about us), your plan and subscription status, the identifiers our payment processor assigns to you, and your team and workspace memberships", "reviewed"],
  ["Invitations: If you invite someone to a team workspace, we store the invitee's email address and the invitation details, and we send them an invitation email that includes the workspace name, their role and the invitation link", "reviewed"],
  ["Content You Submit and Your Results: The claims, questions and context you submit (including text read from files you attach), the video information you submit, and the results produced for them (see below)", "reviewed"],
  ["Usage Data: Number of runs, which models you selected, token usage, plan limits and usage counters, and product-analytics events about how you use the app", "reviewed"],
  ["Technical Data: IP address, browser type, device information, the addresses of the pages you visit, and error reports", "reviewed"],
  ["What we store.", "reviewed"],
  ["When you run a Claim Verification, we store the claim you submit (up to 2,000 characters) and the structured results each AI model returns (its verdict, confidence, summary and the parts it found correct, incorrect or unverifiable), together with consensus scores and an audit record of the run.", "reviewed"],
  ["When you run Deep Research, we store your question, any context you provide, the answers the AI models return, the combined summary report and related analysis, and review and governance records for the run.", "trace:storage"],
  ["If you export a research report, we may also store a snapshot of the exported content.", "reviewed"],
  ["For Video Verification, see Section 6.", "reviewed"],
  ["We use this to show your history, let you reopen results, and support review and governance features.", "reviewed"],
  ["For Claim Verification, we do not store the raw, unprocessed responses from AI providers.", "reviewed"],
  ["On paid plans, when our governance checks evaluate a claim, research run or video verification, or a review decision is made on it, an entry is recorded in an audit log used for governance and administration.", "code:paid-audit"],
  ["The entry contains an excerpt of the claim or question (up to its first 200 characters; for a video, its file name, duration and resolution) and your account ID, and, for a video verification or a review decision, your account email.", "code:paid-audit"],
  ["When our staff delete a stored claim or video verification, or change the review status of a stored claim, research run or video verification, an audit-log entry containing a similar excerpt and your account ID is recorded on any plan; it also contains your account email where that email is stored with the record, which today is the case only for video verifications.", "code:staff-audit"],
  ["If your account belongs to a team, a copy of the content you run, together with your email address, is also kept for that team (see Section 8).", "reviewed"],
  ["How long we keep it.", "reviewed"],
  ["We keep stored content and account data until it is deleted (see Section 11).", "reviewed"],
  ["We do not currently delete it automatically after a fixed period, on any plan.", "code:retention"],
  ["We may also delete stored content ourselves, for example as part of data cleanup.", "reviewed"],
  ["Logs.", "reviewed"],
  ["Our hosting and monitoring providers keep technical logs.", "reviewed"],
  ["These logs can include identifiers such as your account ID and, in some cases, short excerpts of what you submit or of AI model output.", "reviewed"],
  ["Retention periods for these logs, and for database backups, have not yet been confirmed.", "owner:PP-14"],
  ["The app uses cookies and browser storage on your device:", "reviewed"],
  ["Sign-in (essential): a secure, HTTP-only session cookie, and the sign-in state that Firebase Authentication keeps in your browser", "reviewed"],
  ["History cache: to load your history faster, the app keeps a copy of your recent results, including the claims and questions you submitted, in your browser's local storage on that device.", "reviewed"],
  ["This copy stays after you sign out", "reviewed"],
  ["App settings: small values such as your plan information for the current tab and whether you have acknowledged the video upload notice", "reviewed"],
  ["Analytics and monitoring (not essential): PostHog stores an identifier in a cookie and in local storage, and Sentry stores a session identifier for session replay (see Section 7)", "code:sentry"],
  ["You can remove all of these by clearing this site's data in your browser.", "reviewed"],
  ["The app does not currently offer a setting to turn off analytics or monitoring.", "reviewed"],
  ["We use your information to:", "reviewed"],
  ["Provide and improve the ConvergePanel service", "reviewed"],
  ["Show your history and let you reopen your results", "reviewed"],
  ["Support team, review, governance and audit features", "reviewed"],
  ["Enforce usage quotas and plan limits, and process payments", "reviewed"],
  ["Debug technical issues, monitor errors and improve reliability", "reviewed"],
  ["Understand how the product is used (product analytics)", "reviewed"],
  ["Send essential service emails, such as email verification, password reset and team workspace invitations", "reviewed"],
  ["Essential service emails are part of providing the service.", "reviewed"],
  ["Product analytics are not required to provide the service.", "reviewed"],
  ["We do not sell your data to third parties.", "reviewed"],
  ["We do not use your data for advertising or marketing purposes beyond essential service communications.", "reviewed"],
  ["The ConvergePanel Verify browser extension lets you highlight text on any webpage, right-click, and open it in ConvergePanel for multi-model verification.", "reviewed"],
  ["Selected text: When you trigger the context menu action, the highlighted text is passed as a URL parameter to convergepanel.com in a new tab.", "reviewed"],
  ["The extension does not send it anywhere else.", "reviewed"],
  ["Because the text is part of the address of the ConvergePanel page that opens, it is handled as described in this policy, including by our hosting logs, error monitoring and analytics (see Section 7).", "reviewed"],
  ["No background collection: The extension does not inject scripts into pages, does not monitor your browsing, and does not read page content unless you explicitly initiate a verification.", "reviewed"],
  ["Local storage: The extension keeps the most recently selected text and a timestamp in chrome.storage.local to prefill the verification form, until you select new text or remove the extension.", "reviewed"],
  ["The extension does not transmit this stored data to any server.", "reviewed"],
  ["Once the verification tab opens, your use of the ConvergePanel web application is governed by the rest of this Privacy Policy.", "reviewed"],
  ["When you use video verification, your video file is processed in your browser.", "reviewed"],
  ["ConvergePanel does not upload, store, or retain your complete video files on our servers.", "reviewed"],
  ["Only extracted frame images and technical details read from the file are transmitted to our servers for the analysis request.", "reviewed"],
  ["These details include the file name, duration, resolution, codec, frame rate, file size, format, whether it has audio, and, where the file contains them, its creation date, encoding software and camera or device model.", "reviewed"],
  ["The frames and these technical details (but not the file name) are sent to OpenAI, Anthropic and Google for analysis, regardless of which models you select elsewhere, and are subject to their respective terms.", "trace:video"],
  ["After analysis is complete, frame images are discarded.", "reviewed"],
  ["We store the analysis results, the model verdicts, the file name and the technical details above, and your account email with the verification.", "code:video"],
  ["Video verification is available on paid plans only.", "code:video"],
  ["As described in Section 2, audit-log entries about a video verification contain its file name, duration and resolution, your account ID and your account email.", "code:video"],
  ["If you run it in a team workspace, it is stored in that workspace (see Section 8).", "reviewed"],
  ["We do not sell your video content or verification results or use them for advertising.", "reviewed"],
  ["They are accessed and shared only as described in this policy (see Sections 7 and 8).", "reviewed"],
  ["ConvergePanel uses the following third-party services.", "reviewed"],
  ["The first group is needed to provide the service; the second group is used for monitoring and analytics.", "reviewed"],
  ["Firebase (Google): Authentication, sign-in emails (such as email verification and password reset) and database.", "reviewed"],
  ["The content and account data described in Section 2 are stored here.", "reviewed"],
  ["Firebase Privacy Policy", "reviewed"],
  ["Vercel: Hosting and server logs.", "reviewed"],
  ["Vercel receives the requests your browser makes to ConvergePanel, including page addresses, and our server logs.", "reviewed"],
  ["Vercel Privacy Policy", "reviewed"],
  ["Stripe: Payment processing.", "reviewed"],
  ["Stripe receives your email address and your ConvergePanel account ID, and handles your payment details directly.", "reviewed"],
  ["Depending on our Stripe account settings, Stripe may also email you payment receipts.", "owner:PP-11"],
  ["Stripe Privacy Policy", "reviewed"],
  ["Resend: Delivery of team workspace invitation emails.", "owner:PP-12"],
  ["Resend receives the invitee's email address, the workspace name, the role and the invitation link.", "owner:PP-12"],
  ["Resend Privacy Policy", "reviewed"],
  ["AI Model Providers: To produce results, the text you submit is sent to the AI providers whose models you select: OpenAI, Anthropic, Google (Gemini API), xAI (Grok) and Perplexity.", "trace:selected-models"],
  ["Perplexity also runs a live web search based on the text you submit.", "trace:selected-models"],
  ["Files you attach are read in your browser; the file itself is not uploaded, and the text read from it becomes part of the text you submit.", "code:attach"],
  ["For Deep Research, the text you submit is divided into a question and, optionally, context.", "code:split"],
  ["The context is everything from the first line that starts with \"Context:\".", "code:split"],
  ["If you attach a file after typing a question, the app adds the file's text under such a line, so it becomes context.", "code:attach"],
  ["If there is no such line, for example when you attach a file while the question box is empty, the whole text, including any text from an attached file, is treated as the question.", "code:attach"],
  ["If your text begins with such a line, the whole text is treated both as the question and as context.", "code:split"],
  ["The models you select receive both the question and any context.", "trace:selected-models"],
  ["For Deep Research, your question and all the model answers may also be sent to Google (Gemini API) to classify the question, compare the answers, check for bias and coverage, and write the summary report, whether or not you selected a Google model.", "code:gemini-aux"],
  ["Text that is treated only as context is not sent in these steps, but the model answers can quote or summarize it.", "code:gemini-aux"],
  ["For Deep Research, your question, any context and the model answers may also be sent to OpenAI (or Anthropic, as a fallback) to produce a combined summary, whether or not you selected those models.", "code:synthesis"],
  ["Video data is sent as described in Section 6.", "reviewed"],
  ["We do not send your name, email address or account ID to these providers.", "reviewed"],
  ["Each provider handles the data it receives under its own terms and may log requests under its own policies.", "reviewed"],
  ["For Deep Research, where our fallback is enabled, if a selected model is temporarily unavailable, your question and any context may be sent to DeepSeek instead.", "code:deepseek"],
  ["DeepSeek states that it processes and stores data in the People's Republic of China.", "owner:PP-13"],
  ["OpenAI API data controls", "reviewed"],
  ["Anthropic commercial data retention", "reviewed"],
  ["Google Gemini API Terms", "reviewed"],
  ["xAI API security and data FAQ", "reviewed"],
  ["Perplexity API Terms of Service", "reviewed"],
  ["DeepSeek Privacy Policy", "reviewed"],
  ["Sentry: Error monitoring, performance tracing for a sample of requests, and session replay for a sample of sessions and for sessions in which an error occurs.", "code:sentry"],
  ["Sentry receives your IP address, technical details about errors, and the addresses of the pages you visit.", "code:sentry"],
  ["Session replay records what happens on the page; with our current settings, text and form inputs are masked in these recordings.", "code:sentry"],
  ["Sentry Privacy Policy", "reviewed"],
  ["PostHog (United States): Product analytics.", "code:posthog"],
  ["Requests to PostHog are routed through our own domain, and PostHog may receive your IP address.", "code:posthog"],
  ["PostHog receives the pages you visit, including the full page address; your account ID, email address and, if you provide it at sign-up, your name; your onboarding answers; errors in the app; and events about how you interact with the app, which can include the text of buttons and items you click (such as the beginning of a claim or question shown in your history).", "code:posthog"],
  ["A page address can include text you passed to ConvergePanel through a link or the browser extension.", "reviewed"],
  ["If session recording is enabled in our PostHog settings, PostHog may also record your sessions, including text shown on screen.", "code:posthog"],
  ["Our servers may also send PostHog information about Deep Research question classification and subscription events (including subscription identifiers).", "code:posthog"],
  ["PostHog Privacy Policy", "code:posthog"],
  ["We implement industry-standard security measures:", "reviewed"],
  ["HTTPS encryption for all data in transit", "reviewed"],
  ["Firebase security rules to prevent unauthorized access", "owner:PP-16"],
  ["Secure authentication via Firebase Auth", "reviewed"],
  ["Error monitoring (see Section 7)", "reviewed"],
  ["Who can see your content.", "reviewed"],
  ["Authorized ConvergePanel staff can access stored content, together with the account email it belongs to, to operate, support and secure the service.", "owner:PP-17"],
  ["If you work in a Team or Team Workspace, or your account belongs to a team, the content you create there is visible to that team's administrators and, where applicable, its members and the reviewers they appoint.", "reviewed"],
  ["No system is 100% secure.", "reviewed"],
  ["We cannot guarantee absolute security of your data.", "reviewed"],
  ["The providers listed in Section 7 may process your information in countries other than the one you live in, including the United States, and, where the Deep Research fallback is enabled, the People's Republic of China.", "reviewed"],
  ["These countries may have data protection laws that differ from those in your country.", "reviewed"],
  ["[TRANSFER SAFEGUARDS — OWNER/LEGAL VERIFY]", "owner:PP-06"],
  ["ConvergePanel is not intended for children.", "reviewed"],
  ["You must be at least [MINIMUM AGE — OWNER/LEGAL VERIFY] to use the service.", "owner:PP-07"],
  ["If you believe a child has provided us with personal information, contact us and we will review the request.", "reviewed"],
  ["Depending on where you live, you may have rights over your personal information.", "owner:PP-08"],
  ["You can ask us to:", "owner:PP-08"],
  ["Access your account data", "reviewed"],
  ["Correct information that is inaccurate", "reviewed"],
  ["Delete your account and associated data", "reviewed"],
  ["Provide a copy of your data", "reviewed"],
  ["Restrict or object to certain uses of your information", "reviewed"],
  ["Stop non-essential communications", "reviewed"],
  ["To make a request, contact us at support@convergepanel.com .", "reviewed"],
  ["If you are not satisfied with our response, you may have the right to complain to a data protection authority where you live.", "reviewed"],
  ["[SUPERVISORY AUTHORITY / COMPLAINT DETAILS — OWNER/LEGAL VERIFY]", "owner:PP-09"],
  ["The app does not currently let you delete your account, your research or individual verifications yourself, so deletion requests are handled by email.", "reviewed"],
  ["Our current account deletion removes your sign-in account and profile.", "reviewed"],
  ["Other stored records, such as verifications, research, audit-log entries and team copies, are not removed automatically by that step, and copies may remain in backups, in logs, in our analytics and monitoring tools, and in our providers' systems under their terms.", "owner:PP-10"],
  ["We cannot currently guarantee complete deletion.", "owner:PP-10"],
  ["You can remove the copy kept on your own device by clearing this site's data in your browser.", "reviewed"],
  ["We may update this Privacy Policy at any time.", "reviewed"],
  ["When we make significant changes, we will update the \"Last updated\" date at the top of this page and may also tell you by email or by a notice on the service.", "reviewed"],
  ["Questions about this Privacy Policy?", "reviewed"],
  ["Contact us at support@convergepanel.com .", "reviewed"],
  ["← Back to ConvergePanel", "reviewed"],
];

describe("policy text (closed world)", () => {
  const sentences = policySentences();

  it("renders exactly the approved, fact-checked sentences — nothing added, removed or reworded", () => {
    const approved = APPROVED_SENTENCES.map(([s]) => s);
    const unknown = sentences.filter((s) => !approved.includes(s));
    const missing = approved.filter((s) => !sentences.includes(s));
    expect({ unknown, missing }).toEqual({ unknown: [], missing: [] });
    expect(sentences).toEqual(approved);
  });

  it("every approved sentence is backed by a registered code fact, a trace entry, an OPEN checklist item, or prior review", () => {
    for (const [sentence, tag] of APPROVED_SENTENCES) {
      const ok =
        (tag.startsWith("code:") && REGISTERED_FACTS.has(tag.slice(5))) ||
        /^owner:PP-\d{2}$/.test(tag) ||
        /^trace:[a-z-]+$/.test(tag) ||
        tag === "reviewed";
      if (!ok) throw new Error(`Unbacked sentence (${tag}): ${sentence}`);
    }
  });

  it("every sentence naming a provider or processor is pinned to a code fact, the trace or an OPEN owner item, never to prior review alone — except link labels", () => {
    const PROCESSOR = /\b(Google|Gemini|OpenAI|Anthropic|DeepSeek|xAI|Grok|Perplexity|Sentry|PostHog|Stripe|Resend|Vercel|Firebase)\b/;
    const LINK_LABEL = /^(Firebase|Vercel|Stripe|Resend|Sentry|PostHog|DeepSeek) Privacy Policy$|^(OpenAI API data controls|Anthropic commercial data retention|Google Gemini API Terms|xAI API security and data FAQ|Perplexity API Terms of Service)$/;
    const ALREADY_REVIEWED_PROCESSOR_SENTENCES = new Set([
      // Audit 01/03/10 and R1–R4 reviews; not code-pinned in this spec.
      "Sign-in (essential): a secure, HTTP-only session cookie, and the sign-in state that Firebase Authentication keeps in your browser",
      "Firebase (Google): Authentication, sign-in emails (such as email verification and password reset) and database.",
      "Vercel: Hosting and server logs.",
      "Vercel receives the requests your browser makes to ConvergePanel, including page addresses, and our server logs.",
      "Stripe: Payment processing.",
      "Stripe receives your email address and your ConvergePanel account ID, and handles your payment details directly.",
      "Secure authentication via Firebase Auth",
    ]);
    for (const [sentence, tag] of APPROVED_SENTENCES) {
      if (!PROCESSOR.test(sentence) || LINK_LABEL.test(sentence)) continue;
      if (tag === "reviewed") expect(ALREADY_REVIEWED_PROCESSOR_SENTENCES).toContain(sentence);
    }
  });

  it("no sentence says context or attached files are sent to Google, or that Sentry/PostHog never receive data", () => {
    for (const s of sentences) {
      if (/Google|Gemini/.test(s)) expect(s).not.toMatch(/context and attached|attached files? (?:are|is) (?:also )?sent|context (?:is|are) (?:also )?sent/i);
      expect(s).not.toMatch(/\b(Sentry|PostHog)\b[^.]*\bnever\b/);
    }
  });
});

describe("policy text states the key facts (readable pins)", () => {
  const text = renderedText();

  it("discloses that Deep Research synthesis sends question, context and answers to OpenAI or Anthropic", () => {
    expect(text).toContain(
      "your question, any context and the model answers may also be sent to OpenAI (or Anthropic, as a fallback) to produce a combined summary, whether or not you selected those models"
    );
  });

  it("discloses that attached-file text in an empty box becomes the question, which the Gemini steps receive", () => {
    expect(text).toContain(
      "If there is no such line, for example when you attach a file while the question box is empty, the whole text, including any text from an attached file, is treated as the question."
    );
    expect(text).toContain("your question and all the model answers may also be sent to Google (Gemini API)");
    expect(text).toContain("Text that is treated only as context is not sent in these steps, but the model answers can quote or summarize it.");
    // The R4 MAJOR: the old unconditional assurance must not return.
    expect(text).not.toContain("The context you add is not sent separately in these steps");
    expect(text).not.toContain("including text from a file you attach)");
  });

  it("does not present payment receipts as an email we send", () => {
    expect(text).not.toContain("invitations and payment receipts");
    for (const sentence of text.split(/(?<=[.!?])\s+/).filter((s) => /receipt/i.test(s))) {
      expect(sentence).toMatch(/Stripe/);
      expect(sentence).toMatch(/\bmay\b/);
    }
  });

  it("scopes staff audit excerpts to claim and video deletions, and the staff-audit email to records that store it", () => {
    expect(text).toContain("When our staff delete a stored claim or video verification");
    expect(text).not.toContain("When our staff delete a stored item");
    expect(text).toContain("your account email where that email is stored with the record, which today is the case only for video verifications");
    expect(text).not.toMatch(/your account email is recorded on any plan/);
  });

  it("states the legacy team copy includes the email address", () => {
    expect(text).toContain("a copy of the content you run, together with your email address, is also kept for that team");
  });

  it("states research cannot be self-deleted either", () => {
    expect(text).toContain("does not currently let you delete your account, your research or individual verifications yourself");
  });
});

describe("unresolved legal placeholders (each maps to an OPEN owner/legal checklist item)", () => {
  it("renders exactly the known placeholders, so the page is visibly unfinished", () => {
    const found = renderedText().match(/\[[A-Z][A-Z /]*— [A-Z/ ]*VERIFY\]/g) || [];
    expect(found).toEqual([
      "[REVISION DATE — OWNER VERIFY]", // PP-02
      "[LEGAL ENTITY NAME — OWNER VERIFY]", // PP-01
      "[REGISTERED ADDRESS — OWNER VERIFY]", // PP-01
      "[TRANSFER SAFEGUARDS — OWNER/LEGAL VERIFY]", // PP-06
      "[MINIMUM AGE — OWNER/LEGAL VERIFY]", // PP-07
      "[SUPERVISORY AUTHORITY / COMPLAINT DETAILS — OWNER/LEGAL VERIFY]", // PP-09
    ]);
  });
});
