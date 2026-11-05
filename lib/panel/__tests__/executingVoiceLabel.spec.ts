/**
 * Executing-model attribution (owner rule, connector fail-closed pass): a slot answered by the DeepSeek fallback is
 * named by the model that wrote it — "DeepSeek (substituting ChatGPT)" — and slots answered by one substitute are ONE
 * independent model. Pure helper; every agreement surface names and counts through it.
 */
import {
  SUBSTITUTE_PROVIDER_NOT_RECORDED,
  executingVoiceName,
  groupSlotsByExecutingVoice,
  independentModelCountText,
  independentVoiceCount,
} from "@/lib/panel/executingVoiceLabel";
import { executingModelKey, independentVoices } from "@/lib/panel/independentVoices";

const SUB = (modelId: string, provider: unknown = "deepseek") => ({ modelId, status: "substituted", provider });
const OK = (modelId: string, provider?: string) => ({ modelId, status: "ok", ...(provider ? { provider } : {}) });

describe("executingVoiceName", () => {
  it("names a substituted slot by its executing model, never as the requested model", () => {
    expect(executingVoiceName("chatgpt", [SUB("chatgpt"), OK("grok")])).toBe("DeepSeek (substituting ChatGPT)");
    expect(executingVoiceName("claude", [SUB("claude")])).toBe("DeepSeek (substituting Claude)");
  });

  it("a substituted row recorded as provenance facts (`substituted: true`) is named the same way", () => {
    expect(executingVoiceName("claude", [{ modelId: "claude", substituted: true, provider: "deepseek" }])).toBe("DeepSeek (substituting Claude)");
    expect(executingVoiceName("claude", [{ modelId: "claude", substituted: false, provider: "anthropic" }])).toBe("Claude");
  });

  it("a non-substituted slot, or one the caller holds no row for, keeps its family name (nothing inferred)", () => {
    expect(executingVoiceName("grok", [SUB("chatgpt"), OK("grok", "xai")])).toBe("Grok");
    expect(executingVoiceName("chatgpt", null)).toBe("ChatGPT");
    expect(executingVoiceName("chatgpt", [])).toBe("ChatGPT");
    expect(executingVoiceName("gemini", [SUB("chatgpt")])).toBe("Gemini");
  });

  it("an unrecorded / placeholder provider is never invented", () => {
    expect(executingVoiceName("chatgpt", [{ modelId: "chatgpt", status: "substituted" }])).toBe(`${SUBSTITUTE_PROVIDER_NOT_RECORDED} (substituting ChatGPT)`);
    expect(executingVoiceName("chatgpt", [SUB("chatgpt", "unknown")])).toBe(`${SUBSTITUTE_PROVIDER_NOT_RECORDED} (substituting ChatGPT)`);
  });
});

describe("groupSlotsByExecutingVoice / independentVoiceCount", () => {
  it("two DeepSeek substitutions are ONE independent model, labelled once with both slots", () => {
    const rows = [SUB("chatgpt"), SUB("claude")];
    const groups = groupSlotsByExecutingVoice(["chatgpt", "claude"], rows);
    expect(groups.map((g) => [g.label, g.slotIds, g.substituted])).toEqual([["DeepSeek (substituting ChatGPT, Claude)", ["chatgpt", "claude"], true]]);
    expect(independentVoiceCount(["chatgpt", "claude"], rows)).toBe(1);
  });

  it("one real provider + one DeepSeek substitute are two independent models", () => {
    const rows = [SUB("chatgpt"), OK("grok", "xai")];
    expect(groupSlotsByExecutingVoice(["chatgpt", "grok"], rows).map((g) => g.label)).toEqual(["DeepSeek (substituting ChatGPT)", "Grok"]);
    expect(independentVoiceCount(["chatgpt", "grok"], rows)).toBe(2);
  });

  it("multiple distinct real providers are each their own model, named by family", () => {
    const rows = [OK("chatgpt"), OK("claude"), OK("grok")];
    expect(groupSlotsByExecutingVoice(["chatgpt", "claude", "grok"], rows).map((g) => g.label)).toEqual(["ChatGPT", "Claude", "Grok"]);
    expect(independentVoiceCount(["chatgpt", "claude", "grok"], rows)).toBe(3);
  });

  it("two substitutes + a real provider: two models, the substitute group first in input order", () => {
    const rows = [SUB("chatgpt"), SUB("claude"), OK("grok")];
    expect(groupSlotsByExecutingVoice(["chatgpt", "claude", "grok"], rows).map((g) => g.label)).toEqual(["DeepSeek (substituting ChatGPT, Claude)", "Grok"]);
  });

  it("distinct substitute providers stay distinct; provider ids are compared case-insensitively", () => {
    const rows = [SUB("chatgpt", "deepseek"), SUB("claude", "DeepSeek "), SUB("gemini", "otherfallback")];
    expect(independentVoiceCount(["chatgpt", "claude"], rows)).toBe(1);
    expect(independentVoiceCount(["chatgpt", "gemini"], rows)).toBe(2);
  });

  it("repeated / case-variant slot ids collapse (never more independence than can be proven)", () => {
    expect(independentVoiceCount(["chatgpt", "chatgpt"], [OK("chatgpt")])).toBe(1);
    expect(executingModelKey({ modelId: "ChatGPT", status: "ok" })).toBe(executingModelKey({ modelId: "chatgpt", status: "ok" }));
    expect(independentVoices([OK("chatgpt"), OK(" ChatGPT ")])).toHaveLength(1);
  });

  it("without rows each distinct slot counts once, named by family", () => {
    expect(groupSlotsByExecutingVoice(["chatgpt", "claude"], undefined).map((g) => g.label)).toEqual(["ChatGPT", "Claude"]);
  });

  it("count text", () => {
    expect(independentModelCountText(1)).toBe("1 model");
    expect(independentModelCountText(2)).toBe("2 models");
  });
});
