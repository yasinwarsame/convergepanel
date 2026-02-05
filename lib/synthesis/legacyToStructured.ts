/**
 * Local Legacy HTML to Structured Synthesis Converter
 * 
 * Converts legacy HTML synthesis reports to a structured format synchronously,
 * without making any network calls. This allows immediate rendering of legacy
 * content while optionally enhancing it with structure.
 */

export type StructuredSynthesis = {
  title?: string;
  sections: Array<{
    heading: string;
    items?: Array<{ 
      kind: "bullet" | "paragraph"; 
      text: string; 
      tone?: "agree" | "disagree" | "uncertain" 
    }>;
  }>;
};

/**
 * Strips HTML tags and returns plain text
 */
function stripHtml(html: string): string {
  if (typeof document === "undefined") {
    // Server-side: use regex fallback
    return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || div.innerText || "").trim();
}

/**
 * Determines the tone of text based on keywords
 */
function asTone(text: string): "agree" | "disagree" | "uncertain" | undefined {
  const t = text.toLowerCase();
  if (t.includes("agree") || t.includes("consensus") || t.includes("unanimous")) {
    return "agree";
  }
  if (t.includes("disagree") || t.includes("contested") || t.includes("debate") || t.includes("diverg")) {
    return "disagree";
  }
  if (t.includes("uncertain") || t.includes("single-model") || t.includes("weak support")) {
    return "uncertain";
  }
  return undefined;
}

/**
 * Converts legacy HTML synthesis to structured format
 * 
 * This is a best-effort parser that extracts headings and content
 * from HTML. It doesn't need to be perfect - just enough to
 * provide structure for immediate rendering.
 * 
 * @param html - Legacy HTML synthesis report
 * @returns Structured synthesis or null if parsing fails
 */
export function legacyHtmlToStructured(html: string): StructuredSynthesis | null {
  if (!html || typeof html !== "string") {
    return null;
  }

  // Check if it looks like HTML
  if (!html.includes("<h") && !html.includes("<H")) {
    return null;
  }

  try {
    // Use DOMParser if available (browser), otherwise fall back to regex
    let doc: Document;
    if (typeof DOMParser !== "undefined") {
      doc = new DOMParser().parseFromString(html, "text/html");
    } else {
      // Server-side fallback: return null (we can't parse HTML without DOM)
      return null;
    }

    const sections: StructuredSynthesis["sections"] = [];
    const nodes = Array.from(doc.body.childNodes);
    let current: { heading: string; items: StructuredSynthesis["sections"][number]["items"] } | null = null;

    const pushCurrent = () => {
      if (current && current.items && current.items.length > 0) {
        sections.push({ heading: current.heading, items: current.items });
      }
      current = null;
    };

    for (const n of nodes) {
      if (n.nodeType !== 1) continue; // Skip non-element nodes
      const el = n as Element;
      const tag = el.tagName.toLowerCase();

      // Detect headings (h2, h3, h4)
      if (tag === "h2" || tag === "h3" || tag === "h4") {
        pushCurrent();
        const headingText = stripHtml(el.outerHTML);
        if (headingText) {
          current = { heading: headingText, items: [] };
        }
        continue;
      }

      // If we don't have a current section, skip content
      if (!current) continue;

      // Parse paragraphs
      if (tag === "p") {
        const text = stripHtml(el.outerHTML);
        if (text) {
          current.items!.push({ 
            kind: "paragraph", 
            text, 
            tone: asTone(text) 
          });
        }
      } 
      // Parse unordered lists
      else if (tag === "ul") {
        const lis = Array.from(el.querySelectorAll("li"));
        for (const li of lis) {
          const text = stripHtml(li.outerHTML);
          if (text) {
            current.items!.push({ 
              kind: "bullet", 
              text, 
              tone: asTone(text) 
            });
          }
        }
      } 
      // Parse divs (may contain paragraphs or other content)
      else if (tag === "div") {
        const text = stripHtml(el.outerHTML);
        if (text && text.length > 20) { // Only add if substantial content
          current.items!.push({ 
            kind: "paragraph", 
            text, 
            tone: asTone(text) 
          });
        }
      }
    }

    // Push the last section
    pushCurrent();

    // Extract title if present (first h1 or first heading)
    let title: string | undefined;
    const h1 = doc.querySelector("h1");
    if (h1) {
      title = stripHtml(h1.outerHTML);
    } else if (sections.length > 0) {
      title = sections[0].heading;
    }

    if (sections.length === 0) {
      return null;
    }

    return { title, sections };
  } catch (error) {
    console.warn("[legacyToStructured] Failed to parse HTML:", error);
    return null;
  }
}

