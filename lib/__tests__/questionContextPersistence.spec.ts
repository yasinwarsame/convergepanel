/**
 * F2/R1 — the persistable form of the server-split research context.
 */
import { composeSynthesisQuestion, persistableQuestionContext, splitQuestionAndContext } from "@/lib/questionContext";
import { MAX_QUESTION_LENGTH } from "@/lib/security/requestValidation";

describe("persistableQuestionContext", () => {
  it("keeps the split context verbatim (with its own 'Context:' line)", () => {
    const { context } = splitQuestionAndContext("Q?\nContext:\nsource text");
    expect(persistableQuestionContext(context)).toBe("Context:\nsource text");
  });
  it.each([[null], [undefined], [""], ["   "]])("%p → undefined (no empty field is written)", (v) => {
    expect(persistableQuestionContext(v as string | null | undefined)).toBeUndefined();
  });
  it("is bounded by the existing 10,000-char question contract, never a new allowance", () => {
    expect(persistableQuestionContext("y".repeat(MAX_QUESTION_LENGTH + 50))).toHaveLength(MAX_QUESTION_LENGTH);
    expect(MAX_QUESTION_LENGTH).toBe(10000);
  });
});

describe("composeSynthesisQuestion", () => {
  it("question alone without context; question + context with it", () => {
    expect(composeSynthesisQuestion("Q?")).toBe("Q?");
    expect(composeSynthesisQuestion("Q?", "Context:\nX")).toBe("Q?\n\nContext:\nX");
  });
});
