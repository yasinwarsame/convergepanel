/**
 * Item 6A structural correction (owner Option A, 2026-11-23) — controlled test exception for comparisons against
 * HISTORICAL evidence (records, digests and goldens frozen before Item 6A).
 *
 * Item 6A changes exactly one thing in the text of a freshly built Decision Support Receipt: every criterion label is
 * written as escaped, quoted data (`Criterion: "Total cost"`, `Option × "Total cost": text`) instead of bare text, and
 * the unquoted model parts of an assessment line are line-safety escaped. Historical evidence holds the bare form.
 *
 * `toHistoricalReceiptLines` is the exact inverse, applied ONLY to the fresh side of a historical comparison:
 *  - only a `basis` line of an object shaped like a Decision Receipt (has string `conclusion` and array `basis`);
 *  - only the two Item 6A shapes, untagged criterion lines and assessment lines (a TAGGED line is never reverted, so a
 *    provenance difference can never be hidden);
 *  - a line is reverted only when re-encoding the reverted parts reproduces the line byte for byte; otherwise it is
 *    left unchanged (and the comparison fails visibly);
 *  - every reverted line is reported, so specs assert the exception's exact scope.
 */
import { escapeReceiptLineText, quoteReceiptLabel } from "@/lib/adaptiveSchema/criterionProvenance";

/** Inverse of escapeReceiptText for the body of a quoted label; null when the body is not a valid escape output. */
export function unescapeQuotedLabel(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') return null;
    if (c !== "\\") { out += c; continue; }
    const n = body[++i];
    if (n === "\\" || n === '"') out += n;
    else if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "u" && body[i + 1] === "{") {
      const end = body.indexOf("}", i);
      if (end < 0) return null;
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16));
      i = end;
    } else return null;
  }
  return quoteReceiptLabel(out) === `"${body}"` ? out : null;
}

/** Only identity line-safety escapes are invertible here (historical fixture text has no characters that escapeReceiptLineText changes). */
const lineTextUnchanged = (s: string) => escapeReceiptLineText(s) === s;

export function historicalReceiptLine(line: string): string {
  const criterion = /^Criterion: "(.*)"$/s.exec(line);
  if (criterion) {
    const label = unescapeQuotedLabel(criterion[1]);
    return label !== null ? `Criterion: ${label}` : line;
  }
  const assessment = /^(.*?) × "((?:[^"\\]|\\.)*)": (.*)$/s.exec(line);
  if (assessment) {
    const [, option, body, text] = assessment;
    const label = unescapeQuotedLabel(body);
    if (label !== null && lineTextUnchanged(option) && lineTextUnchanged(text) && `${option} × ${quoteReceiptLabel(label)}: ${text}` === line) return `${option} × ${label}: ${text}`;
  }
  return line;
}

export interface RevertedLine { from: string; to: string }

/**
 * `value` with every Item 6A Receipt basis line reverted to its historical form (a structured clone; the input is never
 * modified, and is returned as is when nothing is reverted). `reverted` collects each change.
 */
export function toHistoricalReceiptLines<T>(value: T, reverted: RevertedLine[] = []): T {
  const found: RevertedLine[] = [];
  const visit = (v: unknown, apply: boolean): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, apply); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.conclusion === "string" && Array.isArray(o.basis)) {
      o.basis.forEach((line, i) => {
        if (typeof line !== "string") return;
        const to = historicalReceiptLine(line);
        if (to === line) return;
        if (apply) (o.basis as unknown[])[i] = to;
        else found.push({ from: line, to });
      });
    }
    for (const x of Object.values(o)) visit(x, apply);
  };
  visit(value, false);
  if (found.length === 0) return value;
  const copy = structuredClone(value);
  visit(copy, true);
  reverted.push(...found);
  return copy;
}

/** historicalReceiptLine for one extracted export text node, which may carry a list-bullet prefix ("•  "). */
export function historicalReceiptText(node: string): string {
  const m = /^(•\s+)?([\s\S]*)$/.exec(node)!;
  const to = historicalReceiptLine(m[2]);
  return to === m[2] ? node : `${m[1] ?? ""}${to}`;
}

/** Serialized-DOM attribute marking the Item 6A dashboard label wrapper. */
export const ITEM6A_LABEL_BDI_OPEN = '<bdi data-testid="ds-criterion-label">';

/**
 * Item 6A controlled exception for page-parity comparisons against a pre-6A DOM baseline: removes ONLY the dashboard
 * label wrapper (`<bdi data-testid="ds-criterion-label">label</bdi>` → `label`) and reverts ONLY quoted Receipt lines
 * inside serialized (JSON-quoted) text nodes. Counts are returned so the spec pins the scope.
 */
export function undoItem6aPresentation(dom: string): { markup: string; bdi: number; quoted: number } {
  let bdi = 0;
  let quoted = 0;
  const open = ITEM6A_LABEL_BDI_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let markup = dom.replace(new RegExp(`${open}([^<]*)</bdi>`, "g"), (_m, inner: string) => {
    bdi++;
    return inner;
  });
  markup = markup.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
    let text: unknown;
    try {
      text = JSON.parse(token);
    } catch {
      return token;
    }
    if (typeof text !== "string") return token;
    const to = historicalReceiptLine(text);
    if (to === text) return token;
    quoted++;
    return JSON.stringify(to);
  });
  return { markup, bdi, quoted };
}
