/**
 * Test-only helper for the frozen-baseline parity suites (executing-model attribution, 2026-11-05).
 *
 * Owner rule (connector fail-closed pass): a slot the run records as answered by a substitute model is named by the
 * model that wrote its text — "DeepSeek (substituting Claude)" — never as the requested model, on every agreement /
 * support surface. The frozen baselines (2c17feee / 9eca1e3) were captured before that rule and name such a slot by its
 * family ("Claude"), with the family's identity dot on chips.
 *
 * This reverses EXACTLY that attribution and nothing else, so every other byte is still held to the frozen baseline:
 *  - a chip whose dot is the neutral `bg-cp-faint` immediately followed by the executing label → the slot's own dot
 *    colour and family name;
 *  - every other occurrence of the executing label → the family name.
 * The label and the dot colours are spelled out here independently of the code under test (never its own copy).
 * Callers also assert the count: >0 exactly where the record has a recorded substituted slot, 0 elsewhere.
 */

export type RecordedSubstitution = { slot: string; provider: string };

const FAMILY: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", perplexity: "Perplexity", gemini: "Gemini" };
const PROVIDER: Record<string, string> = { deepseek: "DeepSeek" };
const DOT: Record<string, string> = { chatgpt: "bg-emerald-500", claude: "bg-indigo-500", grok: "bg-amber-500", perplexity: "bg-sky-500", gemini: "bg-rose-500" };

export function executingLabelFor(sub: RecordedSubstitution): { label: string; family: string } {
  const family = FAMILY[sub.slot];
  const provider = PROVIDER[sub.provider];
  if (!family || !provider) throw new Error(`executingAttributionStrip: unknown slot/provider ${sub.slot}/${sub.provider}`);
  return { label: `${provider} (substituting ${family})`, family };
}

/** Substitutions recorded on run rows (live ModelResult or saved perModel shape). */
export function recordedSubstitutions(rows: ReadonlyArray<{ modelId: string; status?: unknown; provider?: unknown }>): RecordedSubstitution[] {
  return rows
    .filter((r) => r && r.status === "substituted" && typeof r.provider === "string")
    .map((r) => ({ slot: String(r.modelId), provider: String(r.provider).toLowerCase() }));
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Works on both serializers the parity suites use: static markup (`class="…" aria-hidden="true"></span>Label`) and the
 * react-test-renderer JSON form (`className="…"></span>"Label`).
 */
export function undoExecutingAttributionHtml(html: string, subs: readonly RecordedSubstitution[]): { markup: string; count: number } {
  let count = 0;
  let out = html;
  for (const sub of subs) {
    const { label, family } = executingLabelFor(sub);
    const chip = new RegExp(`"h-2 w-2 shrink-0 rounded-full bg-cp-faint"([^<>]*)></span>("?)${escapeRe(label)}`, "g");
    out = out.replace(chip, (_m, attrs: string, quote: string) => {
      count++;
      return `"h-2 w-2 shrink-0 rounded-full ${DOT[sub.slot]}"${attrs}></span>${quote}${family}`;
    });
    count += out.split(label).length - 1;
    out = out.split(label).join(family);
  }
  return { markup: out, count };
}

/** Deep string replacement of the executing label in a JSON value (builder output). */
export function undoExecutingAttributionValue<T>(value: T, subs: readonly RecordedSubstitution[]): { value: T; count: number } {
  let json = JSON.stringify(value);
  let count = 0;
  for (const sub of subs) {
    const { label, family } = executingLabelFor(sub);
    const escaped = JSON.stringify(label).slice(1, -1);
    count += json.split(escaped).length - 1;
    json = json.split(escaped).join(JSON.stringify(family).slice(1, -1));
  }
  return { value: JSON.parse(json), count };
}
