/**
 * Order 37 A/D: every customer-facing model label names the model the connector actually requests.
 * Reads the real connector sources (not a copy) so a model-ID change without a label change fails here.
 */
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { PANEL_MODELS } from "@/lib/panelModels";
import { MODEL_INFO } from "@/lib/modelInfo";
import { GEMINI_MODEL_ID, GEMINI_DISPLAY_NAME } from "@/lib/models/gemini";
import { PERPLEXITY_AGENT_MODEL } from "@/lib/providers/perplexityAgentResponse";

const root = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");
const label = (id: string) => PANEL_MODELS.find((m) => m.id === id)!.label;

// Requested API model ID → the only truthful customer-facing name for it.
const TRUTHFUL: Record<string, string> = {
  "gpt-4o-mini": "GPT-4o mini",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "grok-4-1-fast-reasoning": "Grok 4.1 Fast",
  "perplexity/sonar": "Perplexity Sonar",
};

describe("truthful model labels", () => {
  it.each([
    ["chatgpt", "lib/connectors/chatgpt.ts"],
    ["claude", "lib/connectors/claude.ts"],
  ])("%s: the label names the model ID the connector sends", (id, file) => {
    const m = /model:\s*"([^"]+)"/.exec(src(file));
    expect(m).not.toBeNull();
    expect(TRUTHFUL[m![1]]).toBeDefined();
    expect(label(id)).toBe(TRUTHFUL[m![1]]);
  });

  it("grok: the label names the default model (Production sets no GROK_MODEL override)", () => {
    const m = /GROK_MODEL\s*=\s*process\.env\.GROK_MODEL\s*\|\|\s*"([^"]+)"/.exec(src("lib/env.ts"));
    expect(m![1]).toBe("grok-4-1-fast-reasoning");
    expect(label("grok")).toBe(TRUTHFUL[m![1]]);
  });

  it("perplexity: names the Sonar model, not the Perplexity Pro subscription tier", () => {
    expect(label("perplexity")).toBe(TRUTHFUL[PERPLEXITY_AGENT_MODEL]);
  });

  it("gemini: the label is derived from the model ID the connector sends", () => {
    expect(GEMINI_MODEL_ID).toBe("gemini-3.5-flash-lite");
    expect(label("gemini")).toBe(GEMINI_DISPLAY_NAME);
  });

  it("the deprecated MODEL_INFO copy carries the same labels", () => {
    for (const m of PANEL_MODELS) expect(MODEL_INFO[m.id as keyof typeof MODEL_INFO].displayName).toBe(m.label);
  });

  it("no customer-facing source still advertises the retired labels", () => {
    let out = "";
    try {
      out = execFileSync("git", ["grep", "-n", "-E", "GPT[ -]?5\\.2|Opus 4\\.5|Grok[ -]4([^.0-9-]|$)|Perplexity Pro", "--", "app", "components", "lib", "public", "README.md", ":!**/__tests__/**", ":!*.spec.*"], { cwd: root, encoding: "utf8" });
    } catch (e: any) {
      if (e.status !== 1) throw e; // 1 = no match
    }
    // Allowed: the competitor comparison page naming Perplexity's own "Perplexity Pro" product, and an
    // unrendered JSX comment in app/page.tsx, a byte-sealed file (#290) this PR must not touch.
    const hits = out
      .split("\n")
      .filter(Boolean)
      .filter((l) => !/^lib\/pseo\/pages\.ts:\d+:.*Perplexity Pro( is a genuinely useful research tool|", "ConvergePanel")/.test(l))
      .filter((l) => !/^app\/page\.tsx:\d+:\s*\{\/\* NOTE: For MVP testing/.test(l));
    expect(hits).toEqual([]);
  });
});
