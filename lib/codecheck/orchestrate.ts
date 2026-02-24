/**
 * CodeCheck Orchestration
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import nodePath from "path";
import {
  CodeCheckRole,
  CodeCheckRoleResult,
  CodeCheckSpec,
  CodeCheckDiff,
  CodeCheckVerification,
  CodeCheckIntake,
  CodeCheckImplementRequest,
  CodeCheckVerifyRequest,
  CodeCheckClaudeReview,
  CodeCheckReviewIssue,
  CodeCheckIssueSeverity,
} from "./types";
import {
  getSystemPrompt,
  buildPlannerMessage,
  buildImplementerMessage,
  buildVerifierMessage,
} from "./prompts";
import {
  decodeBase64Diff,
  joinBase64Chunks,
  isUnifiedDiff,
  NOT_UNIFIED_DIFF_ERROR,
} from "./diffEncoding";
import { detectTestFramework, getRecommendedVerificationCommands } from "./testFramework";
import { buildRepoContext, formatRepoContextForPrompt } from "./repoContext";

function hasTypeScript(): boolean {
  try {
    return fs.existsSync(nodePath.join(process.cwd(), "tsconfig.json"));
  } catch {
    return false;
  }
}

// TODO: consider making baseline commands configurable per-repo
function ensureBaselineCommands(commands: string[], isTypeScript?: boolean): string[] {
  const useTs = isTypeScript ?? hasTypeScript();
  const baseline = useTs
    ? ["npx tsc --noEmit", "npm run build"]
    : ["npm run build"];
  const result = [...baseline];
  for (const cmd of commands) {
    if (!result.includes(cmd)) result.push(cmd);
  }
  return result;
}

const ROLE_TIMEOUTS: Record<CodeCheckRole, number> = {
  planner: 60_000,
  implementer: 90_000,
  verifier: 60_000,
};

const ROLE_MAX_TOKENS: Record<CodeCheckRole, number> = {
  planner: 16384,
  implementer: 16384,
  verifier: 4096,
};

export const CODECHECK_MODEL_ID = "claude-opus-4-6";
const CODECHECK_MODEL = CODECHECK_MODEL_ID;
const CODECHECK_MODEL_FALLBACK = "claude-sonnet-4-20250514";

// ============================================
// PROVIDER ERROR HANDLING
// ============================================

export type ProviderErrorCode =
  | "provider_forbidden"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_auth"
  | "provider_unknown";

function classifyProviderError(error: unknown): { code: ProviderErrorCode; status: number; retryable: boolean } {
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes("403") || msg.includes("forbidden") || msg.includes("Request not allowed")) {
    return { code: "provider_forbidden", status: 403, retryable: false };
  }
  if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid.*key")) {
    return { code: "provider_auth", status: 401, retryable: false };
  }
  if (msg.includes("429") || msg.includes("rate") || msg.includes("too many")) {
    return { code: "provider_rate_limited", status: 429, retryable: true };
  }
  if (/\b5\d{2}\b/.test(msg) || msg.includes("timeout") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("overloaded")) {
    return { code: "provider_unavailable", status: 503, retryable: true };
  }

  return { code: "provider_unknown", status: 500, retryable: false };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeout(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), timeoutMs)
  );
}

// TODO: module-level mutable state — potential concurrency issue in serverless. Move to request-scoped context.
let _lastImplementerError: string | undefined;

const IMPLEMENTER_RETRY_SUFFIX = `

---
CORRECTION REQUIRED — your previous response failed server-side validation.
Error: {ERROR}

NON-NEGOTIABLE REQUIREMENTS:
- Return ONLY valid JSON (no markdown, no commentary).
- Use diff_unified as an ARRAY OF STRINGS (one diff line per element).
- Do NOT use base64 (no diff_b64, no diff_b64_chunks).
- Do NOT output raw TypeScript. You MUST output a UNIFIED DIFF.

Schema:
{
  "taskId": "string",
  "filesTouched": ["path", ...],
  "diff_unified": ["--- ...", "+++ ...", "@@ ...", "+line", ...],
  "verificationCommands": ["npx tsc --noEmit", "npm run build"]
}

Return ONLY the JSON object.`;

const PLANNER_RETRY_SUFFIX = `

---
CORRECTION REQUIRED — your previous response was not valid JSON.

Return ONLY valid JSON (no markdown, no prose, no code fences), matching this schema:
{
  "summary": ["bullet 1", "bullet 2"],
  "architecture": "text",
  "filePlan": [
    { "path": "app/example.ts", "purpose": "why", "action": "create" }
  ],
  "tasks": [
    {
      "id": "1",
      "goal": "task goal",
      "filesTouched": ["app/example.ts"],
      "acceptanceCriteria": ["criterion 1"],
      "verificationCommands": ["npx tsc --noEmit", "npm run build"]
    }
  ],
  "assumptions": [],
  "contestedAreas": []
}

Do NOT include any text before or after the JSON object.`;

async function callAnthropicModel(
  apiKey: string,
  model: string,
  role: CodeCheckRole,
  userMessage: string,
): Promise<CodeCheckRoleResult> {
  const startTime = Date.now();
  const anthropic = new Anthropic({ apiKey });

  const message = await Promise.race([
    anthropic.messages.create({
      model,
      max_tokens: ROLE_MAX_TOKENS[role],
      system: getSystemPrompt(role),
      messages: [{ role: "user", content: userMessage }],
    }),
    createTimeout(ROLE_TIMEOUTS[role]),
  ]);

  if (!message || !Array.isArray(message.content)) {
    throw new Error("Claude API returned invalid response structure");
  }

  const rawText = message.content
    .filter((block) => block && block.type === "text" && "text" in block)
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("\n")
    .trim();

  if (!rawText) {
    return { ok: false, content: "", error: "Claude returned empty response", latencyMs: Date.now() - startTime };
  }

  const parsed = tryParseRoleOutput(role, rawText);
  return { ok: true, content: rawText, parsed: parsed ?? undefined, latencyMs: Date.now() - startTime };
}

// TODO: module-level mutable state — potential concurrency issue in serverless. Move to request-scoped context.
let _lastCallUsedFallback = false;
export function didLastCallUseFallback(): boolean { return _lastCallUsedFallback; }

export async function runCodeCheckRole(
  role: CodeCheckRole,
  userMessage: string,
  apiKey: string
): Promise<CodeCheckRoleResult> {
  const startTime = Date.now();
  _lastCallUsedFallback = false;

  if (!apiKey) {
    return { ok: false, content: "", error: "Anthropic API key not configured", latencyMs: 0 };
  }

  const MAX_RETRIES = 2;
  const BASE_DELAY = 800;

  // Attempt with primary model + retries
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callAnthropicModel(apiKey, CODECHECK_MODEL, role, userMessage);
    } catch (error: unknown) {
      lastError = error;
      const classified = classifyProviderError(error);

      if (!classified.retryable) break; // forbidden/auth — don't retry, go to fallback
      if (attempt < MAX_RETRIES) {
        const jitter = Math.random() * 200;
        await sleep(BASE_DELAY * Math.pow(2, attempt) + jitter);
        console.warn(`[CodeCheck] Retry ${attempt + 1}/${MAX_RETRIES} for ${role} (${classified.code})`);
      }
    }
  }

  // Fallback model — try once for forbidden / persistent failures
  const classified = classifyProviderError(lastError);
  console.warn(`[CodeCheck] Primary model failed (${classified.code}), trying fallback: ${CODECHECK_MODEL_FALLBACK}`);
  _lastCallUsedFallback = true;

  try {
    return await callAnthropicModel(apiKey, CODECHECK_MODEL_FALLBACK, role, userMessage);
  } catch (fallbackError: unknown) {
    const fbClassified = classifyProviderError(fallbackError);
    const latencyMs = Date.now() - startTime;
    return {
      ok: false,
      content: "",
      error: `${fbClassified.code}: Both primary (${CODECHECK_MODEL}) and fallback (${CODECHECK_MODEL_FALLBACK}) failed. ${fallbackError instanceof Error ? fallbackError.message : "Unknown error"}`,
      latencyMs,
    };
  }
}

function tryParseRoleOutput(
  role: CodeCheckRole,
  content: string
): CodeCheckSpec | CodeCheckDiff | CodeCheckVerification | null {
  try {
    let jsonStr = content.trim();

    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    if (!jsonStr.startsWith("{")) {
      const firstBrace = jsonStr.indexOf("{");
      const lastBrace = jsonStr.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
      }
    }

    if (role === "implementer") {
      jsonStr = normalizeImplementerJson(jsonStr);
    }

    const parsed = JSON.parse(jsonStr);

    switch (role) {
      case "planner":
        return validatePlannerOutput(parsed);
      case "implementer":
        return validateImplementerOutput(parsed);
      case "verifier":
        return validateVerifierOutput(parsed);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[CodeCheck] JSON parsing failed for ${role}:`, errMsg);
    console.error(`[CodeCheck] Content preview:`, content.substring(0, 200));
    if (role === "implementer") {
      _lastImplementerError = `JSON parsing failed: ${errMsg}`;
    }
    return null;
  }
}

function normalizeImplementerJson(jsonStr: string): string {
  jsonStr = jsonStr.replace(
    /("diff_b64"\s*:\s*")([^"]*?)(")/,
    (_match, prefix, value, suffix) => {
      const cleaned = String(value).replace(/[\r\n\s]+/g, "");
      return prefix + cleaned + suffix;
    }
  );

  jsonStr = jsonStr.replace(
    /"diff_b64_chunks"\s*:\s*\[([\s\S]*?)\]/,
    (fullMatch, inner: string) => {
      const cleaned = inner.replace(/"([^"]*?)"/g, (_m: string, val: string) => {
        return '"' + String(val).replace(/[\r\n\s]+/g, "") + '"';
      });
      return fullMatch.replace(inner, cleaned);
    }
  );

  return jsonStr;
}

function validatePlannerOutput(parsed: unknown): CodeCheckSpec | null {
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.summary)) return null;
  if (typeof obj.architecture !== "string") return null;
  if (!Array.isArray(obj.filePlan)) return null;
  if (!Array.isArray(obj.tasks)) return null;

  const validatedTasks: CodeCheckSpec["tasks"] = [];
  for (const task of obj.tasks as unknown[]) {
    if (!task || typeof task !== "object") continue;
    const t = task as Record<string, unknown>;
    validatedTasks.push({
      id: typeof t.id === "string" ? t.id : String(validatedTasks.length + 1),
      goal: typeof t.goal === "string" ? t.goal : "Unknown task",
      filesTouched: Array.isArray(t.filesTouched) ? (t.filesTouched as string[]) : [],
      acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
        ? (t.acceptanceCriteria as string[])
        : [],
      verificationCommands: ensureBaselineCommands(
        Array.isArray(t.verificationCommands) ? (t.verificationCommands as string[]) : []
      ),
      dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as string[]) : undefined,
    });
  }

  const validatedFilePlan: CodeCheckSpec["filePlan"] = [];
  for (const entry of obj.filePlan as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== "string") continue;
    validatedFilePlan.push({
      path: e.path,
      purpose: typeof e.purpose === "string" ? e.purpose : "",
      action: e.action === "create" || e.action === "modify" ? e.action : "modify",
    });
  }

  return {
    summary: obj.summary as string[],
    architecture: obj.architecture,
    filePlan: validatedFilePlan,
    tasks: validatedTasks,
    assumptions: Array.isArray(obj.assumptions) ? (obj.assumptions as string[]) : [],
    contestedAreas: Array.isArray(obj.contestedAreas)
      ? (obj.contestedAreas as CodeCheckSpec["contestedAreas"])
      : [],
  };
}

function validateImplementerOutput(parsed: unknown): CodeCheckDiff | null {
  if (!parsed || typeof parsed !== "object") {
    _lastImplementerError = "Implementer output is not an object";
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.taskId !== "string") {
    _lastImplementerError = "Missing or invalid taskId";
    return null;
  }
  if (!Array.isArray(obj.filesTouched)) {
    _lastImplementerError = "Missing or invalid filesTouched array";
    return null;
  }

  const hasUnified = Array.isArray(obj.diff_unified) && (obj.diff_unified as unknown[]).length > 0;
  const hasChunks = Array.isArray(obj.diff_b64_chunks) && (obj.diff_b64_chunks as unknown[]).length > 0;
  const hasB64 = typeof obj.diff_b64 === "string" && obj.diff_b64.length > 0;
  const hasRaw = typeof obj.diff === "string" && obj.diff.length > 0;

  const needsMore =
    (Array.isArray(obj.needsMoreFiles) && obj.needsMoreFiles.length > 0) ||
    (Array.isArray(obj.needs) && (obj.needs as unknown[]).length > 0);

  if (!hasUnified && !hasChunks && !hasB64 && !hasRaw) {
    if (needsMore) {
      const needsList = Array.isArray(obj.needsMoreFiles)
        ? (obj.needsMoreFiles as string[])
        : Array.isArray(obj.needs)
          ? (obj.needs as string[])
          : [];
      return {
        taskId: obj.taskId,
        filesTouched: obj.filesTouched as string[],
        diff: "",
        needsMoreFiles: needsList,
        verificationCommands: Array.isArray(obj.verificationCommands)
          ? (obj.verificationCommands as string[])
          : undefined,
      };
    }
    _lastImplementerError = "Missing diff_unified (preferred), diff_b64_chunks, diff_b64, and diff";
    return null;
  }

  let decodedDiff: string | undefined;

  if (hasUnified) {
    const lines = (obj.diff_unified as unknown[])
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.replace(/\r$/, ""));

    const hasControlChars = lines.some((line) =>
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(line)
    );
    if (hasControlChars) {
      _lastImplementerError = "diff_unified contains non-printable control characters";
      return null;
    }

    decodedDiff = lines.join("\n");
    if (!decodedDiff.trim()) {
      _lastImplementerError = "diff_unified array is empty or contains only empty strings";
      return null;
    }
  } else if (hasChunks) {
    const result = joinBase64Chunks(obj.diff_b64_chunks);
    if (!result.ok || !result.diff) {
      _lastImplementerError = `Failed to decode diff_b64_chunks: ${result.error}`;
      return null;
    }
    decodedDiff = result.diff;
  } else if (hasB64) {
    const result = decodeBase64Diff(obj.diff_b64 as string);
    if (!result.ok || !result.diff) {
      _lastImplementerError = `Failed to decode diff_b64: ${result.error}`;
      return null;
    }
    decodedDiff = result.diff;
  } else {
    decodedDiff = obj.diff as string;
  }

  if (!decodedDiff) {
    _lastImplementerError = "Decoded diff is empty";
    return null;
  }

  if (!isUnifiedDiff(decodedDiff)) {
    _lastImplementerError = NOT_UNIFIED_DIFF_ERROR;
    return null;
  }

  const needsMoreList = Array.isArray(obj.needsMoreFiles)
    ? (obj.needsMoreFiles as string[])
    : Array.isArray(obj.needs)
      ? (obj.needs as string[])
      : undefined;

  return {
    taskId: obj.taskId,
    filesTouched: obj.filesTouched as string[],
    diff: decodedDiff,
    diff_unified: hasUnified ? (obj.diff_unified as string[]) : undefined,
    diff_b64_chunks: hasChunks ? (obj.diff_b64_chunks as string[]) : undefined,
    diff_b64: hasB64 ? (obj.diff_b64 as string) : undefined,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    needsMoreFiles: needsMoreList,
    verificationCommands: Array.isArray(obj.verificationCommands)
      ? (obj.verificationCommands as string[])
      : undefined,
  };
}

function validateVerifierOutput(parsed: unknown): CodeCheckVerification | null {
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;

  // Preferred schema
  if (
    typeof obj.taskId === "string" &&
    (obj.status === "pass" || obj.status === "fail" || obj.status === "needs_info") &&
    Array.isArray(obj.errors)
  ) {
    return {
      taskId: obj.taskId,
      status: obj.status,
      errors: obj.errors as CodeCheckVerification["errors"],
      fixDiff: typeof obj.fixDiff === "string" ? obj.fixDiff : undefined,
      notes: typeof obj.notes === "string" ? obj.notes : undefined,
      missingInfo: typeof obj.missingInfo === "string" ? obj.missingInfo : undefined,
    };
  }

  // Backward compatibility: accept { passed: boolean, feedback: string }
  if (typeof obj.passed === "boolean") {
    return {
      taskId: typeof obj.taskId === "string" ? obj.taskId : "unknown",
      status: obj.passed ? "pass" : "fail",
      errors: [],
      notes:
        typeof obj.feedback === "string"
          ? obj.feedback
          : typeof obj.notes === "string"
            ? obj.notes
            : undefined,
      missingInfo: typeof obj.missingInfo === "string" ? obj.missingInfo : undefined,
      fixDiff: typeof obj.fixDiff === "string" ? obj.fixDiff : undefined,
    };
  }

  return null;
}

export async function runPlanner(
  intake: CodeCheckIntake,
  apiKey: string
): Promise<CodeCheckRoleResult> {
  const testDet = detectTestFramework();
  const recommended = getRecommendedVerificationCommands(testDet);

  const verificationCommands =
    intake.verificationCommands && intake.verificationCommands.length > 0
      ? intake.verificationCommands
      : recommended;

  const repoCtx = buildRepoContext();
  const repoContextBlock = `\n\n${formatRepoContextForPrompt(repoCtx)}`;

  const userMessage = buildPlannerMessage(
    intake.requirements,
    intake.stack,
    intake.constraints,
    intake.fileTree,
    verificationCommands
  );

  const enrichedMessage =
    userMessage +
    repoContextBlock +
    `\n\n## Test Framework Detection\n` +
    `Detected: ${testDet.framework}\n` +
    `Has test script: ${String(testDet.hasTestScript)}\n` +
    (testDet.testCommand ? `Suggested test command: ${testDet.testCommand}\n` : "") +
    (testDet.notes.length ? `Notes:\n- ${testDet.notes.join("\n- ")}\n` : "");

  const firstResult = await runCodeCheckRole("planner", enrichedMessage, apiKey);
  if (!firstResult.ok || firstResult.parsed) {
    return firstResult;
  }

  console.log("[CodeCheck] Planner first attempt returned non-JSON output. Retrying once...");
  const retryResult = await runCodeCheckRole(
    "planner",
    enrichedMessage + PLANNER_RETRY_SUFFIX,
    apiKey
  );

  if (retryResult.ok && !retryResult.parsed) {
    return {
      ...retryResult,
      ok: false,
      error: "Planner response could not be parsed as JSON after retry.",
    };
  }

  return retryResult;
}

export async function runImplementer(
  request: CodeCheckImplementRequest,
  apiKey: string
): Promise<CodeCheckRoleResult> {
  const userMessage = buildImplementerMessage(request.task, request.fileContents, request.priorTasks);

  const testDet = detectTestFramework();
  const repoCtx = buildRepoContext();
  const repoContextBlock = `\n\n${formatRepoContextForPrompt(repoCtx)}`;

  const enrichedMessage =
    userMessage +
    repoContextBlock +
    `\n\n## Test Framework Detection\n` +
    `Detected: ${testDet.framework}\n` +
    `Has test script: ${String(testDet.hasTestScript)}\n` +
    (testDet.testCommand ? `Suggested test command: ${testDet.testCommand}\n` : "") +
    (testDet.notes.length ? `Notes:\n- ${testDet.notes.join("\n- ")}\n` : "");

  // --- First attempt ---
  _lastImplementerError = undefined;
  const firstResult = await runCodeCheckRole("implementer", enrichedMessage, apiKey);

  if (!firstResult.ok) return firstResult;
  if (firstResult.parsed) return firstResult;

  const errorHint = _lastImplementerError || "Implementer output failed validation";
  const correctedMessage = enrichedMessage + IMPLEMENTER_RETRY_SUFFIX.replace("{ERROR}", errorHint);

  _lastImplementerError = undefined;
  const retryResult = await runCodeCheckRole("implementer", correctedMessage, apiKey);

  if (retryResult.ok && !retryResult.parsed) {
    return {
      ...retryResult,
      ok: false,
      error: _lastImplementerError || errorHint,
    };
  }

  return retryResult;
}

export async function runVerifier(
  request: CodeCheckVerifyRequest,
  apiKey: string
): Promise<CodeCheckRoleResult> {
  const userMessage = buildVerifierMessage(
    request.taskId,
    request.buildOutput,
    request.tscOutput,
    request.testOutput,
    request.lintOutput,
    request.filesTouched
  );

  return runCodeCheckRole("verifier", userMessage, apiKey);
}

const CLAUDE_REVIEW_MODEL = "claude-sonnet-4-20250514";
const CLAUDE_REVIEW_TIMEOUT = 120_000;
const CLAUDE_REVIEW_MAX_TOKENS = 4096;

const CLAUDE_REVIEW_SYSTEM_PROMPT = `You are CodeCheck-Reviewer. Return ONLY valid JSON. No markdown. No commentary.

Output schema (exact keys):
{
  "reviewSummary": "1-2 sentence summary of the code quality",
  "issues": [
    { "title": "short title", "detail": "explanation", "severity": "low" | "medium" | "high" }
  ],
  "overallSeverity": "low" | "medium" | "high",
  "suggestions": ["suggestion 1", "suggestion 2"],
  "alternativeCode": "optional improved code as a string, or empty string if not needed"
}

Rules:
- issues must be an array (empty [] if no issues found).
- overallSeverity must be exactly "low", "medium", or "high".
- reviewSummary must be a non-empty string.
- suggestions must be an array of strings.
- Start your response with { and end with }.`;

export interface ClaudeReviewResult {
  ok: boolean;
  review?: CodeCheckClaudeReview;
  error?: string;
  latencyMs: number;
}

export async function runClaudeReview(
  requirements: string,
  code: string,
  context: string,
  apiKey: string
): Promise<ClaudeReviewResult> {
  const startTime = Date.now();

  if (!apiKey) {
    return {
      ok: false,
      error: "Claude API key not configured",
      latencyMs: Date.now() - startTime,
    };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const userMessage = `Requirements:\n${requirements}\n\nContext:\n${context}\n\nCode:\n${code}`;

    const message = await Promise.race([
      anthropic.messages.create({
        model: CLAUDE_REVIEW_MODEL,
        max_tokens: CLAUDE_REVIEW_MAX_TOKENS,
        system: CLAUDE_REVIEW_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      createTimeout(CLAUDE_REVIEW_TIMEOUT),
    ]);

    if (!message || !Array.isArray(message.content)) {
      throw new Error("Claude review API returned invalid response");
    }

    const rawText = message.content
      .filter((block) => block && block.type === "text" && "text" in block)
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("\n")
      .trim();

    const parsed = parseClaudeReviewOutput(rawText);
    if (!parsed) {
      return {
        ok: false,
        error: "Failed to parse Claude review response",
        latencyMs: Date.now() - startTime,
      };
    }

    const latencyMs = Date.now() - startTime;
    return {
      ok: true,
      review: {
        ...parsed,
        model: CLAUDE_REVIEW_MODEL,
        latencyMs,
      },
      latencyMs,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startTime;
    const classified = classifyProviderError(error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      error: `${classified.code}: Claude review failed — ${errorMessage}`,
      latencyMs,
    };
  }
}

function parseClaudeReviewOutput(
  content: string
): Omit<CodeCheckClaudeReview, "model" | "latencyMs"> | null {
  try {
    let jsonStr = content.trim();

    // Strip markdown code fences if present
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Extract JSON object if surrounded by prose
    if (!jsonStr.startsWith("{")) {
      const firstBrace = jsonStr.indexOf("{");
      const lastBrace = jsonStr.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
      }
    }

    const parsed = JSON.parse(jsonStr);

    // Accept both "reviewSummary" and "summary" as the summary field
    const reviewSummary =
      typeof parsed.reviewSummary === "string"
        ? parsed.reviewSummary
        : typeof parsed.summary === "string"
        ? parsed.summary
        : null;

    if (!reviewSummary) {
      console.warn("[codecheck/review] Missing reviewSummary. Keys:", Object.keys(parsed));
      return null;
    }

    // Accept issues as array or default to empty
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];

    const issues: CodeCheckReviewIssue[] = [];
    for (const issue of rawIssues as unknown[]) {
      if (!issue || typeof issue !== "object") continue;
      const i = issue as Record<string, unknown>;
      // Accept "title"/"detail" or "name"/"description" or "message"
      const title = (typeof i.title === "string" ? i.title : typeof i.name === "string" ? i.name : null);
      const detail = (typeof i.detail === "string" ? i.detail : typeof i.description === "string" ? i.description : typeof i.message === "string" ? i.message : null);
      if (!title || !detail) continue;
      issues.push({
        title,
        detail,
        severity: validateSeverity(i.severity),
      });
    }

    return {
      reviewSummary,
      issues,
      overallSeverity: validateSeverity(parsed.overallSeverity ?? parsed.severity),
      suggestions: Array.isArray(parsed.suggestions)
        ? (parsed.suggestions as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      alternativeCode:
        typeof parsed.alternativeCode === "string" && parsed.alternativeCode.trim()
          ? parsed.alternativeCode
          : typeof parsed.alternative === "string" && parsed.alternative.trim()
          ? parsed.alternative
          : undefined,
    };
  } catch (err) {
    console.warn("[codecheck/review] JSON parse failed:", err instanceof Error ? err.message : err);
    console.warn("[codecheck/review] Content preview:", content.slice(0, 300));
    return null;
  }
}

function validateSeverity(value: unknown): CodeCheckIssueSeverity {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
