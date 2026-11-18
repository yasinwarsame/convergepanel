/**
 * The inventory harness's markup reader (replaces the regex helpers CodeQL flagged at R4: js/double-escaping,
 * js/incomplete-multi-character-sanitization, js/bad-tag-filter). Pins the behaviours those queries are about.
 */
jest.mock("server-only", () => ({}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children: unknown }) => children }));

import { decodeEntitiesOnce, textNodes } from "./claimStatementInventory.harness";

describe("inventory text extraction", () => {
  it("decodes each entity reference exactly once (no double unescaping)", () => {
    expect(decodeEntitiesOnce("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
    expect(decodeEntitiesOnce("&#x27;a&#39; &quot;b&quot; &lt;c&gt; &amp;")).toBe(`'a' "b" <c> &`);
    expect(decodeEntitiesOnce("&unknown; &#xZZ;")).toBe("&unknown; &#xZZ;");
  });

  it("skips every comment form and tag, including '>' inside a quoted attribute, and keeps text only", () => {
    expect(textNodes(`<p title="a>b">One<!-- -->Two</p><!--x\n--!>y-->Three<br/>`)).toEqual(["One", "Two", "Three"]);
    expect(textNodes("<div>&lt;script&gt;</div>")).toEqual(["<script>"]);
    expect(textNodes("<span>  </span><span>a &amp; b</span>")).toEqual(["a & b"]);
  });
});
