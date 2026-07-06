import "server-only";

import { ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY } from "@/lib/env";

import type { ExtractedFrame } from "./videoPure";

const VISION_TIMEOUT_MS = 60_000;

function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/**
 * Turn a provider's raw HTTP error body into a short, human-readable message
 * instead of surfacing the raw JSON (which otherwise ends up verbatim in the UI).
 */
function formatVisionApiError(provider: string, status: number, rawBody: string): string {
  let providerMessage: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") providerMessage = parsed.error;
    else if (typeof parsed.error?.message === "string") providerMessage = parsed.error.message;
    else if (typeof parsed.message === "string") providerMessage = parsed.message;
  } catch {
    providerMessage = rawBody.slice(0, 200).trim() || undefined;
  }

  if (status === 401 || status === 403) {
    return `${provider} rejected the API key (${status}). Check that the key is valid and has access to this model.`;
  }
  if (status === 404) {
    return `${provider} model is unavailable (404)${providerMessage ? `: ${providerMessage}` : ""}`;
  }
  if (status === 429) {
    return `${provider} rate limit exceeded (429). Try again shortly.`;
  }
  if (status >= 500) {
    return `${provider} is temporarily unavailable (${status}). Try again shortly.`;
  }
  return `${provider} request failed (${status})${providerMessage ? `: ${providerMessage}` : ""}`;
}

/**
 * Send video frames to OpenAI (GPT-4o) for authenticity analysis.
 *
 * Uses Chat Completions `v1/chat/completions` with `image_url` parts. Each frame is a **base64 data URL**
 * (`data:image/jpeg;base64,...`) so nothing must be hosted externally (no pre-signed URLs or CDN).
 *
 * @param prompt - Verification prompt with metadata and instructions
 * @param frames - Extracted video frames as raw base64 JPEG (wrapped as data URLs in the request)
 * @returns Model response text and total token count when the API returns usage
 * @throws Error if the API key is missing or the response is non-OK
 */
export async function callOpenAIVision(
  prompt: string,
  frames: ExtractedFrame[]
): Promise<{ text: string; tokens?: number }> {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...frames.map((f) => ({
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${f.base64}`,
                detail: "high",
              },
            })),
          ],
        },
      ],
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatVisionApiError("OpenAI", response.status, err));
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content || "";
  const tokens = data.usage?.total_tokens;

  console.log(`[verify-video] openai: ${text.length} chars, ${tokens ?? "unknown"} tokens`);
  return { text, tokens };
}

/**
 * Send video frames to Anthropic Claude for authenticity analysis.
 *
 * Uses Messages API `v1/messages` with base64 JPEG image blocks (`media_type: image/jpeg`).
 * Env: `ANTHROPIC_API_KEY` (same as elsewhere via `@/lib/env`).
 *
 * @param prompt - The verification prompt with metadata and instructions
 * @param frames - Extracted video frames as base64 JPEG
 * @returns Model response text and approximate token count (input + output)
 * @throws Error if API call fails or returns non-200
 */
export async function callClaudeVision(
  prompt: string,
  frames: ExtractedFrame[]
): Promise<{ text: string; tokens?: number }> {
  const apiKey = ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            ...frames.map((f) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: f.base64,
              },
            })),
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatVisionApiError("Claude", response.status, err));
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content?.[0]?.text || "";
  const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  console.log(`[verify-video] claude: ${text.length} chars, ${tokens || "unknown"} tokens`);
  return { text, tokens };
}

/**
 * Send video frames to Google Gemini for authenticity analysis.
 *
 * Uses Generative Language API `v1beta` `generateContent` with `inlineData` (raw base64 JPEG).
 * Env: `GEMINI_API_KEY` (same as elsewhere via `@/lib/env`).
 *
 * @param prompt - The verification prompt with metadata and instructions
 * @param frames - Extracted video frames as base64 JPEG
 * @returns Model response text and total token count when provided
 * @throws Error if API call fails or returns non-200
 */
export async function callGeminiVision(
  prompt: string,
  frames: ExtractedFrame[]
): Promise<{ text: string; tokens?: number }> {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              ...frames.map((f) => ({
                inlineData: {
                  mimeType: "image/jpeg",
                  data: f.base64,
                },
              })),
              { text: prompt },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 8192 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(formatVisionApiError("Gemini", response.status, err));
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { totalTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const tokens = data.usageMetadata?.totalTokenCount;

  console.log(`[verify-video] gemini: ${text.length} chars, ${tokens ?? "unknown"} tokens`);
  return { text, tokens };
}
