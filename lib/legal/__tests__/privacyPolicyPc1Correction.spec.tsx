/**
 * PC-1 (owner PP-01, 2026-11-25). This spec checks two things:
 *  (a) the rendered Privacy Policy and Help pages no longer carry the false or unsupported statements, and carry the
 *      corrected one;
 *  (b) each fact the corrected paragraph states is still true of the code that stores the data. The oracle reads the
 *      real source files, so a change to storage that falsifies the text fails here.
 */
import fs from "fs";
import path from "path";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
import HelpPage from "@/app/help/page";

const ROOT = path.resolve(__dirname, "../../..");
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const privacy = text(renderToStaticMarkup(<PrivacyPage />));
const help = text(renderToStaticMarkup(<HelpPage />));

describe("PC-1 rendered pages", () => {
  it("the false storage sentence and the unsupported 7-day log claim are gone", () => {
    expect(privacy).not.toMatch(/do not store the actual questions/i);
    expect(privacy).not.toMatch(/typically deleted within 7 days/i);
    expect(privacy).not.toMatch(/\b7 days\b|\bseven days\b/i);
  });

  it("states that submitted content and AI results are stored to provide history and reports", () => {
    expect(privacy).toContain(
      "We store the content you submit and the results the AI models return, so that we can provide your research history and reports and let you reopen them later."
    );
    expect(privacy).toContain(
      "For Deep Research, this includes your question, any context you add, the answers the AI models return (shortened for storage when they are very long), the combined report and, where they apply, the review and governance records for the run."
    );
    expect(privacy).toContain(
      "For Claim Verification, it includes the claim you submit (up to 2,000 characters) and each AI model's structured result."
    );
  });

  it("makes no retention or deletion promise (PP-01: no unsupported retention guarantee)", () => {
    expect(privacy).toContain("This policy does not promise that this content is deleted within any fixed period.");
    // The corrected paragraph alone must not introduce a period, a deletion commitment or a training claim.
    const para = privacy.slice(privacy.indexOf("Content you submit and the results."), privacy.indexOf("3. How We Use Your Information"));
    expect(para.length).toBeGreaterThan(100);
    expect(para).not.toMatch(/\b\d+\s*(day|days|week|weeks|month|months|year|years)\b/i);
    expect(para).not.toMatch(/\b(train|training|encrypt|logs?)\b/i);
    expect(para).not.toMatch(/\bwe (will )?(delete|remove|purge)\b/i);
  });

  it("the Help page no longer claims longer history retention on paid tiers", () => {
    expect(help).not.toMatch(/history retention/i);
    expect(help).toContain(
      "More models per run (up to five on the full plan), higher monthly run limits, and video verification with its own monthly allowance (each video also uses one panel run). The 5-Model plan adds governance dashboards, peer review, and the review audit log."
    );
  });
});

describe("PC-1 statements are true of the code (oracle reads the real sources)", () => {
  it("Claim Verification stores the claim, capped at 2,000 characters, and each model's structured summary", () => {
    const route = src("app/api/verify-claim/route.ts");
    expect(route).toMatch(/const MAX_CLAIM_LEN = 2000;/);
    expect(route).toMatch(/claim: claimText\.slice\(0, MAX_CLAIM_LEN\)/);
    const store = src("lib/firestore/verifications.ts");
    expect(store).toMatch(/\n\s+claim: string;/);
    expect(store).toMatch(/\n\s+modelResults: StoredVerificationModelSummary\[\];/);
  });

  it("Deep Research stores the question, context, per-model answer text (shortened for storage), the report and governance records", () => {
    const runs = src("lib/firestore/runs.ts");
    expect(runs).toMatch(/\n\s+question: string;/);
    expect(runs).toMatch(/\n\s+questionContext\?: string;/);
    expect(runs).toMatch(/truncateForStorage\(sanitizedText, MAX_CHARS_STORAGE_PER_MODEL\)/);
    expect(runs).toMatch(/export async function persistAdaptiveOutput\(/);
    expect(runs).toMatch(/export async function persistGovernanceRecord\(/);
  });

  it("nothing enforces a history period, so the page states none (historyRetentionDays is declared but never read)", () => {
    // historyRetentionDays appears only in lib/plans.ts (its declaration and plan values), never in app/lib/components code.
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(rel);
        return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
      });
    const readers = ["app", "lib", "components", "hooks"]
      .filter((d) => fs.existsSync(path.join(ROOT, d)))
      .flatMap(walk)
      .filter((f) => f !== path.join("lib", "plans.ts") && src(f).includes("historyRetentionDays"));
    expect(readers).toEqual([]);
  });
});
