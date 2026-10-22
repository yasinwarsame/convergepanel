/**
 * Order 5 Contract P test helper: the visible text of server-rendered markup. React escapes text as &amp; &lt; &gt;
 * &quot; &#x27;; each entity is decoded once, in a single pass, so markup "&amp;lt;" reads as the text "&lt;", never "<"
 * (chained replaces decode "&amp;" first and then decode its result again — CodeQL js/double-escaping).
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };

export const htmlUnescape = (s: string): string => s.replace(/&(amp|lt|gt|quot|#x27);/g, (_m, e: string) => ENTITIES[e]);

export const htmlText = (html: string): string => htmlUnescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
