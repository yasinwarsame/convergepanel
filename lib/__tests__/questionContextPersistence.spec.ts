/**
 * F2/R1 — the persistable form of the server-split research context.
 */
import { composeSynthesisQuestion, persistableQuestionContext, readPersistedQuestionContext, splitQuestionAndContext } from "@/lib/questionContext";
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

describe("readPersistedQuestionContext — the READ contract for stored (untyped) context", () => {
  it("a valid stored context is returned trimmed", () => {
    expect(readPersistedQuestionContext("Context:\nsource text")).toBe("Context:\nsource text");
    expect(readPersistedQuestionContext("  \nContext:\nsource text \n")).toBe("Context:\nsource text");
  });
  it.each([[undefined], [null], [42], [true], [{ text: "Context:\nX" }], [["Context:\nX"]], [""], ["   \n\t"]])("%p → undefined", (v) => {
    expect(readPersistedQuestionContext(v)).toBeUndefined();
  });
  it("MAX boundary on the STORED length: exactly MAX_QUESTION_LENGTH is honoured, one more is ignored — never truncated", () => {
    const atMax = "c".repeat(MAX_QUESTION_LENGTH);
    expect(readPersistedQuestionContext(atMax)).toBe(atMax);
    expect(readPersistedQuestionContext(atMax + "c")).toBeUndefined();
    // Whitespace counts toward the stored length: the reader does not trim first to make an oversized value fit.
    expect(readPersistedQuestionContext(atMax + " ")).toBeUndefined();
  });
  it("differs from the WRITER on purpose: persistableQuestionContext truncates server input, the reader refuses oversized history", () => {
    const oversized = "y".repeat(MAX_QUESTION_LENGTH + 50);
    expect(persistableQuestionContext(oversized)).toHaveLength(MAX_QUESTION_LENGTH);
    expect(readPersistedQuestionContext(oversized)).toBeUndefined();
  });
  it("round-trip: whatever the writer persists, the reader honours unchanged", () => {
    for (const raw of ["Q?\nContext:\nsource", "Q?\ncontext: " + "w".repeat(MAX_QUESTION_LENGTH * 2)]) {
      const persisted = persistableQuestionContext(splitQuestionAndContext(raw).context);
      expect(persisted).toBeDefined();
      expect(readPersistedQuestionContext(persisted)).toBe(persisted);
    }
  });
});
