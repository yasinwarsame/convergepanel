import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { htmlText, htmlUnescape } from "./htmlText";

describe("Contract P test helper htmlText: each entity decoded once", () => {
  it("decodes React's five entities", () => {
    expect(htmlUnescape("&amp; &lt; &gt; &quot; &#x27;")).toBe(`& < > " '`);
  });

  it("an escaped entity stays literal text (a decoder that decodes &amp; and then its result again reads '&amp;lt;' as '<')", () => {
    expect(htmlUnescape("&amp;lt;b&amp;gt; &amp;amp; &amp;quot;")).toBe("&lt;b&gt; &amp; &quot;");
    expect(htmlUnescape("&amp;lt;b&amp;gt;")).not.toBe("<b>");
  });

  it("round-trips text React escaped, including text that looks like markup or an entity", () => {
    for (const t of ["<script>x</script>", "&lt;b&gt;", "Tom & Jerry's \"show\"", "a &amp; b"]) {
      expect(htmlText(renderToStaticMarkup(createElement("p", null, t)))).toBe(t);
    }
  });
});
