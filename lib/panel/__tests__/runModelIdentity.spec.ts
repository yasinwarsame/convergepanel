/**
 * Model-identity PR A — the canonical completed-run identity contract.
 *
 * A completed run names a model by (a) its slot's product FAMILY and (b) the
 * requested model ConvergePanel FROZE for that run — never by a product label
 * ("GPT 5.2") and never by current model configuration. A missing fact is
 * stated as not recorded, never inferred from the slot.
 */
import fs from "fs";
import path from "path";
import {
  MODEL_NOT_RECORDED,
  RUN_MODEL_FAMILY_NAMES,
  providerDisplayName,
  runModelFamilyName,
  runModelIdentityDetail,
  runModelIdentityLabel,
  runModelLabel,
  runModelLabels,
  runModelProvenanceFromExport,
  runModelProvenanceFromResultRow,
  type RunModelProvenanceFacts,
} from "@/lib/panel/runModelIdentity";
import { PANEL_MODELS } from "@/lib/panelModels";
import type { AdaptiveExportRunProvenance } from "@/lib/adaptiveSchema/researchExport";

const PRODUCT_LABELS = ["GPT 5.2", "Claude Opus 4.5", "Grok 4", "Perplexity Pro", "Gemini 2.0 Flash", "Gemini 3 Pro", "GPT-4o"];

/** The exact frozen provenance of the incident run behind this PR. */
const INCIDENT: RunModelProvenanceFacts[] = [
  { modelId: "chatgpt", provider: "openai", requestedModel: "gpt-4o-mini", substituted: false },
  { modelId: "claude", provider: "anthropic", requestedModel: "claude-haiku-4-5-20251001", substituted: false },
  { modelId: "grok", provider: "xai", requestedModel: "grok-4-1-fast-reasoning", substituted: false },
  { modelId: "perplexity", provider: "perplexity", requestedModel: "perplexity/sonar", substituted: false },
  { modelId: "gemini", provider: "google", requestedModel: "gemini-2.0-flash", substituted: false },
];
const INCIDENT_LABELS = [
  "ChatGPT · requested: gpt-4o-mini",
  "Claude · requested: claude-haiku-4-5-20251001",
  "Grok · requested: grok-4-1-fast-reasoning",
  "Perplexity · requested: perplexity/sonar",
  "Gemini · requested: gemini-2.0-flash",
];

describe("family names", () => {
  it("every slot has a version-free family name", () => {
    expect(RUN_MODEL_FAMILY_NAMES).toEqual({ chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", perplexity: "Perplexity", gemini: "Gemini" });
    for (const name of Object.values(RUN_MODEL_FAMILY_NAMES)) expect(name).not.toMatch(/\d/);
  });
  it("covers every panel slot", () => {
    for (const m of PANEL_MODELS) expect(Object.prototype.hasOwnProperty.call(RUN_MODEL_FAMILY_NAMES, m.id)).toBe(true);
  });
  it("is frozen", () => {
    expect(Object.isFrozen(RUN_MODEL_FAMILY_NAMES)).toBe(true);
  });
  it("an unknown slot renders as recorded; a missing one as 'Unknown model'", () => {
    expect(runModelFamilyName("mistral")).toBe("mistral");
    for (const v of [undefined, null, "", "   ", 5, {}]) expect(runModelFamilyName(v)).toBe("Unknown model");
  });
  it("never a prototype key", () => {
    expect(runModelFamilyName("toString")).toBe("toString");
    expect(runModelFamilyName("__proto__")).toBe("__proto__");
  });
});

describe("the canonical identity label", () => {
  it("names the incident run's five slots by their own frozen requested model", () => {
    expect(INCIDENT.map(runModelIdentityLabel)).toEqual(INCIDENT_LABELS);
  });

  it("never contains a product label for any slot", () => {
    const all = INCIDENT.map(runModelIdentityLabel).join("\n");
    for (const label of PRODUCT_LABELS) expect(all).not.toContain(label);
  });

  it("each slot keeps its own provenance independently (no cross-slot bleed)", () => {
    for (const [i, facts] of INCIDENT.entries()) {
      const label = runModelIdentityLabel(facts);
      for (const [j, other] of INCIDENT.entries()) {
        if (i !== j) expect(label).not.toContain(other.requestedModel!);
      }
    }
  });

  it("no recorded requested model → 'model not recorded', for every slot (pre-6.2a/6.2b history)", () => {
    for (const id of Object.keys(RUN_MODEL_FAMILY_NAMES)) {
      expect(runModelIdentityLabel({ modelId: id })).toBe(`${RUN_MODEL_FAMILY_NAMES[id as keyof typeof RUN_MODEL_FAMILY_NAMES]} · ${MODEL_NOT_RECORDED}`);
      expect(runModelIdentityLabel({ modelId: id, substituted: false })).toContain(MODEL_NOT_RECORDED);
    }
  });

  it("does not infer a model from the provider", () => {
    expect(runModelIdentityLabel({ modelId: "chatgpt", provider: "openai", substituted: false })).toBe("ChatGPT · model not recorded");
  });

  it.each(["chatgpt", "CHATGPT", " claude ", "gemini"])("a slot id stored as the requested model (%p) is a placeholder, not an identity", (placeholder) => {
    expect(runModelIdentityLabel({ modelId: "chatgpt", requestedModel: placeholder })).toBe("ChatGPT · model not recorded");
  });

  it.each([undefined, null, "", "   ", 42, { model: "gpt-4o-mini" }])("a malformed requested model (%p) is not recorded", (bad) => {
    expect(runModelIdentityLabel({ modelId: "chatgpt", requestedModel: bad as never })).toBe("ChatGPT · model not recorded");
  });

  it("a recorded value is rendered single-line and bounded, never interpreted", () => {
    expect(runModelIdentityLabel({ modelId: "chatgpt", requestedModel: "gpt\n-4o\r\tmini" })).toBe("ChatGPT · requested: gpt -4o mini");
    const long = runModelIdentityLabel({ modelId: "chatgpt", requestedModel: "m".repeat(500) });
    expect(long.length).toBeLessThan(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("never says actual, verified, confirmed or attested", () => {
    const outs = [
      ...INCIDENT.map(runModelIdentityLabel),
      runModelIdentityLabel({ modelId: "claude", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true }),
      runModelIdentityLabel({ modelId: "claude" }),
    ].join("\n").toLowerCase();
    expect(outs).not.toMatch(/actual|verified|confirm|attest/);
  });
});

describe("substitution", () => {
  it("recorded requested model + answering provider", () => {
    expect(
      runModelIdentityLabel({ modelId: "claude", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" })
    ).toBe("Claude · requested: claude-haiku-4-5-20251001 · substituted, answered by: DeepSeek");
  });
  it("no requested model but a recorded substitutedFrom: the original is read from that persisted fact", () => {
    expect(runModelIdentityLabel({ modelId: "claude", provider: "deepseek", substituted: true, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" })).toBe(
      "Claude · requested: claude-haiku-4-5-20251001 · substituted, answered by: DeepSeek"
    );
  });
  it("nothing recorded but the substitution: both unknowns stay unknown", () => {
    expect(runModelIdentityLabel({ modelId: "claude", substituted: true })).toBe("Claude · model not recorded · substituted, answered by: provider not recorded");
  });
  it("an incomplete or placeholder substitutedFrom is not reconstructed", () => {
    for (const sf of ["anthropic:", ":", "claude-haiku", "anthropic:claude", "  "]) {
      expect(runModelIdentityLabel({ modelId: "claude", substituted: true, substitutedFrom: sf })).toContain(MODEL_NOT_RECORDED);
    }
  });
  it("substitutedFrom on a NON-substituted row is ignored", () => {
    expect(runModelIdentityLabel({ modelId: "claude", substituted: false, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" })).toBe("Claude · model not recorded");
  });
  it("unknown substitution state is never rendered as a substitution", () => {
    expect(runModelIdentityLabel({ modelId: "grok", provider: "deepseek", requestedModel: "grok-4-1-fast-reasoning" })).toBe("Grok · requested: grok-4-1-fast-reasoning");
  });
  it("the detail is exactly the label minus the family", () => {
    const f: RunModelProvenanceFacts = { modelId: "claude", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true };
    expect(runModelIdentityLabel(f)).toBe(`Claude · ${runModelIdentityDetail(f)}`);
  });
});

describe("row adapters", () => {
  it("result row: reads only the row; status 'substituted' is the only substitution claim", () => {
    expect(runModelProvenanceFromResultRow({ modelId: "claude", status: "substituted", provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substitutedFrom: "anthropic:claude-haiku-4-5-20251001" })).toEqual({
      modelId: "claude",
      provider: "deepseek",
      requestedModel: "claude-haiku-4-5-20251001",
      substituted: true,
      substitutedFrom: "anthropic:claude-haiku-4-5-20251001",
    });
    expect(runModelProvenanceFromResultRow({ modelId: "chatgpt", status: "ok", requestedModel: "gpt-4o-mini", substitutedFrom: "x:y" })).toEqual({ modelId: "chatgpt", requestedModel: "gpt-4o-mini", substituted: false });
    expect(runModelProvenanceFromResultRow({ modelId: "chatgpt" })).toEqual({ modelId: "chatgpt" });
  });
  it("result row: a pre-6.2a saved row (no provenance keys) reads 'model not recorded'", () => {
    expect(runModelIdentityLabel(runModelProvenanceFromResultRow({ modelId: "gemini", status: "ok" }))).toBe("Gemini · model not recorded");
  });

  const FROZEN: AdaptiveExportRunProvenance = {
    policyVersion: 3,
    models: [
      { modelId: "chatgpt" as never, provider: "openai", requestedModel: "gpt-4o-mini", substituted: false },
      { modelId: "claude" as never, provider: "deepseek", requestedModel: "claude-haiku-4-5-20251001", substituted: true, substitutedFrom: "anthropic:claude-haiku-4-5-20251001" },
      { modelId: "gemini" as never },
    ],
  };
  it("export: each slot reads its own frozen entry", () => {
    expect(runModelIdentityLabel(runModelProvenanceFromExport(FROZEN, "chatgpt"))).toBe("ChatGPT · requested: gpt-4o-mini");
    expect(runModelIdentityLabel(runModelProvenanceFromExport(FROZEN, "claude"))).toBe("Claude · requested: claude-haiku-4-5-20251001 · substituted, answered by: DeepSeek");
    expect(runModelIdentityLabel(runModelProvenanceFromExport(FROZEN, "gemini"))).toBe("Gemini · model not recorded");
  });
  it("export: a slot with no frozen entry, or a pre-6.2b export, is 'model not recorded' — the export IS the record", () => {
    expect(runModelIdentityLabel(runModelProvenanceFromExport(FROZEN, "grok"))).toBe("Grok · model not recorded");
    for (const id of Object.keys(RUN_MODEL_FAMILY_NAMES)) expect(runModelIdentityLabel(runModelProvenanceFromExport(null, id))).toContain(MODEL_NOT_RECORDED);
  });
});

describe("lists: never claim 'not recorded' for a record the surface does not hold", () => {
  it("no provenance held → family names only", () => {
    expect(runModelLabels(["chatgpt", "gemini"])).toEqual(["ChatGPT", "Gemini"]);
    expect(runModelLabels(["chatgpt", "gemini"], null)).toEqual(["ChatGPT", "Gemini"]);
  });
  it("provenance held → identity labels; a slot whose row is not held → family only", () => {
    expect(runModelLabels(["chatgpt", "grok"], INCIDENT.slice(0, 1))).toEqual(["ChatGPT · requested: gpt-4o-mini", "Grok"]);
    expect(runModelLabel("gemini", [{ modelId: "gemini" }])).toBe("Gemini · model not recorded");
  });
});

describe("providers", () => {
  it("maps recorded providers; absent is null", () => {
    expect(providerDisplayName("deepseek")).toBe("DeepSeek");
    expect(providerDisplayName(" XAI ")).toBe("XAI");
    expect(providerDisplayName("mistral")).toBe("Mistral");
    expect(providerDisplayName("")).toBeNull();
    expect(providerDisplayName(undefined)).toBeNull();
    expect(providerDisplayName("constructor")).toBe("Constructor");
  });
});

describe("frozen history does not move with current configuration", () => {
  const SAMPLE: RunModelProvenanceFacts[] = [...INCIDENT, { modelId: "claude" }, { modelId: "claude", provider: "deepseek", substituted: true }];

  it("renaming every product label in lib/panelModels.ts changes nothing", () => {
    const before = SAMPLE.map(runModelIdentityLabel).concat(SAMPLE.map((f) => runModelFamilyName(f.modelId)));
    const saved = PANEL_MODELS.map((m) => m.label);
    try {
      PANEL_MODELS.forEach((m) => {
        (m as { label: string }).label = `RENAMED-${m.id}-9.9`;
      });
      const after = SAMPLE.map(runModelIdentityLabel).concat(SAMPLE.map((f) => runModelFamilyName(f.modelId)));
      expect(after).toEqual(before);
      expect(after.join("\n")).not.toContain("RENAMED");
    } finally {
      PANEL_MODELS.forEach((m, i) => {
        (m as { label: string }).label = saved[i];
      });
    }
  });

  it("changing the active model configuration (GROK_MODEL, PERPLEXITY_AGENT_MODEL) changes nothing", () => {
    const before = SAMPLE.map(runModelIdentityLabel);
    const prev = { g: process.env.GROK_MODEL, p: process.env.PERPLEXITY_AGENT_MODEL };
    try {
      process.env.GROK_MODEL = "grok-CHANGED-LATER";
      process.env.PERPLEXITY_AGENT_MODEL = "perplexity/CHANGED-LATER";
      jest.isolateModules(() => {
        const fresh = require("@/lib/panel/runModelIdentity") as typeof import("@/lib/panel/runModelIdentity");
        const after = SAMPLE.map(fresh.runModelIdentityLabel);
        expect(after).toEqual(before);
        expect(after.join("\n")).not.toContain("CHANGED-LATER");
      });
    } finally {
      if (prev.g === undefined) delete process.env.GROK_MODEL;
      else process.env.GROK_MODEL = prev.g;
      if (prev.p === undefined) delete process.env.PERPLEXITY_AGENT_MODEL;
      else process.env.PERPLEXITY_AGENT_MODEL = prev.p;
    }
  });

  it("the module reads no label source, connector configuration or environment", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/panel/runModelIdentity.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/adaptiveSchema/researchExport", "@/lib/types"]);
    for (const line of src.split("\n").filter((l) => /^import\s/.test(l))) expect(line).toMatch(/^import type /);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/process\.env|panelModels|modelInfo|ACTUAL_MODEL_STRINGS|lib\/env|lib\/panel"|require\(/);
  });
});
