#!/usr/bin/env python3
"""
One-shot script: add relatedLinks to indexed pages in lib/pseo/pages.ts
pointing to non-indexed pages.

LINKING PLAN: for each indexed source slug, the new link targets to add.
Links are appended to existing relatedLinks, or a new relatedLinks block
is inserted before the page's cta: field.
"""

import re, sys

FILE = "lib/pseo/pages.ts"

# Linking plan: indexed source slug -> list of (label, href) to ADD
PLAN = {
    "claim-verification-for-journalists": [
        ("AI video verification for journalists", "/use-cases/ai-video-verification-for-journalists"),
        ("How to fact-check breaking news claims", "/use-cases/how-to-fact-check-breaking-news-claims"),
        ("Verification checklist for journalists", "/use-cases/verification-checklist-for-journalists"),
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
        ("How journalists can verify viral clips", "/use-cases/how-journalists-can-verify-viral-clips"),
    ],
    "claim-verification-for-researchers": [
        ("Video authenticity review for researchers", "/use-cases/video-authenticity-review-for-researchers"),
        ("How to verify information for a video script", "/use-cases/how-to-verify-information-for-a-video-script"),
        ("AI tools for investigative journalists", "/use-cases/ai-tools-for-investigative-journalists"),
    ],
    "claim-verification-for-analysts": [
        ("AI video verification for journalists", "/use-cases/ai-video-verification-for-journalists"),
        ("How to fact-check breaking news claims", "/use-cases/how-to-fact-check-breaking-news-claims"),
        ("How to verify public statements quickly", "/use-cases/how-to-verify-public-statements-quickly"),
        ("How to pressure-test investor pitch claims", "/use-cases/how-to-pressure-test-investor-pitch-claims"),
    ],
    "ai-claim-verification-for-finance-teams": [
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
        ("How to pressure-test investor pitch claims", "/use-cases/how-to-pressure-test-investor-pitch-claims"),
        ("AI decision support for founders", "/use-cases/ai-decision-support-for-founders"),
    ],
    "ai-claim-verification-for-policy-teams": [
        ("How to verify public statements quickly", "/use-cases/how-to-verify-public-statements-quickly"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
    ],
    "ai-video-review-for-media-teams": [
        ("Video authenticity review for fact-checkers", "/use-cases/video-authenticity-review-for-fact-checkers"),
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
        ("How journalists can verify viral clips", "/use-cases/how-journalists-can-verify-viral-clips"),
    ],
    "deep-research-with-multiple-ai-models": [
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
        ("AI research tool for YouTubers", "/use-cases/ai-research-tool-for-youtubers"),
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
        ("How to get multiple AI perspectives on a startup idea", "/use-cases/how-to-get-multiple-ai-perspectives-on-a-startup-idea"),
    ],
    "how-to-compare-chatgpt-claude-gemini-grok-perplexity-for-research": [
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "ai-governance-workflow-for-enterprise-teams": [
        ("AI audit trail software", "/use-cases/ai-audit-trail-software"),
        ("AI accountability workflow", "/use-cases/ai-accountability-workflow"),
        ("AI review process for teams", "/use-cases/ai-review-process-for-teams"),
        ("How to track AI decision-making", "/use-cases/how-to-track-ai-decision-making"),
        ("AI trust dashboard for decision support", "/use-cases/ai-trust-dashboard-for-decision-support"),
    ],
    "ai-peer-review-for-high-stakes-workflows": [
        ("How to prove an AI decision was reviewed", "/use-cases/how-to-prove-an-ai-decision-was-reviewed"),
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("AI risk review tool", "/use-cases/ai-risk-review-tool"),
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("AI tools for investigative journalists", "/use-cases/ai-tools-for-investigative-journalists"),
    ],
    "why-not-trust-one-ai-model-for-serious-decisions": [
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
        ("How to validate a business idea with AI", "/use-cases/how-to-validate-a-business-idea-with-ai"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to get multiple AI perspectives on a startup idea", "/use-cases/how-to-get-multiple-ai-perspectives-on-a-startup-idea"),
    ],
    "what-is-a-verification-gate": [
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
        ("Verification checklist for journalists", "/use-cases/verification-checklist-for-journalists"),
        ("AI review process for teams", "/use-cases/ai-review-process-for-teams"),
    ],
    "what-is-a-panel-verdict": [
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("AI trust dashboard for decision support", "/use-cases/ai-trust-dashboard-for-decision-support"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "what-is-source-grounding-in-ai": [
        ("How to verify information for a video script", "/use-cases/how-to-verify-information-for-a-video-script"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
    ],
    "single-model-vs-multi-model-verification": [
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
    ],
    "how-to-verify-a-viral-claim-with-ai": [
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
        ("AI video verification for content creators", "/use-cases/ai-video-verification-for-content-creators"),
        ("How to fact-check a reaction video", "/use-cases/how-to-fact-check-a-reaction-video"),
        ("How creators can fact-check videos", "/use-cases/how-creators-can-fact-check-videos"),
    ],
    "how-to-verify-a-viral-claim-before-sharing-it": [
        ("Video authenticity review for fact-checkers", "/use-cases/video-authenticity-review-for-fact-checkers"),
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
        ("Verification checklist for journalists", "/use-cases/verification-checklist-for-journalists"),
    ],
    "how-to-verify-a-viral-health-claim": [
        ("Video authenticity review for researchers", "/use-cases/video-authenticity-review-for-researchers"),
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
    ],
    "how-to-verify-a-viral-finance-claim": [
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
        ("How to pressure-test investor pitch claims", "/use-cases/how-to-pressure-test-investor-pitch-claims"),
        ("How to validate a business idea with AI", "/use-cases/how-to-validate-a-business-idea-with-ai"),
    ],
    "how-to-verify-a-viral-political-claim": [
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
    ],
    "how-to-verify-a-viral-ai-claim": [
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
        ("AI video verification for content creators", "/use-cases/ai-video-verification-for-content-creators"),
        ("How to fact-check a reaction video", "/use-cases/how-to-fact-check-a-reaction-video"),
    ],
    "how-to-verify-a-viral-climate-claim": [
        ("Video authenticity review for researchers", "/use-cases/video-authenticity-review-for-researchers"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
    ],
    "ai-claim-verification-for-content-creators": [
        ("AI video verification for content creators", "/use-cases/ai-video-verification-for-content-creators"),
        ("How creators can fact-check videos", "/use-cases/how-creators-can-fact-check-videos"),
        ("AI research tool for YouTubers", "/use-cases/ai-research-tool-for-youtubers"),
        ("How to fact-check a reaction video", "/use-cases/how-to-fact-check-a-reaction-video"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
    ],
    "ai-claim-verification-for-founders": [
        ("How to validate a business idea with AI", "/use-cases/how-to-validate-a-business-idea-with-ai"),
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
        ("How to test business assumptions with AI", "/use-cases/how-to-test-business-assumptions-with-ai"),
        ("How to get multiple AI perspectives on a startup idea", "/use-cases/how-to-get-multiple-ai-perspectives-on-a-startup-idea"),
        ("AI decision support for founders", "/use-cases/ai-decision-support-for-founders"),
    ],
    "ai-claim-verification-for-newsrooms": [
        ("AI video verification for journalists", "/use-cases/ai-video-verification-for-journalists"),
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
        ("Verification checklist for journalists", "/use-cases/verification-checklist-for-journalists"),
        ("How journalists can verify viral clips", "/use-cases/how-journalists-can-verify-viral-clips"),
    ],
    "ai-claim-verification-for-educators": [
        ("How to verify information for a video script", "/use-cases/how-to-verify-information-for-a-video-script"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
        ("How to verify public statements quickly", "/use-cases/how-to-verify-public-statements-quickly"),
    ],
    "ai-claim-verification-for-investigators": [
        ("AI tools for investigative journalists", "/use-cases/ai-tools-for-investigative-journalists"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
    ],
    "ai-claim-verification-for-knowledge-workers": [
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to validate AI-generated research", "/use-cases/how-to-validate-ai-generated-research"),
    ],
    "ai-research-for-decision-making-teams": [
        ("How to validate a business idea with AI", "/use-cases/how-to-validate-a-business-idea-with-ai"),
        ("How to test business assumptions with AI", "/use-cases/how-to-test-business-assumptions-with-ai"),
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
        ("AI decision support for founders", "/use-cases/ai-decision-support-for-founders"),
    ],
    "single-ai-model-vs-multi-model-verification": [
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
    ],
    "chatgpt-vs-claude-vs-gemini-for-research": [
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("AI research tool for YouTubers", "/use-cases/ai-research-tool-for-youtubers"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "ai-search-vs-ai-verification": [
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
    ],
    "ai-fact-checking-vs-claim-verification": [
        ("How to fact-check breaking news claims", "/use-cases/how-to-fact-check-breaking-news-claims"),
        ("Verification checklist for journalists", "/use-cases/verification-checklist-for-journalists"),
        ("Newsroom AI verification workflow", "/use-cases/newsroom-ai-verification-workflow"),
    ],
    "ai-summarizer-vs-multi-model-research-panel": [
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("AI research tool for YouTubers", "/use-cases/ai-research-tool-for-youtubers"),
    ],
    "perplexity-vs-multi-model-panel-for-research": [
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "what-is-a-decision-receipt": [
        ("AI decision audit trail", "/use-cases/ai-decision-audit-trail"),
        ("How to prove an AI decision was reviewed", "/use-cases/how-to-prove-an-ai-decision-was-reviewed"),
        ("AI trust dashboard for decision support", "/use-cases/ai-trust-dashboard-for-decision-support"),
        ("How to track AI decision-making", "/use-cases/how-to-track-ai-decision-making"),
    ],
    "how-to-create-an-ai-audit-trail": [
        ("AI audit trail software", "/use-cases/ai-audit-trail-software"),
        ("AI decision audit trail", "/use-cases/ai-decision-audit-trail"),
        ("How to track AI decision-making", "/use-cases/how-to-track-ai-decision-making"),
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
    ],
    "ai-governance-for-small-teams": [
        ("AI audit trail software", "/use-cases/ai-audit-trail-software"),
        ("AI accountability workflow", "/use-cases/ai-accountability-workflow"),
        ("AI review process for teams", "/use-cases/ai-review-process-for-teams"),
        ("How to track AI decision-making", "/use-cases/how-to-track-ai-decision-making"),
        ("AI risk review tool", "/use-cases/ai-risk-review-tool"),
    ],
    "how-to-document-an-ai-assisted-research-decision": [
        ("AI decision audit trail", "/use-cases/ai-decision-audit-trail"),
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("AI accountability workflow", "/use-cases/ai-accountability-workflow"),
    ],
    "why-teams-need-to-slow-down-ai-decisions": [
        ("How to prove an AI decision was reviewed", "/use-cases/how-to-prove-an-ai-decision-was-reviewed"),
        ("AI accountability workflow", "/use-cases/ai-accountability-workflow"),
        ("AI risk review tool", "/use-cases/ai-risk-review-tool"),
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
    ],
    "what-is-a-consensus-score": [
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("AI trust dashboard for decision support", "/use-cases/ai-trust-dashboard-for-decision-support"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "how-to-sanity-check-a-viral-clip": [
        ("Video authenticity review for fact-checkers", "/use-cases/video-authenticity-review-for-fact-checkers"),
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
        ("How journalists can verify viral clips", "/use-cases/how-journalists-can-verify-viral-clips"),
        ("AI video verification for journalists", "/use-cases/ai-video-verification-for-journalists"),
        ("How to check if a viral video might be manipulated", "/use-cases/how-to-check-if-a-viral-video-might-be-manipulated"),
    ],
    "how-to-verify-a-clip-before-publishing": [
        ("Video authenticity review for researchers", "/use-cases/video-authenticity-review-for-researchers"),
        ("AI video verification for journalists", "/use-cases/ai-video-verification-for-journalists"),
        ("AI video verification for content creators", "/use-cases/ai-video-verification-for-content-creators"),
        ("How creators can fact-check videos", "/use-cases/how-creators-can-fact-check-videos"),
    ],
    "how-to-verify-an-ai-answer": [
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("AI risk review tool", "/use-cases/ai-risk-review-tool"),
    ],
    "how-to-fact-check-chatgpt-responses": [
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to review a suspicious video with AI", "/use-cases/how-to-review-a-suspicious-video-with-ai"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
    ],
    "how-to-check-if-ai-hallucinated": [
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
    ],
    "how-to-verify-sources-from-ai-answers": [
        ("How to verify information for a video script", "/use-cases/how-to-verify-information-for-a-video-script"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
        ("How to verify user-generated content", "/use-cases/how-to-verify-user-generated-content"),
    ],
    "how-to-pressure-test-an-ai-response": [
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to test business assumptions with AI", "/use-cases/how-to-test-business-assumptions-with-ai"),
    ],
    "how-to-identify-blind-spots-in-ai-answers": [
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
    ],
    "how-to-check-if-ai-research-is-biased": [
        ("How to test business assumptions with AI", "/use-cases/how-to-test-business-assumptions-with-ai"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to validate market assumptions", "/use-cases/how-to-validate-market-assumptions"),
    ],
    "how-to-validate-ai-generated-research": [
        ("How to verify information for a video script", "/use-cases/how-to-verify-information-for-a-video-script"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
        ("How to test business assumptions with AI", "/use-cases/how-to-test-business-assumptions-with-ai"),
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
    ],
    "how-to-check-if-ai-missed-important-context": [
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to check sources for creator content", "/use-cases/how-to-check-sources-for-creator-content"),
        ("How to review AI-generated recommendations", "/use-cases/how-to-review-ai-generated-recommendations"),
    ],
    "how-to-compare-ai-answers-before-deciding": [
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
        ("How to validate a business idea with AI", "/use-cases/how-to-validate-a-business-idea-with-ai"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
    ],
    "ask-multiple-ai-models-one-question": [
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
        ("How to get multiple AI perspectives on a startup idea", "/use-cases/how-to-get-multiple-ai-perspectives-on-a-startup-idea"),
        ("Best multi-model AI tool for research", "/use-cases/best-multi-model-ai-tool-for-research"),
    ],
    "ai-model-consensus-tool": [
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
        ("AI trust dashboard for decision support", "/use-cases/ai-trust-dashboard-for-decision-support"),
    ],
    "ai-disagreement-analysis-tool": [
        ("How to document model disagreement", "/use-cases/how-to-document-model-disagreement"),
        ("Multi-LLM answer comparison", "/use-cases/multi-llm-answer-comparison"),
        ("Multi-model decision support tool", "/use-cases/multi-model-decision-support-tool"),
    ],
    "ai-second-opinion-tool": [
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
        ("AI expert panel tool", "/use-cases/ai-expert-panel-tool"),
        ("How to pressure-test investor pitch claims", "/use-cases/how-to-pressure-test-investor-pitch-claims"),
    ],
    "how-to-identify-risks-before-deciding": [
        ("AI risk review tool", "/use-cases/ai-risk-review-tool"),
        ("How to check if a decision is based on weak information", "/use-cases/how-to-check-if-a-decision-is-based-on-weak-information"),
        ("How to pressure-test a startup idea", "/use-cases/how-to-pressure-test-a-startup-idea"),
    ],
}


def link_entry(label, href):
    return f'      {{ label: "{label}", href: "{href}" }}'


def build_related_links_block(links):
    entries = ",\n".join(link_entry(l, h) for l, h in links)
    return f"    relatedLinks: [\n{entries},\n    ],"


with open(FILE, "r") as f:
    lines = f.readlines()

# Build a map: slug -> (start_line_0indexed, list of line indices)
# We'll process slugs and find their entries

# First pass: find all slug line numbers (0-indexed)
slug_lines = {}
for i, line in enumerate(lines):
    m = re.match(r'\s+slug:\s*["\']([^"\']+)["\']', line)
    if m:
        slug_lines[m.group(1)] = i

print(f"Found {len(slug_lines)} slugs in file")

# For each page we need to modify, determine:
# 1. Does it already have a relatedLinks: [ ... ] block?
# 2. If yes: find the closing ], line for that block
# 3. If no: find the cta: line for that page

# We'll collect all modifications as (line_number, action, content)
# action: "insert_before" means insert before that line
# We process bottom-to-top to preserve line numbers

modifications = []  # list of (line_idx_0indexed, new_lines_to_insert)

for slug, new_links in PLAN.items():
    if slug not in slug_lines:
        print(f"WARNING: slug '{slug}' not found in file, skipping")
        continue

    slug_line = slug_lines[slug]

    # Find the end of this page's entry: look for the next slug or end of array
    # The page entries are separated by "  {" at the start of a line
    # Find next slug line number
    next_slug_line = len(lines)
    for other_slug, other_line in slug_lines.items():
        if other_line > slug_line and other_line < next_slug_line:
            next_slug_line = other_line

    # Search within [slug_line, next_slug_line) for relatedLinks
    rl_start = None
    rl_end = None  # line index of the closing ],
    cta_line = None

    for i in range(slug_line, next_slug_line):
        line = lines[i]
        if re.match(r'\s+relatedLinks:\s*\[', line):
            rl_start = i
        if rl_start is not None and rl_end is None and i > rl_start:
            # Look for the closing ], of relatedLinks
            stripped = line.strip()
            if stripped == "]," or stripped == "],":
                rl_end = i
        if re.match(r'\s+cta:\s*["\']', line):
            cta_line = i

    # Build the new link entries text
    new_entries = "\n".join(link_entry(l, h) + "," for l, h in new_links)

    if rl_start is not None and rl_end is not None:
        # Append to existing relatedLinks: insert before the closing ],
        modifications.append((rl_end, new_entries + "\n"))
        print(f"  [{slug}] appending {len(new_links)} links before line {rl_end+1}")
    elif cta_line is not None:
        # Insert a new relatedLinks block before cta:
        block = build_related_links_block(new_links) + "\n"
        modifications.append((cta_line, block))
        print(f"  [{slug}] inserting relatedLinks block before cta at line {cta_line+1}")
    else:
        print(f"  [{slug}] WARNING: could not find insertion point")

# Sort modifications by line number descending (process bottom-to-top)
modifications.sort(key=lambda x: x[0], reverse=True)

print(f"\nApplying {len(modifications)} modifications...")

for line_idx, new_content in modifications:
    lines.insert(line_idx, new_content)

with open(FILE, "w") as f:
    f.writelines(lines)

print(f"\nDone. File written.")

# --- COVERAGE REPORT ---
NON_INDEXED = [
    "video-authenticity-review-for-fact-checkers",
    "video-authenticity-review-for-researchers",
    "how-to-review-a-suspicious-video-with-ai",
    "ai-trust-dashboard-for-decision-support",
    "how-to-check-if-a-viral-video-might-be-manipulated",
    "ai-video-verification-for-journalists",
    "ai-video-verification-for-content-creators",
    "multi-model-decision-support-tool",
    "ai-expert-panel-tool",
    "multi-llm-answer-comparison",
    "best-multi-model-ai-tool-for-research",
    "how-journalists-can-verify-viral-clips",
    "how-to-fact-check-breaking-news-claims",
    "how-to-verify-user-generated-content",
    "newsroom-ai-verification-workflow",
    "ai-tools-for-investigative-journalists",
    "how-to-verify-public-statements-quickly",
    "verification-checklist-for-journalists",
    "how-creators-can-fact-check-videos",
    "how-to-verify-information-for-a-video-script",
    "ai-research-tool-for-youtubers",
    "how-to-fact-check-a-reaction-video",
    "how-to-check-sources-for-creator-content",
    "how-to-validate-a-business-idea-with-ai",
    "how-to-pressure-test-a-startup-idea",
    "how-to-test-business-assumptions-with-ai",
    "how-to-pressure-test-investor-pitch-claims",
    "how-to-validate-market-assumptions",
    "how-to-get-multiple-ai-perspectives-on-a-startup-idea",
    "ai-decision-support-for-founders",
    "ai-audit-trail-software",
    "ai-decision-audit-trail",
    "how-to-prove-an-ai-decision-was-reviewed",
    "how-to-document-model-disagreement",
    "ai-accountability-workflow",
    "ai-review-process-for-teams",
    "how-to-review-ai-generated-recommendations",
    "how-to-track-ai-decision-making",
    "ai-risk-review-tool",
    "how-to-check-if-a-decision-is-based-on-weak-information",
]

print("\n=== COVERAGE REPORT ===")
coverage = {t: [] for t in NON_INDEXED}
for src_slug, links in PLAN.items():
    for label, href in links:
        target = href.replace("/use-cases/", "")
        if target in coverage:
            coverage[target].append(src_slug)

all_ok = True
for target, sources in coverage.items():
    count = len(sources)
    status = "✓" if count >= 3 else "✗ NEEDS MORE"
    print(f"  {status} {target}: {count} inbound links")
    if count < 3:
        all_ok = False

print(f"\n{'All targets have ≥3 inbound links ✓' if all_ok else 'SOME TARGETS NEED MORE LINKS ✗'}")
print(f"Total non-indexed targets: {len(NON_INDEXED)}")
print(f"Targets with ≥3 links: {sum(1 for s in coverage.values() if len(s) >= 3)}")
