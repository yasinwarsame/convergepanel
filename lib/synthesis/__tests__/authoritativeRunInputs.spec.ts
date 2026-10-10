/**
 * Governance input authority (F2) — authoritativeSynthesisInputs reads only the
 * persisted, server-written run (see the module header for the characterized
 * writer shapes).
 */
import { authoritativeSynthesisInputs } from "@/lib/synthesis/authoritativeRunInputs";

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({ modelId, status: "ok", rawTextTruncated: `${modelId} says something useful.`, ...extra });
const run = (perModel: unknown, extra: Record<string, unknown> = {}) => ({ question: "Top-level Q", runDocument: { question: "Completed Q", perModel }, ...extra });

describe("question source", () => {
  it("runDocument.question first (the completion-time question)", () => {
    const out = authoritativeSynthesisInputs(run([row("a"), row("b")]));
    expect(out.ok && out.value.question).toBe("Completed Q");
  });
  it("falls back to the top-level question", () => {
    const out = authoritativeSynthesisInputs({ question: "  Top-level Q  ", runDocument: { perModel: [row("a"), row("b")] } });
    expect(out.ok && out.value.question).toBe("Top-level Q");
  });
  it("no trustworthy question → question_unavailable", () => {
    expect(authoritativeSynthesisInputs({ runDocument: { question: "  ", perModel: [row("a"), row("b")] } })).toEqual({ ok: false, reason: "question_unavailable" });
  });
});

describe("rows", () => {
  it("usable rows only (ok / substituted), distinct, non-empty, in persisted order", () => {
    const out = authoritativeSynthesisInputs(run([
      row("b"),
      row("a", { status: "substituted" }),
      row("c", { status: "failed" }),
      row("d", { status: "error" }),
      row("b", { rawTextTruncated: "a second b row" }),
      row("e", { rawTextTruncated: "   " }),
      { modelId: "", status: "ok", rawTextTruncated: "x" },
      null,
    ]));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.rows.map((r) => [r.modelId, r.status])).toEqual([["b", "ok"], ["a", "substituted"]]);
      expect(out.value.rows[0].text).toBe("b says something useful.");
    }
  });
  it("no runDocument / non-array perModel → results_unavailable (no legacy fallback, never request data)", () => {
    expect(authoritativeSynthesisInputs({ question: "Q", results: [row("a"), row("b")], resultsCompact: { perModel: [row("a"), row("b")] } })).toEqual({ ok: false, reason: "results_unavailable" });
    expect(authoritativeSynthesisInputs(run({ a: 1 }))).toEqual({ ok: false, reason: "results_unavailable" });
  });
  it("fewer than two distinct usable rows → insufficient_results", () => {
    expect(authoritativeSynthesisInputs(run([row("a"), row("a")]))).toEqual({ ok: false, reason: "insufficient_results" });
    expect(authoritativeSynthesisInputs(run([row("a"), row("b", { status: "failed" })]))).toEqual({ ok: false, reason: "insufficient_results" });
  });
});

describe("provenance: persisted facts only", () => {
  it("provider / requestedModel / substitutedFrom pass through; actualModel and substitutionReason never do", () => {
    const out = authoritativeSynthesisInputs(run([
      row("a", { status: "substituted", provider: "deepseek", requestedModel: "claude-x", substitutedFrom: "anthropic:claude-x", actualModel: "deepseek-chat", substitutionReason: "timeout" }),
      row("b"),
    ]));
    expect(out.ok && out.value.rows[0].provenance).toEqual({ provider: "deepseek", requestedModel: "claude-x", substitutedFrom: "anthropic:claude-x" });
    expect(out.ok && out.value.rows[1].provenance).toEqual({});
  });
});

describe("Personal / Team shapes", () => {
  it("a Workspace-bound Team run (createTeamWorkspaceRun + completeRun) reads identically", () => {
    const personal = authoritativeSynthesisInputs(run([row("a"), row("b")]));
    const team = authoritativeSynthesisInputs(run([row("a"), row("b")], { workspaceId: "ws-1", projectId: "p-1", userId: "u", createdByUid: "u" }));
    expect(team).toEqual(personal);
  });
});

describe("R1 — persisted questionContext", () => {
  const rows = [row("a"), row("b")];
  it("question + saved context, in that order", () => {
    const out = authoritativeSynthesisInputs(run(rows, { questionContext: "Context:\nSOURCE TEXT" }));
    expect(out.ok && out.value.question).toBe("Completed Q\n\nContext:\nSOURCE TEXT");
  });
  it.each([["absent", undefined], ["empty", "   "], ["non-string", 42], ["over the 10,000-char contract", "x".repeat(10001)]])(
    "%s context → question alone",
    (_l, questionContext) => {
      const out = authoritativeSynthesisInputs(run(rows, questionContext === undefined ? {} : { questionContext }));
      expect(out.ok && out.value.question).toBe("Completed Q");
    }
  );
  it("a context inside runDocument (not the server field) is not read", () => {
    const out = authoritativeSynthesisInputs({ question: "Q", runDocument: { question: "Q", questionContext: "Context:\nX", perModel: rows } });
    expect(out.ok && out.value.question).toBe("Q");
  });
});
