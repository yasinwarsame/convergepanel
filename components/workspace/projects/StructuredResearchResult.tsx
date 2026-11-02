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
 *
 * Two shapes get a dedicated layout (presentation follow-up to #276, owner-approved 2026-11-02), recognised by their
 * whole shape, never by a field name alone:
 *   - a list of claims whose fields and values exactly match the generic schema's claim (ClaimZod): the claim text
 *     leads, stance / model-reported confidence / evidence type follow as readable secondary metadata, the claim id
 *     stays visible in small print, and any camps are grouped as label + position;
 *   - a list of camps with exactly `label` and `position`: each label is grouped with its position.
 * Anything that does not match exactly (an extra field, an unknown value, a missing claim text) keeps the generic
 * layout above, so no stored value is ever hidden or relabelled by guesswork.
 */

import type { ReactNode } from "react";
import { CONFIDENCE_LABELS, EVIDENCE_TYPE_LABELS, STANCE_LABELS, claimLabel } from "@/lib/research/claimDisplayLabels";

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

type Camp = { label: string; position: string };
type Claim = { id?: string; claim: string; stance?: string; confidence?: string; evidenceType?: string; camps?: Camp[] };

const CLAIM_KEYS = new Set(["id", "claim", "stance", "confidence", "evidenceType", "camps"]);

function hasOnlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every((k) => allowed.has(k));
}

/** Exactly `{ label, position }`, both non-empty strings. */
function isCamp(value: unknown): value is Camp {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof value.label === "string" &&
    value.label.trim().length > 0 &&
    typeof value.position === "string" &&
    value.position.trim().length > 0
  );
}

function isCampList(items: unknown[]): items is Camp[] {
  return items.length > 0 && items.every(isCamp);
}

/** An optional enum field: absent, or a value that the label table knows. */
function optionalLabelled(value: unknown, table: Readonly<Record<string, string>>): boolean {
  return value === undefined || claimLabel(table, value) !== null;
}

/**
 * A claim in the generic schema's exact shape: only ClaimZod's fields; a non-empty claim text; at least one of stance,
 * confidence or evidence type; each present enum value known; the id a string if present; camps a list of exact camps
 * if present.
 */
function isClaim(value: unknown): value is Claim {
  if (!isPlainObject(value) || !hasOnlyKeys(value, CLAIM_KEYS)) return false;
  if (typeof value.claim !== "string" || value.claim.trim().length === 0) return false;
  if (value.id !== undefined && typeof value.id !== "string") return false;
  if (value.stance === undefined && value.confidence === undefined && value.evidenceType === undefined) return false;
  if (!optionalLabelled(value.stance, STANCE_LABELS)) return false;
  if (!optionalLabelled(value.confidence, CONFIDENCE_LABELS)) return false;
  if (!optionalLabelled(value.evidenceType, EVIDENCE_TYPE_LABELS)) return false;
  if (value.camps !== undefined && !(Array.isArray(value.camps) && value.camps.every(isCamp))) return false;
  return true;
}

function isClaimList(items: unknown[]): items is Claim[] {
  return items.length > 0 && items.every(isClaim);
}

/** Each camp's label grouped with its position, in the model's own wording. */
function CampListBlock({ camps }: { camps: Camp[] }) {
  return (
    <ul className="space-y-2" data-testid="structured-camps">
      {camps.map((camp, i) => (
        <li key={i} className="text-sm text-cp-text" data-testid="structured-camp">
          <span className="block break-words whitespace-pre-wrap font-semibold">{camp.label}</span>
          <span className="block break-words whitespace-pre-wrap">{camp.position}</span>
        </li>
      ))}
    </ul>
  );
}

/** One metadata item: a readable label, with the stored value kept on the element. */
function ClaimMeta({ term, value, label, title }: { term: string; value: string; label: string; title: string }) {
  return (
    <div className="flex gap-1" data-testid="claim-meta">
      <dt>{term}:</dt>
      <dd className="font-medium text-cp-text" data-value={value} title={title}>
        {label}
      </dd>
    </div>
  );
}

const CONFIDENCE_TITLE = "The answering model's own label for this claim, not a confidence verified by the panel.";

/** A claim list: the claim text leads; its metadata, camps and id are secondary. */
function ClaimListBlock({ claims }: { claims: Claim[] }) {
  return (
    <ul className="space-y-3">
      {claims.map((c, i) => {
        const stance = claimLabel(STANCE_LABELS, c.stance);
        const confidence = claimLabel(CONFIDENCE_LABELS, c.confidence);
        const evidence = claimLabel(EVIDENCE_TYPE_LABELS, c.evidenceType);
        return (
          <li key={i} className="rounded-lg border border-cp-border-soft bg-cp-surface p-3" data-testid="structured-claim">
            <p className="whitespace-pre-wrap break-words text-sm font-medium text-cp-text" data-testid="structured-claim-text">
              {c.claim}
            </p>
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cp-muted">
              {stance && c.stance && <ClaimMeta term="Stance" value={c.stance} label={stance} title={`Stored value: ${c.stance}`} />}
              {confidence && c.confidence && (
                <ClaimMeta term="Model-reported confidence" value={c.confidence} label={confidence} title={`${CONFIDENCE_TITLE} Stored value: ${c.confidence}`} />
              )}
              {evidence && c.evidenceType && <ClaimMeta term="Evidence type" value={c.evidenceType} label={evidence} title={`Stored value: ${c.evidenceType}`} />}
            </dl>
            {c.camps && c.camps.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-cp-muted">Competing positions</div>
                <div className="mt-1">
                  <CampListBlock camps={c.camps} />
                </div>
              </div>
            )}
            {c.id !== undefined && c.id.length > 0 && (
              <p className="mt-2 break-all text-xs text-cp-faint" data-testid="structured-claim-id">
                Claim ID: {c.id}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ArrayNode({ items, depth }: { items: unknown[]; depth: number }): ReactNode {
  const present = items.filter((item) => item !== null && item !== undefined);
  if (present.length === 0) return null;

  // Exact-shape layouts first; anything else falls through to the generic layout unchanged.
  if (isClaimList(present)) return <ClaimListBlock claims={present} />;
  if (isCampList(present)) return <CampListBlock camps={present} />;

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
