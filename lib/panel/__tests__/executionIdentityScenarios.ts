/**
 * C-a row sets (inventory v3 §0.5 scenario codes) for the corrected D-4 gate and every C-a surface test.
 * Each set is the run's result rows exactly as a client or a persisted perModel holds them.
 */
import type { ModelResult } from "@/lib/types";
import { executingModelKey } from "@/lib/panel/independentVoices";
import { STORED_PLACEHOLDER_LITERALS } from "@/lib/panel/executionIdentity";

export const TEXT = "Paris is the capital of France. The city has been the seat of the French government for centuries.";

const PROVIDER: Record<string, string> = { chatgpt: "openai", claude: "anthropic", grok: "xai", perplexity: "perplexity", gemini: "google" };

export const ok = (modelId: string, provider: string | null = PROVIDER[modelId] ?? "openai"): ModelResult =>
  ({ modelId, status: "ok", rawText: TEXT, latencyMs: 5, ...(provider !== null ? { provider } : {}) }) as unknown as ModelResult;
export const sub = (modelId: string, provider: string | null = "deepseek"): ModelResult =>
  ({ modelId, status: "substituted", rawText: TEXT, latencyMs: 5, ...(provider !== null ? { provider } : {}) }) as unknown as ModelResult;
export const failed = (modelId: string): ModelResult => ({ modelId, status: "failed", rawText: null, latencyMs: 5 }) as unknown as ModelResult;
export const statusless = (modelId: string): ModelResult => ({ modelId, rawText: TEXT, latencyMs: 5, provider: PROVIDER[modelId] }) as unknown as ModelResult;
export const mock = (modelId: "chatgpt" | "claude"): ModelResult =>
  ({ modelId, status: "ok", rawText: STORED_PLACEHOLDER_LITERALS[modelId], latencyMs: 0 }) as unknown as ModelResult;

const FIVE = ["chatgpt", "claude", "grok", "perplexity", "gemini"];

/** Scenario → rows, kind, K (independent executing models; null = unverified) and M (answered slots). */
export const SETS = {
  // FC: one executing model for every answered slot.
  S1: { rows: FIVE.map((m) => sub(m)), kind: "FC", K: 1, M: 5 },
  S1n: { rows: FIVE.map((m) => sub(m)), kind: "FC", K: 1, M: 5 },
  S8a: { rows: [sub("chatgpt"), sub("claude")], kind: "FC", K: 1, M: 2 },
  // PC: at least two executing models, fewer than the answered slots.
  S2: { rows: [sub("chatgpt"), sub("claude"), ok("grok"), ok("perplexity"), ok("gemini")], kind: "PC", K: 4, M: 5 },
  S2n: { rows: [sub("chatgpt"), sub("claude"), ok("grok"), ok("perplexity"), ok("gemini")], kind: "PC", K: 4, M: 5 },
  S2b: { rows: [sub("chatgpt"), sub("claude"), sub("grok"), sub("perplexity"), ok("gemini")], kind: "PC", K: 2, M: 5 },
  S7: { rows: [failed("chatgpt"), failed("claude"), sub("grok"), sub("perplexity"), ok("gemini")], kind: "PC", K: 2, M: 3 },
  // UV: the corrected gate fails.
  S3: { rows: [statusless("chatgpt"), statusless("claude"), statusless("grok")], kind: "UV", K: null, M: 0 },
  S3m: { rows: [ok("chatgpt"), statusless("claude"), ok("grok")], kind: "UV", K: null, M: 2 },
  S3mn: { rows: [ok("chatgpt"), sub("claude", null), ok("grok")], kind: "UV", K: null, M: 3 },
  S3mnRecorded: { rows: [sub("chatgpt"), sub("claude", null), ok("grok")], kind: "UV", K: null, M: 3 },
  S6: { rows: [], kind: "UV", K: null, M: 0 },
  PRE62A_SUB: { rows: [ok("chatgpt", null), sub("claude", null), ok("grok", null)], kind: "UV", K: null, M: 3 },
  PRE62A_OK: { rows: [ok("chatgpt", null), ok("claude", null), ok("grok", null)], kind: "UV", K: null, M: 3 },
  R_UV: { rows: [ok("chatgpt", null), sub("claude", null), ok("gemini", null)], kind: "UV", K: null, M: 3 },
  UNKNOWN_PROVIDER: { rows: [ok("chatgpt"), sub("claude", "unknown"), ok("grok")], kind: "UV", K: null, M: 3 },
  // IND (BI35: no substitution; BIb: one substitute).
  S4: { rows: FIVE.map((m) => ok(m)), kind: "IND", K: 5, M: 5 },
  S5: { rows: [ok("chatgpt"), ok("claude"), ok("grok")], kind: "IND", K: 3, M: 3 },
  S4f: { rows: [ok("chatgpt"), ok("claude"), ok("grok"), ok("perplexity"), failed("gemini")], kind: "IND", K: 4, M: 4 },
  S8b: { rows: [ok("chatgpt"), sub("claude")], kind: "IND", K: 2, M: 2 },
  // Order 33 (ruling B): "mistral" is no provider the code has ever written (lib/panel/providerRegistry.ts), so the
  // second substitute records no provider and the gate fails (was IND, K 2 before the registry).
  S8d: { rows: [sub("chatgpt", "deepseek"), sub("claude", "mistral")], kind: "UV", K: null, M: 2 },
  // Order 33 (ruling B): malformed / placeholder provider tokens record no provider.
  MALFORMED_PROVIDER: { rows: [ok("chatgpt", "None"), ok("claude", "n/a"), ok("grok", "acme")], kind: "UV", K: null, M: 3 },
  // Deterministic normalization only: " OpenAI " / "ANTHROPIC" are the registered openai / anthropic.
  NORMALIZED_PROVIDER: { rows: [ok("chatgpt", " OpenAI "), ok("claude", "ANTHROPIC")], kind: "IND", K: 2, M: 2 },
  // MOCK (D-5): stored placeholder rows.
  S9: { rows: [mock("chatgpt"), mock("claude"), ok("grok"), ok("perplexity"), ok("gemini")], kind: "IND", K: 3, M: 3 },
  S9u: {
    rows: [{ ...ok("chatgpt"), rawText: "This is a mock response about mock responses in testing." } as ModelResult, ok("claude"), ok("grok")],
    kind: "UV",
    K: null,
    M: 3,
  },
} as const satisfies Record<string, { rows: readonly ModelResult[]; kind: string; K: number | null; M: number }>;

export type SetName = keyof typeof SETS;
export const rowsOf = (name: SetName): ModelResult[] => (SETS[name].rows as readonly ModelResult[]).map((r) => ({ ...r }) as ModelResult);

export const UV_SETS: SetName[] = ["S3", "S3m", "S3mn", "S3mnRecorded", "S6", "PRE62A_SUB", "PRE62A_OK", "R_UV", "UNKNOWN_PROVIDER", "S9u", "S8d", "MALFORMED_PROVIDER"];
export const BI35_SETS: SetName[] = ["S4", "S5", "S4f"];

/**
 * N-D4′ (d): the test-side K reference — distinct `executingModelKey` over usable rows, recomputed here WITHOUT
 * `resolveExecutingModelKeys` and without the module under test; null when any usable row lacks a recorded provider.
 */
export function referenceK(rows: readonly ModelResult[]): number | null {
  if (rows.length === 0) return null;
  const usable: ModelResult[] = [];
  for (const r of rows as any[]) {
    if (!r || typeof r.modelId !== "string" || !r.modelId.trim() || typeof r.status !== "string") return null;
    const text = [r.rawTextFull, r.rawTextTruncated, r.rawText, r.text].find((t) => typeof t === "string" && t.length > 0) ?? "";
    if (/mock response/i.test(text) && !(r.status === "ok" && Object.values(STORED_PLACEHOLDER_LITERALS).includes(text.trim()))) return null;
    if (Object.values(STORED_PLACEHOLDER_LITERALS).includes(text.trim()) && r.status === "ok") continue;
    if ((r.status === "ok" || r.status === "substituted") && text.trim()) usable.push(r);
  }
  // Order 33 (ruling B): the test-side copy of the provider registry (independent of the module under test).
  const REGISTERED = ["openai", "anthropic", "xai", "perplexity", "google", "deepseek"];
  for (const r of usable as any[]) {
    const p = typeof r.provider === "string" ? r.provider.trim().toLowerCase() : "";
    if (!REGISTERED.includes(p)) return null;
  }
  return new Set(usable.map((r) => executingModelKey(r as any))).size;
}

/** N-D4′ (a): "independent" never has a digit next to it (an unverified surface shows no K). */
export const DIGIT_NEXT_TO_INDEPENDENT = /\d+\s+independent|\bindependent\s+\w*\s*\d/;
