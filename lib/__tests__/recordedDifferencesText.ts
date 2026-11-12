/**
 * Test helper (not a spec): split a surface's text into its "Recorded differences not counted as model disagreements"
 * section(s) and everything else, so a spec can assert BOTH that a non-genuine stored difference is retained (inside the
 * section) AND that it is never presented as a disagreement (absent everywhere outside it).
 *
 * A section is its heading line plus the lines that belong to it: the explanatory note, bulleted items ("- ", "• ",
 * "→ ") and their indented detail lines ("  "). The single-line X form ("Recorded difference …") is a section of its own.
 */
import { RECORDED_DIFFERENCES_HEADING, RECORDED_DIFFERENCES_NOTE } from "@/lib/verificationGate/panelVerdict";
import {
  RESEARCH_MEMO_RECORDED_DIFFERENCES_HEADING,
  RESEARCH_MEMO_RECORDED_DIFFERENCES_NOTE,
} from "@/lib/verification/generateMemo";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sectionPattern(): RegExp {
  const headings = [RECORDED_DIFFERENCES_HEADING, RESEARCH_MEMO_RECORDED_DIFFERENCES_HEADING].map(esc).join("|");
  const notes = [RECORDED_DIFFERENCES_NOTE, RESEARCH_MEMO_RECORDED_DIFFERENCES_NOTE].map(esc).join("|");
  return new RegExp(`(?:${headings})[^\\n]*(?:\\n(?:[-•→] |  |${notes})[^\\n]*)*|Recorded difference[^\\n]*`, "g");
}

/** The recorded-differences section(s) of a text, joined (empty when there is none). */
export function recordedDifferenceSections(text: string): string {
  return (text.match(sectionPattern()) ?? []).join("\n");
}

/** The text with every recorded-differences section removed. */
export function outsideRecordedDifferences(text: string): string {
  return text.replace(sectionPattern(), "");
}
