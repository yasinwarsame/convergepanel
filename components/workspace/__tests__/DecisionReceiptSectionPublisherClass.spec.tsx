/**
 * Order 4 — publisher-type badges on "Sources cited by the panel".
 * The links are unchanged; a badge appears only when the server attached a
 * `publisher` classification (flag on); wording is descriptive, never a score,
 * rank or quality judgement; the disclaimer states the non-claims verbatim.
 */
import { createElement } from "react";
import TestRenderer from "react-test-renderer";
import DecisionReceiptSection, { PUBLISHER_CLASS_DISCLAIMER_MESSAGE, PUBLISHER_CLASS_LABELS, SOURCES_DISCLAIMER_MESSAGE } from "@/components/workspace/DecisionReceiptSection";
import { classifySourcePublisher } from "@/lib/sourceAuthority/classifySourcePublisher";

const RAW = ["https://www.sec.gov/x", "https://who.int/news", "https://en.wikipedia.org/wiki/X", "https://www.reuters.com/y"];
const plainLinks = RAW.map((url) => ({ url, hostname: new URL(url).hostname }));
const classifiedLinks = RAW.map((url) => ({ url, hostname: new URL(url).hostname, publisher: classifySourcePublisher(url) }));

const receipt = (sources: unknown[]) => ({
  conclusion: "Overall risk is moderate.",
  basis: [],
  assumptions: [],
  uncertainties: [],
  limitations: [],
  sources,
  sourceBacked: true,
  humanReviewNeeded: true,
});
const render = (sources: unknown[]) => TestRenderer.create(createElement(DecisionReceiptSection, { receipt: receipt(sources), reviewOverview: "Overview." }));
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const textOf = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const links = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a").map((a) => ({ href: a.props.href, text: textOf(a), target: a.props.target, rel: a.props.rel }));

it("labels are pinned for every class — descriptive, no score, rank or quality words", () => {
  expect(PUBLISHER_CLASS_LABELS).toEqual({
    GOVERNMENT: "Government domain",
    INTERGOVERNMENTAL_ORGANIZATION: "Intergovernmental domain",
    ACADEMIC_INSTITUTION: "Academic institution domain",
    OPEN_CONTRIBUTION_PLATFORM: "Open-contribution platform",
    UNCLASSIFIED: "Unclassified domain",
  });
  expect(PUBLISHER_CLASS_DISCLAIMER_MESSAGE).toBe("Publisher type is inferred from the cited web address only — it does not mean the page exists, supports the panel's claim, or is accurate.");
});

it("flag off (no publisher metadata): no badge, no publisher disclaimer, the existing links and disclaimer exactly as before", () => {
  const r = render(plainLinks);
  expect(byTestId(r, "source-publisher-class")).toHaveLength(0);
  expect(byTestId(r, "source-publisher-disclaimer")).toHaveLength(0);
  expect(links(r)).toEqual(plainLinks.map((l) => ({ href: l.url, text: l.hostname, target: "_blank", rel: "noopener noreferrer" })));
  expect(JSON.stringify(r.toJSON())).toContain(SOURCES_DISCLAIMER_MESSAGE);
});

it("flag on: each link is unchanged (href, hostname text, target, rel, order) and carries its descriptive badge", () => {
  const r = render(classifiedLinks);
  expect(links(r)).toEqual(plainLinks.map((l) => ({ href: l.url, text: l.hostname, target: "_blank", rel: "noopener noreferrer" })));
  expect(byTestId(r, "source-publisher-class").map(textOf)).toEqual(["Government domain", "Intergovernmental domain", "Open-contribution platform", "Unclassified domain"]);
  expect(textOf(byTestId(r, "source-publisher-disclaimer")[0])).toBe(PUBLISHER_CLASS_DISCLAIMER_MESSAGE);
  expect(JSON.stringify(r.toJSON())).toContain(SOURCES_DISCLAIMER_MESSAGE); // the existing "not independently verified" line stays
});

it("ACADEMIC_INSTITUTION renders its neutral label when the server ever sends it", () => {
  const r = render([{ ...plainLinks[0], publisher: { ...classifySourcePublisher(RAW[0]), publisherClass: "ACADEMIC_INSTITUTION" } }]);
  expect(byTestId(r, "source-publisher-class").map(textOf)).toEqual(["Academic institution domain"]);
});

it("an unknown publisherClass on the wire renders no badge (fail closed), the link still renders", () => {
  const r = render([{ ...plainLinks[0], publisher: { publisherClass: "TRUSTED_SOURCE" } }]);
  expect(byTestId(r, "source-publisher-class")).toHaveLength(0);
  expect(byTestId(r, "source-publisher-disclaimer")).toHaveLength(0);
  expect(links(r)).toHaveLength(1);
});

it("no banned evaluative wording, no score, no ranking, no aggregate across sources", () => {
  const text = JSON.stringify(render(classifiedLinks).toJSON()).toLowerCase();
  for (const banned of ["trusted", "reliab", "verified source", "best", "high quality", "high-quality", "authority", "credib", "score", "rank", "%", "strong source", "government-backed"]) {
    expect({ banned, present: text.includes(banned) }).toEqual({ banned, present: false });
  }
  // Exactly one badge per displayed source and no rollup/summary line.
  expect(byTestId(render(classifiedLinks), "source-publisher-class")).toHaveLength(RAW.length);
  expect(text).not.toMatch(/\d+ (government|intergovernmental|unclassified|open-contribution)/);
});

describe("B4 — source order is never publisher-ranked", () => {
  /** Deliberately incompatible with any class ranking: open-contribution, unclassified, government, intergovernmental. */
  const UNRANKED = ["https://en.wikipedia.org/wiki/X", "https://www.reuters.com/y", "https://www.sec.gov/x", "https://who.int/news"];
  it("links and badges render in exactly the input order (no GOVERNMENT-first or any class ordering)", () => {
    const r = render(UNRANKED.map((url) => ({ url, hostname: new URL(url).hostname, publisher: classifySourcePublisher(url) })));
    expect(links(r).map((l) => l.href)).toEqual(UNRANKED);
    expect(byTestId(r, "source-publisher-class").map(textOf)).toEqual(["Open-contribution platform", "Unclassified domain", "Government domain", "Intergovernmental domain"]);
    // Each badge sits in the same <li> as its own link.
    const items = r.root.findAll((n) => n.type === "li" && n.findAll((c) => c.type === "a").length === 1);
    expect(items.map((li) => [li.findAll((c) => c.type === "a")[0].props.href, textOf(li.findAll((c) => typeof c.type === "string" && c.props["data-testid"] === "source-publisher-class")[0])])).toEqual([
      [UNRANKED[0], "Open-contribution platform"],
      [UNRANKED[1], "Unclassified domain"],
      [UNRANKED[2], "Government domain"],
      [UNRANKED[3], "Intergovernmental domain"],
    ]);
  });
});

describe("P2 — inherited / prototype property names on the wire never become labels", () => {
  it.each(["toString", "constructor", "__defineGetter__", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"])("publisherClass %p → link renders, no badge, no publisher disclaimer, no throw", (hostile) => {
    // `hostile` is only a string VALUE here — no object is built with that key, so nothing is polluted.
    let r!: TestRenderer.ReactTestRenderer;
    expect(() => {
      r = render([{ ...plainLinks[0], publisher: { publisherClass: hostile, reasonCode: "no_rule_matched", matchedRule: null, host: "www.sec.gov", classifierVersion: 1 } }]);
    }).not.toThrow();
    expect(links(r)).toEqual([{ href: plainLinks[0].url, text: plainLinks[0].hostname, target: "_blank", rel: "noopener noreferrer" }]);
    expect(byTestId(r, "source-publisher-class")).toHaveLength(0);
    expect(byTestId(r, "source-publisher-disclaimer")).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).not.toMatch(/function|\[native code\]|\[object Object\]/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
