/**
 * DeepSeek Connector
 *
 * Used as a universal fallback when primary models (GPT, Claude, Gemini) fail.
 * DeepSeek exposes an OpenAI-compatible chat completions API, so we reuse
 * the OpenAI SDK pointed at DeepSeek's base URL.
 *
 * This connector is NOT registered in CONNECTOR_MAP — it is only invoked
 * by the fallback logic in lib/panel.ts.
 */

import OpenAI from "openai";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { ModelId } from "@/lib/types";

export const DEEPSEEK_MODEL = "deepseek-chat";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MAX_TOKENS = 2200;

const DEFAULT_DEEPSEEK_TIMEOUT_MS = 15_000;
const DEFAULT_DEEPSEEK_MAX_RETRIES = 0;

const DEEPSEEK_SYSTEM_INSTRUCTION =
  "Follow the user instructions carefully. Respond with the best possible answer.";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEEPSEEK_TIMEOUT_MS = readIntEnv("DEEPSEEK_TIMEOUT_MS", DEFAULT_DEEPSEEK_TIMEOUT_MS);
export const DEEPSEEK_MAX_RETRIES = readIntEnv("DEEPSEEK_MAX_RETRIES", DEFAULT_DEEPSEEK_MAX_RETRIES);

const isDev = () => process.env.NODE_ENV !== "production";

/** DEV-only call counter for verification scripts. Never use in production logic. */
export let __deepseekCallCount = 0;
export function __resetDeepseekCallCount() { __deepseekCallCount = 0; }

function createTimeout(timeoutMs: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), timeoutMs)
  );
}

function isRetryableError(code: string): boolean {
  return code === "deepseek_timeout" || code === "deepseek_429" || code === "deepseek_5xx";
}

export interface DeepSeekSuccess {
  ok: true;
  text: string;
  actualModel: string;
  latencyMs: number;
}

export interface DeepSeekFailure {
  ok: false;
  code: string;
  retryable: boolean;
  message: string;
  latencyMs: number;
}

export type DeepSeekResult = DeepSeekSuccess | DeepSeekFailure;

/**
 * Build the messages array for a DeepSeek fallback call.
 * Exported for dev verification scripts only — not used at runtime outside this module.
 */
export function _buildDeepSeekMessagesForTest(
  forModelId: ModelId,
  question: string,
  context?: string | null
) {
  const q = question?.trim() ?? "";
  const c = context?.trim() || null;
  return [
    { role: "system", content: DEEPSEEK_SYSTEM_INSTRUCTION },
    { role: "user", content: buildPanelPrompt(forModelId, q, c) },
  ];
}

/**
 * Call DeepSeek as a fallback for a failed primary model.
 * Never throws — always returns a normalized DeepSeekResult.
 * Retries are controlled by DEEPSEEK_MAX_RETRIES (default 0 = no retries).
 */
export async function callDeepSeek(
  question: string,
  forModelId: ModelId,
  apiKey: string,
  context?: string | null
): Promise<DeepSeekResult> {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.FORCE_DEEPSEEK_FAIL === "1"
  ) {
    return {
      ok: false,
      code: "deepseek_forced_fail",
      retryable: false,
      message: "DeepSeek forced failure (dev testing)",
      latencyMs: 0,
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      code: "deepseek_no_api_key",
      retryable: false,
      message: "DEEPSEEK_API_KEY is not configured",
      latencyMs: 0,
    };
  }

  let lastResult: DeepSeekResult | null = null;

  for (let attempt = 0; attempt <= DEEPSEEK_MAX_RETRIES; attempt++) {
    if (attempt > 0 && isDev()) {
      console.log(`[DeepSeek] Retrying for ${forModelId} (attempt ${attempt + 1}/${DEEPSEEK_MAX_RETRIES + 1})`);
    }

    lastResult = await singleDeepSeekCall(question, forModelId, apiKey, context, attempt);

    if (lastResult.ok) return lastResult;
    if (!isRetryableError(lastResult.code)) break;
  }

  return lastResult!;
}

async function singleDeepSeekCall(
  question: string,
  forModelId: ModelId,
  apiKey: string,
  context: string | null | undefined,
  attempt: number
): Promise<DeepSeekResult> {
  if (isDev()) __deepseekCallCount++;
  const startTime = Date.now();

  if (isDev()) {
    console.log(`[DeepSeek] Calling ${DEEPSEEK_BASE_URL} for ${forModelId} (attempt ${attempt + 1}/${DEEPSEEK_MAX_RETRIES + 1}, timeout ${DEEPSEEK_TIMEOUT_MS}ms)`);
  }

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });

    const sanitizedQuestion = question?.trim() ?? "";
    const sanitizedContext = context?.trim() || null;
    const userPrompt = buildPanelPrompt(forModelId, sanitizedQuestion, sanitizedContext);

    const completion = await Promise.race([
      client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: DEEPSEEK_SYSTEM_INSTRUCTION },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: DEEPSEEK_MAX_TOKENS,
      }),
      createTimeout(DEEPSEEK_TIMEOUT_MS),
    ]);

    const text = completion.choices?.[0]?.message?.content?.trim() || null;
    const latencyMs = Date.now() - startTime;

    if (isDev()) {
      console.log(`[DeepSeek] Response for ${forModelId}: status=200 elapsed=${latencyMs}ms textLen=${text?.length ?? 0}`);
    }

    if (!text) {
      return {
        ok: false,
        code: "deepseek_empty_response",
        retryable: false,
        message: "DeepSeek returned no content",
        latencyMs,
      };
    }

    return {
      ok: true,
      text,
      actualModel: DEEPSEEK_MODEL,
      latencyMs,
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    const msg = error?.message || String(error);
    const result = classifyDeepSeekError(error, msg, latencyMs);

    if (isDev()) {
      console.log(`[DeepSeek] Error for ${forModelId}: code=${result.code} elapsed=${latencyMs}ms retryable=${result.retryable} msg=${msg.slice(0, 120)}`);
    }

    return result;
  }
}

function classifyDeepSeekError(error: any, msg: string, latencyMs: number): DeepSeekFailure {
  if (msg === "timeout" || msg.includes("timeout")) {
    return { ok: false, code: "deepseek_timeout", retryable: true, message: "DeepSeek request timed out", latencyMs };
  }
  if (error?.status === 429 || msg.includes("rate limit")) {
    return { ok: false, code: "deepseek_429", retryable: true, message: "DeepSeek rate limit exceeded", latencyMs };
  }
  if (error?.status === 401 || error?.status === 403 || msg.includes("Request not allowed")) {
    return { ok: false, code: "deepseek_auth", retryable: false, message: "DeepSeek authentication/authorization failed", latencyMs };
  }
  if (error?.status && error.status >= 500) {
    return { ok: false, code: "deepseek_5xx", retryable: true, message: `DeepSeek server error (${error.status})`, latencyMs };
  }
  return { ok: false, code: "deepseek_unknown", retryable: false, message: msg, latencyMs };
}
