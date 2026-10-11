/**
 * Order 4 Slice 2b — Workspace Source Standing on "Sources cited by the panel".
 *
 * Presentation only: a badge appears only when the server attached `standing`
 * (server flag on). Exact, Workspace-qualified wording; one neutral treatment
 * for every state; the current-state date only; no successor link; publisher
 * class independent; hostile wire data never becomes a label.
 */
import { createElement } from "react";
import TestRenderer from "react-test-renderer";
import { Timestamp } from "firebase-admin/firestore";
import DecisionReceiptSection, {
  PUBLISHER_CLASS_DISCLAIMER_MESSAGE,
  SOURCE_STANDING_DISCLAIMER_MESSAGE,
  SOURCE_STANDING_LABELS,
  SOURCES_DISCLAIMER_MESSAGE,
  formatStandingDate,
  toRenderableStanding,
} from "@/components/workspace/DecisionReceiptSection";
import { classifySourcePublisher } from "@/lib/sourceAuthority/classifySourcePublisher";
import { sourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";
import { resolveSourceStanding, toStandingPresentation, type StandingLookup } from "@/lib/sourceStanding/resolveStanding";

const AS_OF = "2026-10-01T12:00:00.000Z";
const AS_OF_TEXT = "Workspace standing updated Oct 1, 2026";
const URLS = ["https://www.sec.gov/x", "https://en.wikipedia.org/wiki/X", "https://www.reuters.com/y", "https://who.int/news", "https://example.org/z"];
const link = (url: string, extra: Record<string, unknown> = {}) => ({ url, hostname: new URL(url).hostname, ...extra });

const receipt = (sources: unknown[], over: Record<string, unknown> = {}) => ({
  conclusion: "Overall risk is moderate.",
  basis: [],
  assumptions: [],
  uncertainties: [],
  limitations: [],
  sources,
  sourceBacked: true,
  humanReviewNeeded: true,
  ...over,
});
const render = (sources: unknown[], over: Record<string, unknown> = {}) => TestRenderer.create(createElement(DecisionReceiptSection, { receipt: receipt(sources, over), reviewOverview: "Overview." }));
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const textOf = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const links = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "a").map((a) => ({ href: a.props.href, text: textOf(a), target: a.props.target, rel: a.props.rel }));
const expectedLinks = (urls: string[]) => urls.map((u) => ({ href: u, text: new URL(u).hostname, target: "_blank", rel: "noopener noreferrer" }));
const allText = (r: TestRenderer.ReactTestRenderer) => textOf(r.root);
/** The rendered <li> rows of the sources list, each as [link text, ...metadata texts] in DOM order. */
const rows = (r: TestRenderer.ReactTestRenderer) =>
  r.root
    .findAll((n) => n.type === "li" && n.findAll((c) => c.type === "a").length === 1)
    .map((li) => li.children.filter((c): c is TestRenderer.ReactTestInstance => typeof c !== "string").map(textOf));

describe("frozen vocabulary", () => {
  it("exact labels and disclaimer", () => {
    expect(SOURCE_STANDING_LABELS).toEqual({
      ACCEPTED: "Accepted by this Workspace",
      DISPUTED: "Disputed in this Workspace",
      SUPERSEDED: "Superseded in this Workspace",
      UNRESOLVED: "Workspace standing unavailable",
    });
    expect(Object.isFrozen(SOURCE_STANDING_LABELS)).toBe(true);
    expect(SOURCE_STANDING_DISCLAIMER_MESSAGE).toBe("Workspace standing reflects a recorded decision within this Workspace. It does not mean the page exists, supports the panel's claim, or is accurate.");
  });
});

describe("each state", () => {
  it.each([
    ["ACCEPTED", "Accepted by this Workspace"],
    ["DISPUTED", "Disputed in this Workspace"],
    ["SUPERSEDED", "Superseded in this Workspace"],
  ])("%s: exact label, current-state date, standing disclaimer, existing disclaimer, link unchanged", (status, label) => {
    const r = render([link(URLS[0], { standing: { status, asOf: AS_OF } })]);
    expect(byTestId(r, "source-standing").map(textOf)).toEqual([label]);
    expect(byTestId(r, "source-standing-updated").map(textOf)).toEqual([AS_OF_TEXT]);
    expect(byTestId(r, "source-standing-disclaimer").map(textOf)).toEqual([SOURCE_STANDING_DISCLAIMER_MESSAGE]);
    expect(allText(r)).toContain(SOURCES_DISCLAIMER_MESSAGE);
    expect(links(r)).toEqual(expectedLinks([URLS[0]]));
  });

  it("SUPERSEDED never renders its successor: no extra link, no successor host, no 'replaced by' text", () => {
    const successor = "https://successor.example.net/new-doc";
    const r = render([link(URLS[0], { standing: { status: "SUPERSEDED", asOf: AS_OF, successorUrl: successor } }), link(URLS[1])]);
    expect(links(r)).toEqual(expectedLinks([URLS[0], URLS[1]]));
    const json = JSON.stringify(r.toJSON());
    for (const leaked of [successor, "successor.example.net", "new-doc"]) expect(json).not.toContain(leaked);
    expect(allText(r).toLowerCase()).not.toMatch(/replaced by|successor|replacement|see instead/);
  });

  it("UNRESOLVED: visible 'unavailable' label, no date, disclaimer present, no guessed state", () => {
    const r = render([link(URLS[0], { standing: { status: "UNRESOLVED" } })]);
    expect(byTestId(r, "source-standing").map(textOf)).toEqual(["Workspace standing unavailable"]);
    expect(byTestId(r, "source-standing-updated")).toHaveLength(0);
    expect(byTestId(r, "source-standing-disclaimer")).toHaveLength(1);
    expect(allText(r)).not.toMatch(/Accepted|Disputed|Superseded|updated/);
  });

  it("UNRESOLVED never carries a date — not even one supplied on the wire, and never today's", () => {
    const r = render([link(URLS[0], { standing: { status: "UNRESOLVED", asOf: AS_OF } })]);
    expect(byTestId(r, "source-standing-updated")).toHaveLength(0);
    expect(allText(r)).not.toContain("Oct 1, 2026");
    const today = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date());
    expect(allText(r)).not.toContain(today);
  });

  it("absent: no badge, no date, no standing disclaimer; existing link and disclaimer unchanged", () => {
    const r = render([link(URLS[0]), link(URLS[1])]);
    expect(byTestId(r, "source-standing")).toHaveLength(0);
    expect(byTestId(r, "source-standing-updated")).toHaveLength(0);
    expect(byTestId(r, "source-standing-disclaimer")).toHaveLength(0);
    expect(links(r)).toEqual(expectedLinks([URLS[0], URLS[1]]));
    expect(allText(r)).toContain(SOURCES_DISCLAIMER_MESSAGE);
  });

  it("the standing disclaimer appears once, however many sources carry standing", () => {
    const r = render(URLS.slice(0, 3).map((u) => link(u, { standing: { status: "DISPUTED", asOf: AS_OF } })));
    expect(byTestId(r, "source-standing-disclaimer")).toHaveLength(1);
  });
});

describe("publisher class and standing are independent", () => {
  it.each([
    ["https://www.sec.gov/x", "Government domain", { status: "DISPUTED", asOf: AS_OF }, "Disputed in this Workspace"],
    ["https://en.wikipedia.org/wiki/X", "Open-contribution platform", { status: "ACCEPTED", asOf: AS_OF }, "Accepted by this Workspace"],
    ["https://www.reuters.com/y", "Unclassified domain", { status: "SUPERSEDED", asOf: AS_OF }, "Superseded in this Workspace"],
  ])("%s: %s + %s — both badges, same row, publisher first, then standing", (url, publisherLabelText, standing, standingLabel) => {
    const r = render([link(url, { publisher: classifySourcePublisher(url), standing })]);
    expect(rows(r)).toEqual([[new URL(url).hostname, publisherLabelText, standingLabel, AS_OF_TEXT]]);
    expect(byTestId(r, "source-publisher-disclaimer").map(textOf)).toEqual([PUBLISHER_CLASS_DISCLAIMER_MESSAGE]);
    expect(byTestId(r, "source-standing-disclaimer").map(textOf)).toEqual([SOURCE_STANDING_DISCLAIMER_MESSAGE]);
    expect(allText(r)).toContain(SOURCES_DISCLAIMER_MESSAGE); // all three disclaimers coexist
    expect(links(r)).toEqual(expectedLinks([url]));
  });

  it("publisher class never implies standing (GOVERNMENT without standing has no standing badge)", () => {
    const url = "https://www.sec.gov/x";
    const r = render([link(url, { publisher: classifySourcePublisher(url) })]);
    expect(byTestId(r, "source-publisher-class").map(textOf)).toEqual(["Government domain"]);
    expect(byTestId(r, "source-standing")).toHaveLength(0);
    expect(byTestId(r, "source-standing-disclaimer")).toHaveLength(0);
  });

  it("standing never alters the publisher badge (same publisher text with and without standing)", () => {
    const url = "https://en.wikipedia.org/wiki/X";
    const without = render([link(url, { publisher: classifySourcePublisher(url) })]);
    const withStanding = render([link(url, { publisher: classifySourcePublisher(url), standing: { status: "DISPUTED", asOf: AS_OF } })]);
    expect(byTestId(withStanding, "source-publisher-class").map(textOf)).toEqual(byTestId(without, "source-publisher-class").map(textOf));
  });
});

describe("order and pairing", () => {
  it("input order is authoritative: DISPUTED, absent, ACCEPTED, SUPERSEDED, UNRESOLVED — no sorting or grouping, badges stay on their own row", () => {
    const standings = [{ status: "DISPUTED", asOf: AS_OF }, undefined, { status: "ACCEPTED", asOf: AS_OF }, { status: "SUPERSEDED", asOf: AS_OF }, { status: "UNRESOLVED" }];
    const r = render(URLS.map((u, i) => link(u, standings[i] ? { standing: standings[i] } : {})));
    expect(links(r)).toEqual(expectedLinks(URLS));
    expect(rows(r)).toEqual([
      ["www.sec.gov", "Disputed in this Workspace", AS_OF_TEXT],
      ["en.wikipedia.org"],
      ["www.reuters.com", "Accepted by this Workspace", AS_OF_TEXT],
      ["who.int", "Superseded in this Workspace", AS_OF_TEXT],
      ["example.org", "Workspace standing unavailable"],
    ]);
  });
});

describe("hostile wire data", () => {
  const HOSTILE: Array<[string, unknown]> = [
    ["unknown status", { status: "TRUSTED_SOURCE", asOf: AS_OF }],
    ["lower-case status", { status: "accepted", asOf: AS_OF }],
    ...["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable"].map((s): [string, unknown] => [`prototype name ${s}`, { status: s, asOf: AS_OF }]),
    ["valid status missing asOf", { status: "ACCEPTED" }],
    ["valid status non-string asOf", { status: "DISPUTED", asOf: 1790000000000 }],
    ["valid status malformed date", { status: "SUPERSEDED", asOf: "not-a-date" }],
    ["valid status impossible date", { status: "ACCEPTED", asOf: "2026-02-30T00:00:00.000Z" }],
    ["valid status non-ISO date string", { status: "ACCEPTED", asOf: "October 1, 2026" }],
    ["inherited status", Object.create({ status: "ACCEPTED", asOf: AS_OF })],
    ["inherited asOf", Object.assign(Object.create({ asOf: AS_OF }), { status: "ACCEPTED" })],
    ["inherited UNRESOLVED", Object.create({ status: "UNRESOLVED" })],
    ["array", ["ACCEPTED", AS_OF]],
    ["string", "ACCEPTED"],
    ["null", null],
    ["number status", { status: 1, asOf: AS_OF }],
  ];

  it.each(HOSTILE)("%s → no standing badge, no date, no disclaimer, link still renders, no crash", (_n, standing) => {
    const r = render([link(URLS[0], { standing })]);
    expect(byTestId(r, "source-standing")).toHaveLength(0);
    expect(byTestId(r, "source-standing-updated")).toHaveLength(0);
    expect(byTestId(r, "source-standing-disclaimer")).toHaveLength(0);
    expect(links(r)).toEqual(expectedLinks([URLS[0]]));
    expect(allText(r)).not.toContain("Workspace standing unavailable"); // malformed is never relabelled UNRESOLVED
  });

  it("internal fields beside a valid status are never displayed", () => {
    const standing = { status: "DISPUTED", asOf: AS_OF, actorUid: "uid-secret-123", actorRole: "admin", updatedByUid: "uid-secret-456", reasonCode: "inaccurate_or_unreliable_for_workspace", revision: 42, idHash: "f".repeat(64) };
    const r = render([link(URLS[0], { standing })]);
    expect(byTestId(r, "source-standing").map(textOf)).toEqual(["Disputed in this Workspace"]);
    const json = JSON.stringify(r.toJSON());
    for (const leaked of ["uid-secret-123", "uid-secret-456", "admin", "inaccurate_or_unreliable_for_workspace", "unreliable", "42", "f".repeat(64)]) expect(json).not.toContain(leaked);
  });

  it("toRenderableStanding returns only status/label(/asOf)", () => {
    expect(toRenderableStanding({ status: "ACCEPTED", asOf: AS_OF, actorUid: "x", successorUrl: "https://a.example.com" })).toEqual({ status: "ACCEPTED", label: "Accepted by this Workspace", asOf: AS_OF });
    expect(toRenderableStanding({ status: "UNRESOLVED", asOf: AS_OF, reasonCode: "x" })).toEqual({ status: "UNRESOLVED", label: "Workspace standing unavailable" });
  });

  it("the standing date formatter is pinned to en-US + UTC at construction (machine-zone independent — guards UTC CI runners too)", () => {
    // Jest sandboxes process.env, so changing TZ in-test cannot reach ICU; instead capture the exact options the
    // module passes when it builds its formatter in a fresh module registry.
    const RealDTF = Intl.DateTimeFormat;
    const seen: Array<[unknown, Intl.DateTimeFormatOptions | undefined]> = [];
    const spy = jest.spyOn(Intl, "DateTimeFormat").mockImplementation(((locales?: string | string[], options?: Intl.DateTimeFormatOptions) => {
      seen.push([locales, options]);
      return new RealDTF(locales, options);
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
      jest.isolateModules(() => {
        jest.requireActual("@/components/workspace/DecisionReceiptSection");
      });
    } finally {
      spy.mockRestore();
    }
    const standingFormatters = seen.filter(([, o]) => o && o.year === "numeric" && o.month === "short" && o.day === "numeric" && o.hour === undefined);
    expect(standingFormatters.length).toBeGreaterThanOrEqual(1);
    for (const [locales, options] of standingFormatters) {
      expect(locales).toBe("en-US");
      expect(options?.timeZone).toBe("UTC");
    }
    // The module's formatStandingDate really goes through THAT pinned formatter (not some other date call).
    const formatCalls: Date[] = [];
    const spy2 = jest.spyOn(Intl, "DateTimeFormat").mockImplementation(((locales?: string | string[], options?: Intl.DateTimeFormatOptions) => {
      const real = new RealDTF(locales, options);
      if (options?.timeZone === "UTC" && options?.month === "short") {
        const origFormat = real.format.bind(real);
        // `format` is a prototype getter; shadow it with an own property on this instance.
        Object.defineProperty(real, "format", {
          value: (d?: Date | number) => {
            formatCalls.push(new Date(d as Date));
            return origFormat(d);
          },
        });
      }
      return real;
    }) as unknown as typeof Intl.DateTimeFormat);
    let fresh!: typeof import("@/components/workspace/DecisionReceiptSection");
    try {
      jest.isolateModules(() => {
        fresh = jest.requireActual("@/components/workspace/DecisionReceiptSection");
      });
    } finally {
      spy2.mockRestore();
    }
    expect(fresh.formatStandingDate("2026-10-01T23:30:00.000Z")).toBe("Oct 1, 2026");
    expect(formatCalls.map((d) => d.toISOString())).toEqual(["2026-10-01T23:30:00.000Z"]);
    // And behaviourally: a late-UTC instant formats as its UTC date.
    expect(formatStandingDate("2026-10-01T23:30:00.000Z")).toBe("Oct 1, 2026");
    expect(formatStandingDate("2026-10-01T00:30:00.000Z")).toBe("Oct 1, 2026");
  });

  it("formatStandingDate: deterministic UTC date, never 'Invalid Date', never today's date for bad input", () => {
    expect(formatStandingDate("2026-10-01T23:59:59.999Z")).toBe("Oct 1, 2026");
    expect(formatStandingDate("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
    for (const bad of ["", "Invalid Date", "2026-13-01T00:00:00.000Z", "2026-10-01", "2026-10-01T00:00:00Z", " 2026-10-01T00:00:00.000Z"]) expect(formatStandingDate(bad)).toBeNull();
  });
});

describe("terminology and aggregation guards", () => {
  const BANNED = /trusted|trustworthy|verified|authoritative|reliable|credibility|score|rank|high[- ]quality|low quality|fact-checked|certified|safe source|approved source|good source|bad source|confirmed/i;
  it("no standing text (labels, date line, disclaimer) uses evaluative or certification wording", () => {
    const standings = [{ status: "ACCEPTED", asOf: AS_OF }, { status: "DISPUTED", asOf: AS_OF }, { status: "SUPERSEDED", asOf: AS_OF }, { status: "UNRESOLVED" }];
    const r = render(standings.map((s, i) => link(URLS[i], { standing: s })));
    const standingText = [...byTestId(r, "source-standing"), ...byTestId(r, "source-standing-updated"), ...byTestId(r, "source-standing-disclaimer")].map(textOf).join(" | ");
    expect(standingText).not.toMatch(BANNED);
    expect(Object.values(SOURCE_STANDING_LABELS).join(" ")).not.toMatch(BANNED);
    // "Accepted" is always Workspace-qualified.
    for (const label of byTestId(r, "source-standing").map(textOf)) if (/Accepted/.test(label)) expect(label).toBe("Accepted by this Workspace");
  });

  it("no aggregate standing UI: no counts, totals or 'overall' statements", () => {
    const r = render(URLS.map((u) => link(u, { standing: { status: "ACCEPTED", asOf: AS_OF } })));
    // Scope to the Sources section (the receipt's own conclusion is model text, not standing UI).
    const sourcesSection = r.root.find((n) => n.type === "div" && n.children.some((c) => typeof c !== "string" && c.type === "h3" && textOf(c) === "Sources cited by the panel"));
    expect(textOf(sourcesSection)).not.toMatch(/\d+\s+(accepted|disputed|superseded)|overall|source health|authority (score|rating)|most sources/i);
    expect(byTestId(r, "source-standing")).toHaveLength(URLS.length); // one per row, nothing else
  });

  it("all four states share one neutral visual treatment: identical classes, no icon, no colour semantics", () => {
    const standings = [{ status: "ACCEPTED", asOf: AS_OF }, { status: "DISPUTED", asOf: AS_OF }, { status: "SUPERSEDED", asOf: AS_OF }, { status: "UNRESOLVED" }];
    const r = render(standings.map((s, i) => link(URLS[i], { standing: s })));
    const badges = byTestId(r, "source-standing");
    const classes = new Set(badges.map((b) => b.props.className));
    expect(classes.size).toBe(1);
    const [cls] = [...classes];
    expect(cls).not.toMatch(/green|red|emerald|rose|amber|yellow|orange|success|danger|warning|cp-orange|cp-accent/);
    // Publisher and standing badges look the same: metadata, not a verdict.
    const publisherClass = render([link("https://www.sec.gov/x", { publisher: classifySourcePublisher("https://www.sec.gov/x") })]);
    expect(byTestId(publisherClass, "source-publisher-class")[0].props.className).toBe(cls);
    for (const b of badges) {
      expect(b.props.style).toBeUndefined(); // no inline colour either
      expect(b.children.every((c) => typeof c === "string")).toBe(true); // plain visible text, no icon element
      expect(b.props.title).toBeUndefined();
      expect(b.props["aria-hidden"]).toBeUndefined();
    }
    expect(textOf(r.root)).not.toMatch(/[✓✔✗✘★☆⚠🛡]/u);
    // The date line is neutral too: one class set for every valid state, no inline style.
    const dates = byTestId(r, "source-standing-updated");
    expect(dates).toHaveLength(3);
    expect(new Set(dates.map((d) => d.props.className)).size).toBe(1);
    expect(dates[0].props.className).not.toMatch(/green|red|emerald|rose|amber|yellow|orange|success|danger|warning|cp-orange|cp-accent/);
    for (const d of dates) expect(d.props.style).toBeUndefined();
  });
});

describe("no coupling to other receipt fields", () => {
  it("standing never changes the conclusion, source-backed line, review-needed line, lists, links or existing disclaimers", () => {
    const base = URLS.map((u) => link(u));
    const withStanding = URLS.map((u, i) => link(u, { standing: i % 2 ? { status: "DISPUTED", asOf: AS_OF } : { status: "UNRESOLVED" } }));
    const strip = (r: TestRenderer.ReactTestRenderer) => {
      const json = JSON.parse(JSON.stringify(r.toJSON()));
      const prune = (n: any): any => {
        if (!n || typeof n !== "object") return n;
        if (n.props && typeof n.props["data-testid"] === "string" && n.props["data-testid"].startsWith("source-standing")) return null;
        return { ...n, children: n.children ? n.children.map(prune).filter((c: unknown) => c !== null) : n.children };
      };
      return prune(json);
    };
    for (const over of [{}, { sourceBacked: false }, { humanReviewNeeded: false }]) {
      expect(strip(render(withStanding, over))).toEqual(strip(render(base, over)));
    }
    expect(allText(render(withStanding, { sourceBacked: false }))).toContain("Not source-backed"); // DISPUTED never flips it
  });
});

describe("server → UI integration (the exact Review Context projection)", () => {
  const WS = "ws-1";
  const record = (url: string, fields: Record<string, unknown>) => ({
    schemaVersion: 1,
    workspaceId: WS,
    identity: sourceIdentityV1(url),
    revision: 3,
    updatedAt: Timestamp.fromMillis(Date.parse(AS_OF)),
    updatedByUid: "uid-admin",
    ...fields,
  });
  /** Run the REAL resolver + presentation projection (what Review Context attaches), then render it. */
  function serverStanding(url: string, store: Record<string, unknown>) {
    const id = sourceIdentityV1(url)!.idHash;
    const lookup: StandingLookup = (h) => (Object.prototype.hasOwnProperty.call(store, h) ? { state: "present", data: store[h] } : { state: "absent" });
    const res = resolveSourceStanding(WS, id, lookup);
    if (res.kind === "needs") throw new Error("fixture incomplete");
    return toStandingPresentation(res);
  }

  it("ACCEPTED / DISPUTED / SUPERSEDED (with a resolvable successor) / UNRESOLVED from real server records render correctly, successor never linked", () => {
    const succUrl = "https://www.sec.gov/successor-doc";
    const store: Record<string, unknown> = {
      [sourceIdentityV1(URLS[0])!.idHash]: record(URLS[0], { status: "ACCEPTED", reasonCode: "primary_document" }),
      [sourceIdentityV1(URLS[1])!.idHash]: record(URLS[1], { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" }),
      [sourceIdentityV1(succUrl)!.idHash]: record(succUrl, { status: "ACCEPTED", reasonCode: "designated_reference" }),
      [sourceIdentityV1(URLS[2])!.idHash]: record(URLS[2], { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: sourceIdentityV1(succUrl)!.idHash }),
      [sourceIdentityV1(URLS[3])!.idHash]: { junk: true }, // malformed on the server → UNRESOLVED
    };
    const sources = URLS.slice(0, 5).map((u) => {
      const standing = serverStanding(u, store);
      return standing ? link(u, { standing }) : link(u);
    });
    // Sanity: the server really sent a successorUrl for the SUPERSEDED row.
    expect((sources[2] as any).standing.successorUrl).toBe(succUrl);
    const r = render(sources);
    expect(rows(r)).toEqual([
      ["www.sec.gov", "Accepted by this Workspace", AS_OF_TEXT],
      ["en.wikipedia.org", "Disputed in this Workspace", AS_OF_TEXT],
      ["www.reuters.com", "Superseded in this Workspace", AS_OF_TEXT],
      ["who.int", "Workspace standing unavailable"],
      ["example.org"],
    ]);
    expect(links(r)).toEqual(expectedLinks(URLS));
    expect(JSON.stringify(r.toJSON())).not.toContain("successor-doc");
    expect(JSON.stringify(r.toJSON())).not.toContain("uid-admin");
  });
});

describe("flag-off zero change (no `standing` on the wire)", () => {
  /**
   * sha256 of the FULL rendered tree (TestRenderer JSON) produced by the BASELINE component at main 177b1950
   * for these exact fixtures — captured by rendering the baseline file, not this one. Any drift in the
   * no-standing render (links, publisher badges, disclaimers, structure, classes) fails here.
   */
  const BASELINE_PLAIN_SHA256 = "786b978b9f102d993359c75ef2285e9b6fb95dfc9ec72cf83055b0754b352d2d";
  const BASELINE_PUBLISHER_SHA256 = "43ad6bd4d8160e086516242c87260f7dfea3fc7fd1d96c775b54b46317ac1030";
  const urls = ["https://www.sec.gov/x", "https://en.wikipedia.org/wiki/X", "https://www.reuters.com/y"];
  const mk = (pub: boolean) => urls.map((u) => ({ url: u, hostname: new URL(u).hostname, ...(pub ? { publisher: classifySourcePublisher(u) } : {}) }));
  const sha = (s: string) => require("crypto").createHash("sha256").update(s).digest("hex");
  const renderJson = (s: unknown[]) =>
    JSON.stringify(TestRenderer.create(createElement(DecisionReceiptSection, { receipt: { conclusion: "Overall risk is moderate.", basis: ["b"], assumptions: [], uncertainties: [], limitations: [], sources: s, sourceBacked: true, humanReviewNeeded: true }, reviewOverview: "Overview." })).toJSON());

  it("plain links: byte-identical to the baseline render", () => {
    expect(sha(renderJson(mk(false)))).toBe(BASELINE_PLAIN_SHA256);
  });

  it("publisher badges (live in Production): byte-identical to the baseline render", () => {
    expect(sha(renderJson(mk(true)))).toBe(BASELINE_PUBLISHER_SHA256);
  });
});
