/** Round 2 — content-free diagnostics keep class / code / path, never messages or received values. Synthetic. */
import { z } from "zod";
import { errorName, issueFieldsFromStrings, issueSummary } from "@/lib/privacy/contentFreeDiagnostics";

const SENTINEL = "SYNTHETIC_DIAG_SENTINEL";

describe("contentFreeDiagnostics", () => {
  it("errorName returns the class only — a SyntaxError's quoted excerpt is dropped", () => {
    let err: unknown;
    try {
      JSON.parse(`${SENTINEL} not json`);
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toContain("SYNTHETIC_"); // control: the raw message DOES quote content
    expect(errorName(err)).toBe("SyntaxError");
    expect(errorName("x")).toBe("string");
  });

  it("issueSummary keeps path + code from a real ZodError and drops the received value", () => {
    const r = z.object({ stance: z.enum(["asserts", "denies"]), items: z.array(z.string()) }).safeParse({ stance: SENTINEL, items: SENTINEL });
    expect(r.success).toBe(false);
    const err = (r as any).error;
    // The installed Zod (v4) does not quote received values; older Zod and custom refinements do — simulate that:
    err.issues[0].message = `Invalid enum value, received '${SENTINEL}'`;
    expect(JSON.stringify(err.issues)).toContain(SENTINEL);
    const summary = issueSummary(err);
    expect(summary).toEqual(expect.arrayContaining([expect.objectContaining({ path: "stance" }), expect.objectContaining({ path: "items" })]));
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
    expect(issueSummary(new Error("x"))).toEqual([]);
  });

  it("issueFieldsFromStrings keeps the field part of '<field>: <message>' strings", () => {
    expect(issueFieldsFromStrings([`stance: received '${SENTINEL}'`, "no colon"])).toEqual(["stance", "(unknown)"]);
  });
});

describe("R3 — diagnosticCode / contentFreeError are bounded and content-free", () => {
  const { contentFreeError, diagnosticCode } = require("@/lib/privacy/contentFreeDiagnostics");
  it.each([
    [new Error(`${SENTINEL} plain error`), "error"],
    [Object.assign(new Error(`${SENTINEL} with status`), { status: 429 }), "http_429"],
    [Object.assign(new Error(`${SENTINEL}`), { name: "AbortError" }), "aborted"],
    [new Error(`${SENTINEL} request timed out`), "timeout"],
    [new TypeError("Failed to fetch"), "network_error"],
    ["a string thrown", "error"],
    [null, "error"],
  ])("%s → %s, never the message", (err, code) => {
    expect(diagnosticCode(err)).toBe(code);
    expect(JSON.stringify(contentFreeError(err))).not.toContain(SENTINEL);
  });
});
