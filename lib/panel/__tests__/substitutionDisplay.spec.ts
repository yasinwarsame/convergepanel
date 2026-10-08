/**
 * Saved-run provenance honesty (S1) — substitution display (badge, Model-health
 * chip + tooltip, copied-markdown providers).
 *
 * Case 5: an old substituted run may say "Substituted" but cannot name a
 * provider / model / reason it did not record. Case 8: live rows render exactly
 * as before — proven against the PRE-S1 algorithms, copied verbatim below as an
 * oracle (not re-derived from the new module).
 */
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import { coerceStatus } from "@/lib/panel/normalize";
import { modelHealthSubstitution, providerDisplayName, substitutedProviderNames, substitutionBadgeText } from "@/lib/panel/substitutionDisplay";

type Row = { modelId: string; status: string; provider?: string; requestedModel?: string; actualModel?: string; substitutionReason?: string };

// ── PRE-S1 ORACLE (verbatim from components/PanelSynthesisView.tsx @ 77404bf6) ──
function oldGetProviderDisplayName(provider?: string): string {
  const raw = typeof provider === "string" ? provider.trim() : "";
  if (!raw) return "Unknown";
  const p = raw.toLowerCase();
  const map: Record<string, string> = { deepseek: "DeepSeek", openai: "OpenAI", anthropic: "Anthropic", xai: "XAI", perplexity: "Perplexity", google: "Google" };
  if (map[p]) return map[p];
  return p.charAt(0).toUpperCase() + p.slice(1);
}
function oldModelHealth(results: Row[]) {
  const substitutedCount = results.filter((r) => coerceStatus(r.status) === "substituted").length;
  const substitutedLabels = results
    .filter((r) => coerceStatus(r.status) === "substituted")
    .map((r) => getModelDisplayNameSafe(r.actualModel || r.modelId))
    .filter((l, i, arr) => arr.indexOf(l) === i);
  const label = substitutedCount === 1 && substitutedLabels[0] ? substitutedLabels[0] : substitutedCount > 1 ? `${substitutedCount}` : substitutedCount > 0 ? "1" : null;
  const tooltip = results
    .filter((r) => coerceStatus(r.status) === "substituted")
    .map((r) => {
      const slot = getModelDisplayNameSafe(r.modelId);
      const req = r.requestedModel ?? "?";
      const act = r.actualModel ?? "?";
      const raw = r.substitutionReason;
      const sanitized = raw ? String(raw).replace(/[\n\r]+/g, " ").trim() : "";
      const shortReason = sanitized ? (sanitized.length > 28 ? `${sanitized.slice(0, 25)}…` : sanitized) : "";
      return shortReason ? `${slot}: ${req} → ${act} (${shortReason})` : `${slot}: ${req} → ${act}`;
    })
    .join("\n");
  return { label, tooltip };
}
function oldProviders(results: Row[]) {
  return [...new Set(results.filter((r) => coerceStatus(r.status) === "substituted").map((r) => oldGetProviderDisplayName(r.provider)))].filter((p) => p !== "Unknown");
}
// ─────────────────────────────────────────────────────────────────────────────

/** Live rows always carry every field (runPanelExecution / lib/panel.ts). */
const LIVE_SUB = { modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-sonnet-RUN", actualModel: "deepseek-chat", substitutionReason: "timeout" };
const LIVE_OK = { modelId: "chatgpt", status: "ok", provider: "openai", requestedModel: "gpt-RUN", actualModel: "gpt-RUN" };
const LIVE_SCENARIOS: Row[][] = [
  [LIVE_OK],
  [LIVE_OK, LIVE_SUB],
  [LIVE_OK, LIVE_SUB, { ...LIVE_SUB, modelId: "gemini", requestedModel: "gemini-RUN", substitutionReason: "a_very_long_reason_code_that_gets_truncated" }],
  [LIVE_OK, { ...LIVE_SUB, substitutionReason: undefined }],
];

describe("case 8 — live rows render exactly as before (pre-S1 oracle)", () => {
  it.each(LIVE_SCENARIOS.map((s, i) => [i, s] as const))("scenario %i: Model-health label + tooltip identical", (_i, rows) => {
    expect(modelHealthSubstitution(rows)).toEqual(oldModelHealth(rows));
  });
  it.each(LIVE_SCENARIOS.map((s, i) => [i, s] as const))("scenario %i: copied-markdown providers identical", (_i, rows) => {
    expect(substitutedProviderNames(rows)).toEqual(oldProviders(rows));
  });
  it("the live badge still reads 'Substituted: DeepSeek'", () => {
    expect(substitutionBadgeText(LIVE_SUB)).toBe("Substituted: DeepSeek");
  });
  it("provider display names match the pre-S1 mapping for every recorded provider", () => {
    for (const p of ["deepseek", "openai", "anthropic", "xai", "perplexity", "google", "mistral", " DeepSeek "]) expect(providerDisplayName(p)).toBe(oldGetProviderDisplayName(p));
  });
});

describe("case 5 — a saved substituted row names only what it recorded", () => {
  const OLD_SUB: Row = { modelId: "claude", status: "substituted" };

  it("badge: just 'Substituted' — never a hard-coded DeepSeek", () => {
    expect(substitutionBadgeText(OLD_SUB)).toBe("Substituted");
  });
  it("badge: names the provider when 6.2a recorded it", () => {
    expect(substitutionBadgeText({ ...OLD_SUB, provider: "deepseek" })).toBe("Substituted: DeepSeek");
  });
  it("Model-health label is the count, never the slot's own name presented as the substitute", () => {
    const { label, tooltip } = modelHealthSubstitution([OLD_SUB]);
    expect(label).toBe("1");
    expect(label).not.toBe(getModelDisplayNameSafe("claude"));
    // Pre-S1 behaviour on the same saved row — the defect being fixed.
    expect(oldModelHealth([OLD_SUB]).label).toBe(getModelDisplayNameSafe("claude"));
    expect(tooltip).toBe(`${getModelDisplayNameSafe("claude")}: substituted`);
    expect(tooltip).not.toContain("?");
    expect(tooltip).not.toContain("→");
  });
  it("tooltip states only recorded facts when some are present", () => {
    expect(modelHealthSubstitution([{ ...OLD_SUB, requestedModel: "claude-RUN-1", provider: "deepseek" }]).tooltip).toBe(`${getModelDisplayNameSafe("claude")}: substituted (requested claude-RUN-1)`);
  });
  it("copied markdown lists no provider that was not recorded", () => {
    expect(substitutedProviderNames([OLD_SUB])).toEqual([]);
    expect(substitutedProviderNames([{ ...OLD_SUB, provider: "deepseek" }])).toEqual(["DeepSeek"]);
  });
  it("no label, tooltip or provider list ever contains a slot name as a requested/actual model", () => {
    const out = JSON.stringify([modelHealthSubstitution([OLD_SUB]), substitutedProviderNames([OLD_SUB]), substitutionBadgeText(OLD_SUB)]);
    expect(out).not.toMatch(/claude →|→ claude|deepseek-chat|Unknown|primary_failed/);
  });
});
