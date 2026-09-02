/**
 * Team Projects UI, Phase 12A.2 — pure parsing/validation tests for
 * `parseTeamProjectRunsPageResponse()` / `isDefinitiveEmptyTeamProjectRunsState()`.
 */

import { parseTeamProjectRunsPageResponse, isDefinitiveEmptyTeamProjectRunsState } from "@/hooks/useTeamProjectRuns";

const PROJECT_ID = "proj-1";

function validItem(overrides: Partial<any> = {}) {
  return {
    id: "run-1",
    at: "2026-01-01T00:00:00.000Z",
    question: "What is the market size?",
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    modelsOk: 2,
    modelsTotal: 2,
    projectId: PROJECT_ID,
    ...overrides,
  };
}

describe("parseTeamProjectRunsPageResponse", () => {
  it("accepts a well-formed page whose items all match the expected projectId", () => {
    const result = parseTeamProjectRunsPageResponse({ ok: true, body: { ok: true, items: [validItem()], hasMore: false }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: true, page: { items: [validItem()], hasMore: false, nextCursor: undefined } });
  });

  it("CRITICAL — a single item whose projectId does NOT match the requested Project fails the WHOLE page closed, never silently filtered", () => {
    const result = parseTeamProjectRunsPageResponse({
      ok: true,
      body: { ok: true, items: [validItem(), validItem({ id: "run-2", projectId: "some-other-project" })], hasMore: false },
      expectedProjectId: PROJECT_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("an item with projectId: null (an Unfiled run leaking into a Project-scoped response) fails the whole page closed", () => {
    const result = parseTeamProjectRunsPageResponse({
      ok: true,
      body: { ok: true, items: [validItem({ projectId: null })], hasMore: false },
      expectedProjectId: PROJECT_ID,
    });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("a non-ok HTTP response with a known errorCode maps through directly", () => {
    const result = parseTeamProjectRunsPageResponse({ ok: false, body: { ok: false, errorCode: "project_not_found" }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: false, errorCode: "project_not_found" });
  });

  it("an unrecognized errorCode collapses to internal_error, never guessed", () => {
    const result = parseTeamProjectRunsPageResponse({ ok: false, body: { ok: false, errorCode: "unheard_of_code" }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });

  it("malformed/absent items on a nominally-ok response is internal_error, never a synthesized page", () => {
    const result = parseTeamProjectRunsPageResponse({ ok: true, body: { ok: true, hasMore: false }, expectedProjectId: PROJECT_ID });
    expect(result).toEqual({ ok: false, errorCode: "internal_error" });
  });
});

describe("isDefinitiveEmptyTeamProjectRunsState", () => {
  it("true only when ready, zero items, and hasMore false", () => {
    expect(isDefinitiveEmptyTeamProjectRunsState({ status: "ready", items: [], hasMore: false })).toBe(true);
  });

  it("false when loading", () => {
    expect(isDefinitiveEmptyTeamProjectRunsState({ status: "loading", items: [], hasMore: false })).toBe(false);
  });

  it("false when hasMore is true", () => {
    expect(isDefinitiveEmptyTeamProjectRunsState({ status: "ready", items: [], hasMore: true })).toBe(false);
  });
});
