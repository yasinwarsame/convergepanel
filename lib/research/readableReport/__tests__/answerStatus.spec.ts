/**
 * #290 Increment 1 — the answer heading never claims more than the report holds.
 */
import { readableAnswerHasBody, readableAnswerHeading, readableAnswerStatus } from "../answerStatus";
import { READABLE_ANSWER_COPY } from "../copy";

describe("answerStatus", () => {
  it.each([
    [{ degraded: false }, "written", "Answer"],
    [{ degraded: true }, "assembled", READABLE_ANSWER_COPY.assembledHeading],
    [{ degraded: undefined }, "unknown", READABLE_ANSWER_COPY.unknownHeading],
    [{ degraded: "false" }, "unknown", READABLE_ANSWER_COPY.unknownHeading],
    [{ degraded: 0 }, "unknown", READABLE_ANSWER_COPY.unknownHeading],
    [null, "missing", READABLE_ANSWER_COPY.missingHeading],
    [undefined, "missing", READABLE_ANSWER_COPY.missingHeading],
  ])("%p → %s", (report, status, heading) => {
    const s = readableAnswerStatus(report as any);
    expect(s).toBe(status);
    expect(readableAnswerHeading(s)).toBe(heading);
  });

  it('degraded report is never headed "Answer"', () => {
    const heading = readableAnswerHeading(readableAnswerStatus({ degraded: true } as any));
    expect(heading).not.toBe("Answer");
    expect(heading).toMatch(/no written synthesis was produced/);
  });

  it('only a written synthesis is headed "Answer"', () => {
    for (const s of ["assembled", "unknown", "missing"] as const) expect(readableAnswerHeading(s)).not.toMatch(/^Answer\b/);
  });

  it("missing synthesis renders no answer text", () => {
    expect(readableAnswerHasBody("missing")).toBe(false);
    for (const s of ["written", "assembled", "unknown"] as const) expect(readableAnswerHasBody(s)).toBe(true);
  });
});
