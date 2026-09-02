/**
 * Team Project Research, follow-up to PR #130's JSON-pretty-print hotfix —
 * a small, fully GENERIC renderer that turns an arbitrary JSON-shaped
 * `rawTextFull` payload (object or array, already `JSON.parse`d by the
 * caller) into a readable research report: humanized field labels, plain
 * paragraphs, bullet lists, and nested labeled sub-sections — no visible
 * braces/quotes/commas/camelCase keys.
 *
 * Deliberately NOT schema-driven: Team never reads the validated `adaptive`
 * field from the run response (see `hooks/useTeamProjectResearch.ts`'s
 * `parseRunResponse()`), so there is no `schemaId`/field-spec to key off —
 * `rawTextFull` is just each model's own unvalidated text, merely prompted
 * toward some shape. This renderer works by mechanical structural
 * inspection alone (typeof / Array.isArray / key-name transformation), not
 * `switch(key)` special-casing, so it degrades gracefully for any future
 * field name or shape.
 *
 * Also deliberately NOT `components/adaptive/*` — those are schema-driven
 * (`AdaptiveRendererProps`/`AdaptiveModelResult`), tightly coupled to
 * Personal's adaptive-schema orchestration, and don't even humanize keys.
 * This file has zero dependency on that system.
 *
 * Safety: every value is rendered through plain React text children / JSX
 * element trees — never `dangerouslySetInnerHTML`, never string-concatenated
 * HTML, never `eval`. A model-returned string containing `<script>...</script>`
 * renders as inert visible text (React escapes text children by default).
 *
 * No markdown engine is introduced here — string leaf values render as
 * plain wrapped text, matching Team's existing plain-text convention.
 */

import type { ReactNode } from "react";

/**
 * Converts a camelCase / PascalCase / snake_case / kebab-case (or any mix)
 * field key into a readable sentence-case label — e.g. `directAnswer` →
 * "Direct answer", `contributing_factors` → "Contributing factors",
 * `alternative-explanations` → "Alternative explanations",
 * `PascalCaseThing` → "Pascal case thing". Purely mechanical: no
 * per-field/per-word dictionary, so it works for any future/unknown key.
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    // camelCase / PascalCase boundaries: lower/digit → upper ("directAnswer" -> "direct Answer")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // acronym boundaries: "ABCFoo" -> "ABC Foo"
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  const lower = spaced.toLowerCase();
  if (lower.length === 0) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Lowercase-alnum-only form of a key, for separator/case-insensitive matching. */
function normalizeForMatch(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDirectAnswerKey(key: string): boolean {
  return normalizeForMatch(key) === "directanswer";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Renders an array of plain strings as a bullet list. */
function StringListBlock({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-cp-text">
      {items.map((item, i) => (
        <li key={i} className="break-words whitespace-pre-wrap">
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Renders a mixed-primitive (numbers/booleans, possibly nested shapes) array as a bullet list. */
function MixedListBlock({ items, depth }: { items: unknown[]; depth: number }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-sm text-cp-text">
      {items.map((item, i) => (
        <li key={i} className="break-words">
          <ValueNode value={item} depth={depth} />
        </li>
      ))}
    </ul>
  );
}

/** Renders an array of objects as repeated readable blocks (not serialized JSON). */
function ObjectListBlock({ items, depth }: { items: Record<string, unknown>[]; depth: number }) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-cp-border-soft bg-cp-surface p-3">
          <ObjectFieldsBlock obj={item} depth={depth} />
        </div>
      ))}
    </div>
  );
}

function ArrayNode({ items, depth }: { items: unknown[]; depth: number }): ReactNode {
  const present = items.filter((item) => item !== null && item !== undefined);
  if (present.length === 0) return null;

  if (present.every((item) => typeof item === "string")) {
    return <StringListBlock items={present as string[]} />;
  }
  if (present.every((item) => isPlainObject(item))) {
    return <ObjectListBlock items={present as Record<string, unknown>[]} depth={depth + 1} />;
  }
  return <MixedListBlock items={present} depth={depth + 1} />;
}

/** A nested object renders as an indented labeled sub-section, recursing into its own fields. */
function ObjectNode({ obj, depth }: { obj: Record<string, unknown>; depth: number }): ReactNode {
  const fields = <ObjectFieldsBlock obj={obj} depth={depth + 1} />;
  return <div className="ml-3 space-y-4 border-l-2 border-cp-border-soft pl-3">{fields}</div>;
}

function ValueNode({ value, depth, emphasize }: { value: unknown; depth: number; emphasize?: boolean }): ReactNode {
  if (isEmptyValue(value)) return null;

  if (typeof value === "string") {
    return (
      <p className={emphasize ? "whitespace-pre-wrap break-words text-base font-semibold text-cp-text" : "whitespace-pre-wrap break-words text-sm text-cp-text"}>
        {value}
      </p>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="text-sm text-cp-text">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return <ArrayNode items={value} depth={depth} />;
  }
  if (isPlainObject(value)) {
    return <ObjectNode obj={value} depth={depth} />;
  }
  // Anything else (shouldn't occur from JSON.parse output) — omit rather than crash.
  return null;
}

/** One labeled field: humanized key heading + recursively-rendered value. Omits itself entirely if the value renders to nothing. */
function FieldBlock({ rawKey, value, depth, emphasize }: { rawKey: string; value: unknown; depth: number; emphasize?: boolean }) {
  // Bail before rendering an empty labeled section (ValueNode itself would render nothing for these).
  if (isEmptyValue(value)) return null;
  const rendered = <ValueNode value={value} depth={depth} emphasize={emphasize} />;

  return (
    <div>
      <div className={emphasize ? "text-sm font-semibold uppercase tracking-wide text-cp-muted" : "text-xs font-semibold uppercase tracking-wide text-cp-muted"}>
        {humanizeKey(rawKey)}
      </div>
      <div className="mt-1">{rendered}</div>
    </div>
  );
}

/**
 * Renders every (non-empty) key/value pair of an object, in original
 * insertion order, unless `promoteDirectAnswer` is set — in which case a
 * `directAnswer`-equivalent field (case/separator-insensitive match) is
 * moved first and given modest visual emphasis. Only applied at the true
 * top level per the rendering contract; nested objects always keep their
 * original field order.
 */
function ObjectFieldsBlock({ obj, depth, promoteDirectAnswer }: { obj: Record<string, unknown>; depth: number; promoteDirectAnswer?: boolean }) {
  const entries = Object.entries(obj).filter(([, v]) => !isEmptyValue(v));
  if (entries.length === 0) return null;

  let ordered = entries;
  if (promoteDirectAnswer) {
    const idx = entries.findIndex(([k]) => isDirectAnswerKey(k));
    if (idx > 0) {
      ordered = [entries[idx], ...entries.slice(0, idx), ...entries.slice(idx + 1)];
    }
  }

  return (
    <div className="space-y-4">
      {ordered.map(([key, value]) => (
        <FieldBlock key={key} rawKey={key} value={value} depth={depth} emphasize={promoteDirectAnswer && isDirectAnswerKey(key)} />
      ))}
    </div>
  );
}

/**
 * Entry point: renders an already-`JSON.parse`d structured value (a
 * non-null object or array) as a readable research report. Returns `null`
 * for an empty object/array, matching the "omit empty sections" contract.
 */
export default function StructuredResearchResult({ value }: { value: unknown }): JSX.Element | null {
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return null;
    return <ObjectFieldsBlock obj={value} depth={0} promoteDirectAnswer />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return <ArrayNode items={value} depth={0} />;
  }
  return null;
}
