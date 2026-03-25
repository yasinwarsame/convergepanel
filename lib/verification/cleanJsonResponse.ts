/**
 * Strip markdown code fences and isolate a JSON object before JSON.parse.
 * Handles Gemini and other models that wrap JSON in ```json ... ``` or add prose.
 */
export function cleanJsonResponse(text: string): string {
  let cleaned = text.trim().replace(/^\uFEFF/, "");

  // Collect all fenced blocks (Gemini sometimes emits multiple ``` blocks; JSON is often last)
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(cleaned)) !== null) {
    blocks.push(m[1].trim());
  }
  if (blocks.length > 0) {
    const withJsonShape = [...blocks].reverse().find((b) => /^\s*[\[{]/.test(b));
    cleaned = (withJsonShape ?? blocks[blocks.length - 1]!).trim();
  }

  if (!cleaned.startsWith("{")) {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }

  // Single-element array wrapper: [{ "verdict": ... }]
  const t = cleaned.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0];
        if (first && typeof first === "object" && !Array.isArray(first)) {
          cleaned = JSON.stringify(first);
        }
      }
    } catch {
      /* keep cleaned as-is */
    }
  }

  return cleaned;
}

/**
 * Best-effort close of truncated JSON (e.g. max output tokens cut mid-object).
 * Does not recover missing content; helps JSON.parse succeed on partial structures.
 */
export function repairTruncatedJson(text: string): string {
  let repaired = text.trim();

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of repaired) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") openBraces++;
    if (char === "}") openBraces--;
    if (char === "[") openBrackets++;
    if (char === "]") openBrackets--;
  }

  if (inString) repaired += '"';

  while (openBrackets > 0) {
    repaired += "]";
    openBrackets--;
  }
  while (openBraces > 0) {
    repaired += "}";
    openBraces--;
  }

  return repaired;
}
