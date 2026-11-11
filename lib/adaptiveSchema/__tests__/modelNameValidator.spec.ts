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
    const text = "Both Gemini 3 Pro and GPT-4o mini agree on this point.";
    const found = findUnrecognizedModelNames(text, ROSTER);
    expect(found).toContain("Gemini 3 Pro");
    // "GPT-4o mini" IS the roster's actual display name for chatgpt — not flagged.
    expect(found).not.toContain("GPT-4o mini");
  });

  it("returns empty when every model-like token matches the roster's real display names", () => {
    const text = "GPT-4o mini, Claude Haiku 4.5, Grok 4.3, Perplexity Sonar, and Gemini 3.5 Flash-Lite all responded.";
    expect(findUnrecognizedModelNames(text, ROSTER)).toEqual([]);
  });

  it("matches Flash-Lite whole: the real label is not flagged or half-stripped, a wrong Flash-Lite still is", () => {
    expect(stripUnrecognizedModelNames("Gemini 3.5 Flash-Lite agrees.", ROSTER)).toBe("Gemini 3.5 Flash-Lite agrees.");
    expect(findUnrecognizedModelNames("Gemini 3.1 Flash-Lite agrees.", ROSTER)).toEqual(["Gemini 3.1 Flash-Lite"]);
    expect(findUnrecognizedModelNames("Gemini 3.5 Flash agrees.", ROSTER)).toEqual(["Gemini 3.5 Flash"]);
  });

  it("accepts every spelling of the real model as the same model: Flash-Lite, Google's own \"Flash Lite\", and the API id", () => {
    for (const t of ["Gemini 3.5 Flash Lite agrees.", "gemini 3.5 flash lite agrees.", "Gemini 3.5 Flash-Lite agrees.", "gemini-3.5-flash-lite agrees."]) {
      expect(findUnrecognizedModelNames(t, ROSTER)).toEqual([]);
      expect(stripUnrecognizedModelNames(t, ROSTER)).toBe(t);
    }
    // Wrong versions are still flagged in either spelling.
    expect(findUnrecognizedModelNames("Gemini 2.5 Flash Lite agrees.", ROSTER)).toEqual(["Gemini 2.5 Flash Lite"]);
    expect(findUnrecognizedModelNames("gemini-2.5-flash agrees.", ROSTER)).toEqual(["gemini-2.5-flash"]);
    // Off-roster, the real model is still flagged (the allow-list is the run's roster, not a global list).
    expect(findUnrecognizedModelNames("Gemini 3.5 Flash Lite agrees.", ["chatgpt", "claude"])).toEqual(["Gemini 3.5 Flash Lite"]);
  });

  it("strip replaces whole tokens only: a real Flash-Lite next to an invalid Flash never becomes \"the panel-Lite\"", () => {
    expect(stripUnrecognizedModelNames("Gemini 3.5 Flash-Lite agreed, unlike Gemini 3.5 Flash.", ROSTER)).toBe(
      "Gemini 3.5 Flash-Lite agreed, unlike the panel."
    );
    expect(stripUnrecognizedModelNames("Gemini 3.5 Flash Lite agreed, unlike Gemini 3 Pro.", ROSTER)).toBe(
      "Gemini 3.5 Flash Lite agreed, unlike the panel."
    );
    // Every occurrence of an invalid name is still replaced.
    expect(stripUnrecognizedModelNames("Gemini 3 Pro said X; Gemini 3 Pro said Y.", ROSTER)).toBe("the panel said X; the panel said Y.");
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
    expect(containsUnrecognizedModelName("Claude Haiku 4.5 says so.", ROSTER)).toBe(false);
  });
});

describe("stripUnrecognizedModelNames", () => {
  it("replaces the hallucinated token with a neutral phrase", () => {
    const cleaned = stripUnrecognizedModelNames("Gemini 3 Pro strongly agrees.", ROSTER);
    expect(cleaned).not.toContain("Gemini 3 Pro");
    expect(cleaned).toContain("the panel");
  });

  it("keeps the whole real Grok label and still strips a guessed Grok version (Order 37 truthful labels)", () => {
    expect(stripUnrecognizedModelNames("Grok 4.3 and Grok 5 disagree.", ROSTER)).toBe("Grok 4.3 and the panel disagree.");
    // The retired legacy name is not the served model; the API spelling of the served model is.
    expect(stripUnrecognizedModelNames("Grok 4.1 Fast and grok-4.3 agree.", ROSTER)).toBe("the panel and grok-4.3 agree.");
  });

  it("leaves text with only real display names untouched", () => {
    const text = "Claude Haiku 4.5 strongly agrees.";
    expect(stripUnrecognizedModelNames(text, ROSTER)).toBe(text);
  });
});
