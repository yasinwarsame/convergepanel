/**
 * Perplexity Agent API (`POST /v1/agent`) — request contract constants and a
 * PURE, deterministic response parser.
 *
 * ConvergePanel's Perplexity panel slot (logical `modelId: "perplexity"`) is
 * served by the native `perplexity/sonar` model with an explicitly attached
 * `web_search` tool. The dynamic `fast` preset is deliberately NOT used: presets
 * are mutable and can resolve to a non-Perplexity model, which would silently
 * change who the "Perplexity" panel member is.
 *
 * The parser never throws, never mutates its input and never reads the legacy
 * Sonar Chat Completions shape (`choices`, top-level `citations` /
 * `search_results`) as an answer. Search results are only RECOGNISED here (for
 * diagnostics); they are not panel sources and are never persisted by the
 * connector.
 */

export const PERPLEXITY_AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";
export const PERPLEXITY_AGENT_MODEL = "perplexity/sonar";
export const PERPLEXITY_WEB_SEARCH_MAX_RESULTS = 10;

/**
 * The ONE request body sent to the Agent API. The key set is exact: the Agent
 * API rejects unknown fields with HTTP 400, so nothing else may be added
 * without updating the pinned contract tests.
 *
 * - `instructions` carries ConvergePanel's system prompt (JSON shape is still
 *   enforced by that prompt; no `response_format`).
 * - `web_search` is attached and requested for every call (`tool_choice`) so the Perplexity
 *   panel member stays web-grounded (Sonar searched automatically).
 * - `store: false` keeps the response out of Perplexity's retrievable stored
 *   responses (application-state minimization; NOT a zero-retention claim).
 *   Every call is one-shot: no `previous_response_id`, no background mode,
 *   no streaming, no preset, no fallback models.
 *
 * Contract verified by the owner-authorized live smoke (2026-10-13, 7 calls):
 * every request was accepted, served by `perplexity/sonar`, and ran exactly one
 * web search (`usage.tool_calls_details.search_web.invocation = 1`, one
 * `search_results` item with 10 results). The API echoes `tool_choice: "auto"`
 * in responses whatever was requested, so the echo is not evidence; the
 * per-response search invocation (logged by the connector) is.
 */
export function buildPerplexityAgentRequestBody(args: { instructions: string; input: string; maxOutputTokens: number; temperature: number }) {
  return {
    model: PERPLEXITY_AGENT_MODEL,
    instructions: args.instructions,
    input: args.input,
    max_output_tokens: args.maxOutputTokens,
    temperature: args.temperature,
    tools: [{ type: "web_search", search_type: "web", max_results: PERPLEXITY_WEB_SEARCH_MAX_RESULTS }],
    tool_choice: { type: "web_search" },
    max_steps: 1,
    store: false,
  };
}

/** Agent API error types that are server-side (5xx-class) failures. */
export const AGENT_SERVER_ERROR_TYPES: readonly string[] = ["internal_error", "bad_gateway", "gateway_timeout", "upstream_structured_output_failed"];

export type AgentResponseShape = "agent" | "legacy_chat" | "malformed";

export type AgentUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type AgentDiagnostics = {
  /** `usage.cost.total_cost` when the provider reported a finite number; null = unavailable (never a fabricated 0). */
  costTotal: number | null;
  costCurrency: string | null;
  toolCallsCost: number | null;
  /** `usage.tool_calls_details.search_web.invocation` when reported; null = unavailable. */
  searchInvocations: number | null;
  /** Number of `output[]` items with `type: "search_results"`. */
  searchResultItems: number;
  /** Total `results[]` entries across those items. */
  searchResultEntries: number;
  /** Number of `output[]` items with `type: "message"`. */
  messageItems: number;
};

export type AgentParseResult = {
  shape: AgentResponseShape;
  /** Agent run status as reported (`completed`, `incomplete`, `failed`, `cancelled`, or any other string); null when not an agent shape. */
  status: string | null;
  /** `incomplete_details.reason` when present. */
  incompleteReason: string | null;
  /** Text of the FINAL `type:"message"` output item (its `output_text` parts joined), or null when absent/empty. */
  text: string | null;
  error: { type: string | null; code: number | string | null; message: string | null } | null;
  model: string | null;
  usage: AgentUsage | null;
  diagnostics: AgentDiagnostics;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nonNegativeIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const EMPTY_DIAGNOSTICS: AgentDiagnostics = Object.freeze({
  costTotal: null,
  costCurrency: null,
  toolCallsCost: null,
  searchInvocations: null,
  searchResultItems: 0,
  searchResultEntries: 0,
  messageItems: 0,
});

/**
 * Minimal structural recognition used by the connector: an Agent `response`
 * object with a string `status` and an `output` array. Unknown extra fields and
 * unknown output item types are tolerated (forward compatibility); the legacy
 * Chat Completions shape is recognised only so it can be REJECTED.
 */
export function classifyAgentResponseShape(json: unknown): AgentResponseShape {
  if (!isPlainObject(json)) return "malformed";
  if (json.object === "response" && typeof json.status === "string" && Array.isArray(json.output)) return "agent";
  if (Array.isArray(json.choices)) return "legacy_chat";
  return "malformed";
}

/** Text of the last `type:"message"` item: its `output_text` parts (string `text`) joined in order. */
function finalMessageText(output: readonly unknown[]): { text: string | null; messageItems: number } {
  const messages = output.filter((item) => isPlainObject(item) && item.type === "message") as Record<string, unknown>[];
  if (messages.length === 0) return { text: null, messageItems: 0 };
  const last = messages[messages.length - 1];
  const content = Array.isArray(last.content) ? last.content : [];
  const parts = content
    .filter((part) => isPlainObject(part) && part.type === "output_text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text);
  const joined = parts.join("").trim();
  return { text: joined.length > 0 ? joined : null, messageItems: messages.length };
}

/**
 * The ONE definition of where Agent web-search results live: `output[]` items
 * with `type: "search_results"`, and each item's `results[]` entries, in
 * provider order. Entries are returned as-is (unvalidated, never copied or
 * mutated). The legacy top-level `search_results` / `citations` fields are
 * never read.
 */
export function agentSearchResultEntries(output: readonly unknown[]): { items: number; entries: unknown[] } {
  let items = 0;
  const entries: unknown[] = [];
  for (const item of output) {
    if (isPlainObject(item) && item.type === "search_results") {
      items += 1;
      if (Array.isArray(item.results)) for (const entry of item.results) entries.push(entry);
    }
  }
  return { items, entries };
}

function searchResultCounts(output: readonly unknown[]): { items: number; entries: number } {
  const { items, entries } = agentSearchResultEntries(output);
  return { items, entries: entries.length };
}

function parseUsage(raw: unknown): AgentUsage | null {
  if (!isPlainObject(raw)) return null;
  return {
    inputTokens: nonNegativeIntOrNull(raw.input_tokens),
    outputTokens: nonNegativeIntOrNull(raw.output_tokens),
    totalTokens: nonNegativeIntOrNull(raw.total_tokens),
  };
}

function parseError(raw: unknown): AgentParseResult["error"] {
  if (!isPlainObject(raw)) return null;
  const code = raw.code;
  return {
    type: typeof raw.type === "string" ? raw.type : null,
    code: typeof code === "number" || typeof code === "string" ? code : null,
    message: typeof raw.message === "string" ? raw.message : null,
  };
}

/** Parse any provider JSON body. Pure; never throws. */
export function parsePerplexityAgentResponse(json: unknown): AgentParseResult {
  const shape = classifyAgentResponseShape(json);
  if (shape !== "agent") {
    return { shape, status: null, incompleteReason: null, text: null, error: null, model: null, usage: null, diagnostics: { ...EMPTY_DIAGNOSTICS } };
  }
  const body = json as Record<string, unknown>;
  const output = body.output as unknown[];
  const { text, messageItems } = finalMessageText(output);
  const search = searchResultCounts(output);
  const usageRaw = isPlainObject(body.usage) ? body.usage : null;
  const cost = usageRaw && isPlainObject(usageRaw.cost) ? usageRaw.cost : null;
  const toolDetails = usageRaw && isPlainObject(usageRaw.tool_calls_details) ? usageRaw.tool_calls_details : null;
  const searchWeb = toolDetails && isPlainObject(toolDetails.search_web) ? toolDetails.search_web : null;
  const incomplete = isPlainObject(body.incomplete_details) ? body.incomplete_details : null;

  return {
    shape,
    status: body.status as string,
    incompleteReason: incomplete && typeof incomplete.reason === "string" ? incomplete.reason : null,
    text,
    error: parseError(body.error),
    model: typeof body.model === "string" ? body.model : null,
    usage: parseUsage(usageRaw),
    diagnostics: {
      costTotal: cost ? finiteNumberOrNull(cost.total_cost) : null,
      costCurrency: cost && typeof cost.currency === "string" ? cost.currency : null,
      toolCallsCost: cost ? finiteNumberOrNull(cost.tool_calls_cost) : null,
      searchInvocations: searchWeb ? nonNegativeIntOrNull(searchWeb.invocation) : null,
      searchResultItems: search.items,
      searchResultEntries: search.entries,
      messageItems,
    },
  };
}

export type AgentOutcome =
  | { kind: "ok"; text: string; finishReason: "stop" }
  | { kind: "truncated"; text: string; finishReason: "length" }
  | { kind: "error"; errorMessage: string };

/**
 * Decide the connector outcome from a parsed body. HTTP 200 is NOT success:
 * only a `completed` run with final text, or an `incomplete` run stopped by
 * `max_output_tokens` that still carries final text, yields an answer.
 *
 * Error messages keep the string forms that `lib/panel.ts` retry
 * classification depends on: a server-class Agent error carries an explicit
 * "(HTTP-equivalent 500)" so the existing 5xx pattern still matches, and a
 * numeric `error.code` (429, 5xx, 401, 403) is embedded verbatim.
 */
export function agentOutcome(parsed: AgentParseResult): AgentOutcome {
  if (parsed.shape === "legacy_chat") {
    return { kind: "error", errorMessage: "Perplexity API returned a legacy Chat Completions response; the Agent API response shape was expected." };
  }
  if (parsed.shape !== "agent") {
    return { kind: "error", errorMessage: "Perplexity API returned an unrecognized response shape." };
  }
  if (parsed.status === "completed" && parsed.text) return { kind: "ok", text: parsed.text, finishReason: "stop" };
  if (parsed.status === "incomplete" && parsed.incompleteReason === "max_output_tokens" && parsed.text) {
    return { kind: "truncated", text: parsed.text, finishReason: "length" };
  }
  if (parsed.status === "completed") {
    return { kind: "error", errorMessage: "Perplexity did not return any content." };
  }
  const err = parsed.error;
  const type = err?.type ?? "no_error_type";
  const code = err?.code ?? "no_code";
  const reason = parsed.incompleteReason ?? "none";
  const serverClass = err?.type != null && AGENT_SERVER_ERROR_TYPES.includes(err.type);
  const detail = err?.message ? ` - ${err.message.slice(0, 200)}` : "";
  return {
    kind: "error",
    errorMessage: `Perplexity agent run ${parsed.status}/${reason}: ${type} (${code})${serverClass ? " 5xx (HTTP-equivalent 500)" : ""}${detail}`,
  };
}
