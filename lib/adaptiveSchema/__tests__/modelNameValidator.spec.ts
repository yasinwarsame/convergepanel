/**
 * Model-Name Hallucination Validator Tests (B1)
 */

import {
  findUnrecognizedModelNames,
  containsUnrecognizedModelName,
  stripUnrecognizedModelNames,
} from "@/lib/adaptiveSchema/modelNameValidator";

const ROSTER = ["chatgpt", "claude", "grok", "perplexity", "gemini"] as any[];

describe("findUnrecognizedModelNames", () => {
  it("finds a hallucinated version-guessed model name not matching the run's actual display names", () => {
    const text = "Both Gemini 3 Pro and GPT 5.2 agree on this point.";
    const found = findUnrecognizedModelNames(text, ROSTER);
    expect(found).toContain("Gemini 3 Pro");
    // "GPT 5.2" IS the roster's actual display name for chatgpt — not flagged.
    expect(found).not.toContain("GPT 5.2");
  });

  it("returns empty when every model-like token matches the roster's real display names", () => {
    const text = "GPT 5.2, Claude Opus 4.5, Grok 4, Perplexity Pro, and Gemini 2.0 Flash all responded.";
    expect(findUnrecognizedModelNames(text, ROSTER)).toEqual([]);
  });

  it("returns empty for plain prose with no model-name-like tokens", () => {
    const text = "Carbon taxes reduce emissions by pricing externalities directly.";
    expect(findUnrecognizedModelNames(text, ROSTER)).toEqual([]);
  });

  it("flags an out-of-family model name entirely (e.g. a hallucinated competitor)", () => {
    const text = "Llama 3 and Mistral Large were also consulted.";
    const found = findUnrecognizedModelNames(text, ROSTER);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("containsUnrecognizedModelName", () => {
  it("is true when a hallucinated name is present", () => {
    expect(containsUnrecognizedModelName("Gemini 3 Pro says so.", ROSTER)).toBe(true);
  });

  it("is false when text only uses real roster display names", () => {
    expect(containsUnrecognizedModelName("Claude Opus 4.5 says so.", ROSTER)).toBe(false);
  });
});

describe("stripUnrecognizedModelNames", () => {
  it("replaces the hallucinated token with a neutral phrase", () => {
    const cleaned = stripUnrecognizedModelNames("Gemini 3 Pro strongly agrees.", ROSTER);
    expect(cleaned).not.toContain("Gemini 3 Pro");
    expect(cleaned).toContain("the panel");
  });

  it("leaves text with only real display names untouched", () => {
    const text = "Claude Opus 4.5 strongly agrees.";
    expect(stripUnrecognizedModelNames(text, ROSTER)).toBe(text);
  });
});
