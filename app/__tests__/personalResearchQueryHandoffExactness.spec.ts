/**
 * PERSONAL-RESEARCH-URL-1-C2 — QUERY HAND-OFF EXACTNESS.
 *
 * THE DEFECT THIS EXISTS FOR. Every producer of the root's `?tab=` hand-off
 * encodes its value EXACTLY ONCE, and `URLSearchParams.get()` performs the one
 * corresponding decode. `app/page.tsx` then ran `decodeURIComponent` a SECOND
 * time on `q` and `claim`. C1 stopped that second decode from THROWING on a bare
 * `%`, but not from silently rewriting content: a legitimate question like
 *
 *     What does %20 mean in a URL?
 *
 * was produced correctly (`q=What%20does%20%2520%20mean...`), decoded correctly by
 * `URLSearchParams` back to the original, and then decoded again — turning the
 * literal `%20` the user actually typed into a space. URL-1 promises that Run
 * follow-up preserves the root composer workflow; silently changing the question
 * breaks that promise.
 *
 * THE FROZEN CONTRACT (C2 §B): encode once → `URLSearchParams.get()` → the
 * returned string IS the application value. No second decoder, tolerant or not.
 *
 * WHAT IS REAL vs TRANSCRIBED. The OOM constraint on mounting `app/page.tsx` is
 * unchanged (see `personalResearchCanonicalNavigationRace.spec.tsx`), so:
 *   - the PRODUCERS are the REAL shipped builders;
 *   - `URLSearchParams` is the REAL platform decoder — these round-trips execute
 *     it, they do not compare source strings;
 *   - `consumeQueryHandoff` transcribes the shipped read step, and
 *     `§T8` pins the real `app/page.tsx` so it cannot regain a second decode
 *     without failing. That pin is the gap C1 had: the transcription already
 *     modelled the correct once-decode behaviour, nothing bound the shipped file
 *     to it, and the defect survived a green suite.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  personalResearchFollowUpHref,
  personalResearchVerifyClaimHref,
} from "@/lib/user/personalResearchHref";

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
const VERIFY_SOURCE = readFileSync(join(__dirname, "..", "verify", "page.tsx"), "utf8");

/**
 * The shipped read step, transcribed. `URLSearchParams` is real; the point of the
 * transcription is that there is NOTHING between `.get()` and the application
 * value.
 */
function consumeQueryHandoff(href: string) {
  const params = new URLSearchParams(href.slice(href.indexOf("?")));
  return {
    tab: params.get("tab"),
    q: params.get("q"),
    claim: params.get("claim"),
    originRunId: params.get("originRunId"),
    originClaimId: params.get("originClaimId"),
  };
}

/** The real `/verify` producer's expression, for the claim hand-off. */
function verifyPageClaimHref(claim: string) {
  return `/?tab=verify&claim=${encodeURIComponent(claim)}`;
}

describe("C2 §G T1 — a question containing a literal %20 round-trips exactly", () => {
  const QUESTION = "What does %20 mean in a URL?";

  it("survives producer → URLSearchParams unchanged, percent sign intact", () => {
    const href = personalResearchFollowUpHref(QUESTION)!;
    expect(consumeQueryHandoff(href).q).toBe(QUESTION);
    expect(consumeQueryHandoff(href).q).toContain("%20");
  });

  it("the wire form double-escapes the percent, proving exactly ONE encode", () => {
    const href = personalResearchFollowUpHref(QUESTION)!;
    // `%` → `%25`, so the literal "%20" travels as "%2520". A second decode on
    // the receiving side is what collapses it to a space.
    expect(href).toContain("%2520");
    expect(decodeURIComponent(consumeQueryHandoff(href).q!)).toBe("What does   mean in a URL?");
  });
});

describe("C2 §G T2 — percent-escape-shaped literals are never interpreted a second time", () => {
  it.each([
    ["%2F", "Is %2F the same as a slash?"],
    ["%25", "Why is %25 the escape for percent?"],
    ["%41", "Does %41 decode to A?"],
    ["%3F", "When must ? be written %3F?"],
    ["%00", "Is %00 a null byte?"],
    ["multiple", "Compare %20, %2F and %25 in one question"],
  ])("keeps %s literal", (_label, question) => {
    const href = personalResearchFollowUpHref(question)!;
    expect(consumeQueryHandoff(href).q).toBe(question);
  });
});

describe("C2 §G T3 — a bare percent still round-trips without throwing", () => {
  it.each([
    ["trailing", "Coverage rose to 50%"],
    ["mid-sentence", "50% of cases & #1 driver?"],
    ["adjacent", "100%% certain?"],
    ["percent then letters", "%zz is not an escape"],
  ])("handles a %s bare percent", (_label, question) => {
    const href = personalResearchFollowUpHref(question)!;
    expect(() => consumeQueryHandoff(href)).not.toThrow();
    expect(consumeQueryHandoff(href).q).toBe(question);
  });
});

describe("C2 §G T4 — reserved characters and Unicode survive exactly", () => {
  it.each([
    ["ampersand", "Tariffs & subsidies: which moved prices?"],
    ["hash", "What drove #1 ranking?"],
    ["plus", "Does 2+2 appear in the corpus?"],
    ["equals", "Is revenue = profit in this filing?"],
    ["spaces", "  leading and trailing were trimmed  "],
    ["query delimiters", "a?b=c&d=e#f"],
    ["unicode", "¿Qué % del café ☕ se exporta?"],
    ["emoji + escape", "🇬🇧 uses %20 too?"],
    ["quotes", `He said "50%" — did he?`],
  ])("preserves %s", (_label, question) => {
    const href = personalResearchFollowUpHref(question)!;
    // `.trim()` is the builder's documented normalisation; compare against it.
    expect(consumeQueryHandoff(href).q).toBe(question.trim());
  });

  it("a literal '+' is not silently turned into a space", () => {
    const href = personalResearchFollowUpHref("2+2 and C++")!;
    expect(href).toContain("%2B");
    expect(consumeQueryHandoff(href).q).toBe("2+2 and C++");
  });

  it("carries exactly the two expected parameters", () => {
    const href = personalResearchFollowUpHref("What does %20 mean?")!;
    const params = new URLSearchParams(href.slice(href.indexOf("?")));
    expect([...params.keys()].sort()).toEqual(["q", "tab"]);
    expect(params.get("tab")).toBe("research");
  });
});

describe("C2 §G T5 — ?tab=verify&claim= obeys the same once-decode rule", () => {
  it.each([
    ["literal %20", "The spec says %20 is a space"],
    ["literal %25", "%25 is the percent escape"],
    ["bare percent", "Inflation hit 9% last year"],
    ["reserved chars", "Growth & margin = #1 concern?"],
    ["unicode", "El café subió 12 %"],
  ])("keeps a claim containing %s exact", (_label, claim) => {
    const href = verifyPageClaimHref(claim);
    const consumed = consumeQueryHandoff(href);
    expect(consumed.tab).toBe("verify");
    expect(consumed.claim).toBe(claim);
  });

  it("a claim's literal %20 is not collapsed to a space", () => {
    const consumed = consumeQueryHandoff(verifyPageClaimHref("The spec says %20 is a space"));
    expect(consumed.claim).toContain("%20");
  });
});

describe("C2 §G T6 — personalResearchFollowUpHref encodes the outbound query exactly once", () => {
  it("produces the single-encoded wire form", () => {
    expect(personalResearchFollowUpHref("What does %20 mean in a URL?"))
      .toBe("/?tab=research&q=What%20does%20%2520%20mean%20in%20a%20URL%3F");
  });

  it("matches a single encodeURIComponent for arbitrary inputs", () => {
    for (const question of [
      "plain question",
      "50% of cases",
      "%2F and %25",
      "a&b=c#d",
      "¿Qué % del café?",
    ]) {
      expect(personalResearchFollowUpHref(question))
        .toBe(`/?tab=research&q=${encodeURIComponent(question)}`);
    }
  });
});

describe("C2 §G T7 — the /verify producer still encodes its claim exactly once", () => {
  it("builds both hand-off URLs with a single encodeURIComponent", () => {
    expect(VERIFY_SOURCE).toContain("`/?tab=verify&claim=${encodeURIComponent(claim)}`");
    expect(VERIFY_SOURCE).toContain("`/?tab=research&q=${encodeURIComponent(claim)}`");
  });

  it("never double-encodes", () => {
    expect(VERIFY_SOURCE).not.toMatch(/encodeURIComponent\(\s*encodeURIComponent/);
  });

  it("does not decode its own already-decoded search params", () => {
    // It reads `text` via searchParams.get() and uses it as-is: the same contract
    // this phase restores on the receiving side.
    expect(VERIFY_SOURCE).toContain('searchParams.get("text")');
    expect(VERIFY_SOURCE).not.toContain("decodeURIComponent");
  });
});

describe("C2 §G T8 — the root consumer applies NO decode after URLSearchParams", () => {
  it("reads q and claim straight into state", () => {
    expect(PAGE_SOURCE).toContain('const claim = params.get("claim");\n      if (claim) setClaimInput(claim);');
    expect(PAGE_SOURCE).toContain('const q = params.get("q");\n      if (q) setQuestion(q);');
  });

  it("contains no decodeURIComponent at all", () => {
    // The whole-module assertion is deliberate: a second decode reintroduced
    // under any name, at any of these sites, fails here.
    expect(PAGE_SOURCE).not.toContain("decodeURIComponent");
  });

  it("the C1 tolerant decoder and its legacy-compatibility claim are gone", () => {
    expect(PAGE_SOURCE).not.toContain("decodeQueryValueTolerantly");
    expect(PAGE_SOURCE).not.toMatch(/backward compatibility with already-encoded legacy links/);
  });

  it("no other tolerant/try-catch decoder wraps a search param", () => {
    expect(PAGE_SOURCE).not.toMatch(/setQuestion\(\s*\w+\s*\(/);
    expect(PAGE_SOURCE).not.toMatch(/setClaimInput\(\s*\w+\s*\(/);
  });
});

describe("C2 §G T9 — the origin-linked selector hand-off is unchanged", () => {
  it("round-trips both selectors exactly, with no extra decode", () => {
    const href = personalResearchVerifyClaimHref({ runId: "run-A", claimId: "claim-B" })!;
    const consumed = consumeQueryHandoff(href);
    expect(consumed.tab).toBe("verify");
    expect(consumed.originRunId).toBe("run-A");
    expect(consumed.originClaimId).toBe("claim-B");
  });

  it("survives ids that contain percent-escape-shaped text", () => {
    const href = personalResearchVerifyClaimHref({ runId: "run-%20-A", claimId: "claim-%2F-B" })!;
    const consumed = consumeQueryHandoff(href);
    expect(consumed.originRunId).toBe("run-%20-A");
    expect(consumed.originClaimId).toBe("claim-%2F-B");
  });

  it("the consumer still only .trim()s the selectors", () => {
    expect(PAGE_SOURCE).toContain("runId: originRunId.trim()");
    expect(PAGE_SOURCE).toContain("claimId: originClaimId.trim()");
  });
});
