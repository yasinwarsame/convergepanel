"use client";

import { useState, useMemo } from "react";
import { PAGES, CATEGORIES, type PSEOPage } from "@/lib/pseo/pages";

function generateMarkdown(page: PSEOPage): string {
  return `---
title: "${page.title} | ConvergePanel"
description: "${page.metaDescription}"
slug: "/use-cases/${page.slug}"
category: "${page.category}"
---

# ${page.h1}

> **Who this is for:** ${page.audience} — ${page.audienceDetail}

## The problem

${page.problem}

## How ConvergePanel helps

${page.solution}

## How it works

${page.workflow.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Use cases

${page.useCases.map((u) => `- ${u}`).join("\n")}

---

**${page.cta}** → [Get started](https://convergepanel.com/signup)
`;
}

function generateHTML(page: PSEOPage): string {
  const cat = CATEGORIES[page.category];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${page.title} | ConvergePanel</title>
  <meta name="description" content="${page.metaDescription}">
  <link rel="canonical" href="https://convergepanel.com/use-cases/${page.slug}">
  <meta property="og:title" content="${page.title} | ConvergePanel">
  <meta property="og:description" content="${page.metaDescription}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://convergepanel.com/use-cases/${page.slug}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${page.h1}",
    "description": "${page.metaDescription}",
    "author": { "@type": "Organization", "name": "ConvergePanel" },
    "publisher": { "@type": "Organization", "name": "ConvergePanel", "url": "https://convergepanel.com" }
  }
  <\/script>
</head>
<body>
  <article>
    <span class="category" style="color:${cat.color}">${cat.label}</span>
    <h1>${page.h1}</h1>
    <p class="lede">${page.metaDescription}</p>
    <aside class="audience-box">
      <strong>Who this is for:</strong> ${page.audience} — ${page.audienceDetail}
    </aside>
    <h2>The problem</h2>
    <p>${page.problem}</p>
    <h2>How ConvergePanel helps</h2>
    <p>${page.solution}</p>
    <h2>How it works</h2>
    <ol>${page.workflow.map((s) => `<li>${s}</li>`).join("")}</ol>
    <h2>Use cases</h2>
    <ul>${page.useCases.map((u) => `<li>${u}</li>`).join("")}</ul>
    <div class="cta-block">
      <p>${page.cta}</p>
      <a href="https://convergepanel.com/signup">Get started →</a>
    </div>
  </article>
</body>
</html>`;
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px", color: "#111" }}>{title}</h2>
      <p style={{ fontSize: 15, lineHeight: 1.7, color: "#333", margin: 0 }}>{body}</p>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12, color: "#777", marginTop: 4 }}>
      <code
        style={{
          background: "#f0f0ee",
          padding: "1px 5px",
          borderRadius: 3,
          marginRight: 6,
          fontFamily: "monospace",
        }}
      >
        {label}
      </code>
      {value}
    </div>
  );
}

function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 10px",
        fontSize: 11,
        fontWeight: active ? 700 : 500,
        border: `1px solid ${active ? color : "#ddd"}`,
        borderRadius: 20,
        background: active ? color + "18" : "transparent",
        color: active ? color : "#777",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function PagePreview({ page }: { page: PSEOPage }) {
  const cat = CATEGORIES[page.category];
  return (
    <div style={{ fontFamily: "'IBM Plex Serif', Georgia, serif", maxWidth: 720, margin: "0 auto" }}>
      <div style={{ marginBottom: 32 }}>
        <span
          style={{
            display: "inline-block",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: cat.color,
            background: cat.color + "18",
            padding: "4px 10px",
            borderRadius: 4,
            marginBottom: 12,
          }}
        >
          {cat.label}
        </span>
        <h1 style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.2, margin: "8px 0 12px", color: "#111" }}>
          {page.h1}
        </h1>
        <p style={{ fontSize: 16, color: "#555", lineHeight: 1.6, margin: 0 }}>{page.metaDescription}</p>
      </div>

      <div
        style={{
          background: "#f8f8f6",
          border: "1px solid #e5e5e0",
          borderRadius: 8,
          padding: "20px 24px",
          marginBottom: 28,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#999",
            marginBottom: 6,
          }}
        >
          Who this is for
        </div>
        <div style={{ fontSize: 15, color: "#222", lineHeight: 1.5 }}>
          <strong>{page.audience}</strong> — {page.audienceDetail}
        </div>
      </div>

      <Section title="The problem" body={page.problem} />
      <Section title="How ConvergePanel helps" body={page.solution} />

      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px", color: "#111" }}>How it works</h2>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {page.workflow.map((step, i) => (
            <li key={i} style={{ fontSize: 15, lineHeight: 1.7, color: "#333", marginBottom: 6 }}>
              {step}
            </li>
          ))}
        </ol>
      </div>

      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px", color: "#111" }}>Use cases</h2>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {page.useCases.map((uc, i) => (
            <li key={i} style={{ fontSize: 15, lineHeight: 1.7, color: "#333", marginBottom: 6 }}>
              {uc}
            </li>
          ))}
        </ul>
      </div>

      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
          borderRadius: 10,
          padding: "28px 32px",
          textAlign: "center",
          marginBottom: 28,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: "#fff", marginBottom: 14 }}>{page.cta}</div>
        <div
          style={{
            display: "inline-block",
            background: "#fff",
            color: "#0f172a",
            fontWeight: 700,
            fontSize: 14,
            padding: "10px 28px",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Get started →
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginTop: 10 }}>
          convergepanel.com/signup
        </div>
      </div>

      <div style={{ borderTop: "1px solid #e5e5e0", paddingTop: 16 }}>
        <div style={{ fontSize: 12, color: "#999", fontWeight: 700, marginBottom: 4 }}>SEO metadata</div>
        <MetaRow label="title" value={`${page.title} | ConvergePanel`} />
        <MetaRow label="description" value={page.metaDescription} />
        <MetaRow label="slug" value={`/use-cases/${page.slug}`} />
      </div>
    </div>
  );
}

export default function PSEODashboard() {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filterCat, setFilterCat] = useState("all");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filterCat === "all") return PAGES;
    return PAGES.filter((p) => p.category === filterCat);
  }, [filterCat]);

  const selectedPage = filtered[selectedIdx] ?? filtered[0];

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const copyAll = (format: "md" | "html") => {
    const content = filtered
      .map((p) => (format === "md" ? generateMarkdown(p) : generateHTML(p)))
      .join("\n\n---\n\n");
    copy(content, `all-${format}`);
  };

  return (
    <div
      style={{
        fontFamily: "'IBM Plex Sans', -apple-system, sans-serif",
        minHeight: "100vh",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          borderBottom: "1px solid #e5e5e0",
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: "#111", letterSpacing: "-0.01em" }}>
            pSEO Page Generator
          </h1>
          <p style={{ fontSize: 12, color: "#888", margin: "2px 0 0" }}>
            {PAGES.length} pages · {Object.keys(CATEGORIES).length} categories · convergepanel.com
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => copyAll("md")}
            style={{
              padding: "7px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "1px solid #d0d0cc",
              borderRadius: 5,
              background: "#fff",
              color: "#333",
              cursor: "pointer",
            }}
          >
            {copiedKey === "all-md" ? "✓ Copied!" : "Export all (MD)"}
          </button>
          <button
            onClick={() => copyAll("html")}
            style={{
              padding: "7px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "none",
              borderRadius: 5,
              background: "#0f172a",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            {copiedKey === "all-html" ? "✓ Copied!" : "Export all (HTML)"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Sidebar */}
        <div
          style={{
            width: 290,
            minWidth: 290,
            borderRight: "1px solid #e5e5e0",
            overflowY: "auto",
            background: "#fafaf8",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid #e5e5e0",
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
            }}
          >
            <FilterChip
              label={`All (${PAGES.length})`}
              active={filterCat === "all"}
              color="#111"
              onClick={() => { setFilterCat("all"); setSelectedIdx(0); }}
            />
            {Object.entries(CATEGORIES).map(([key, val]) => {
              const count = PAGES.filter((p) => p.category === key).length;
              return (
                <FilterChip
                  key={key}
                  label={`${val.label} (${count})`}
                  active={filterCat === key}
                  color={val.color}
                  onClick={() => { setFilterCat(key); setSelectedIdx(0); }}
                />
              );
            })}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.map((page, i) => {
              const cat = CATEGORIES[page.category];
              const isActive = i === selectedIdx;
              return (
                <button
                  key={page.slug}
                  onClick={() => setSelectedIdx(i)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "11px 16px",
                    borderBottom: "1px solid #eeeeea",
                    cursor: "pointer",
                    background: isActive ? "#fff" : "transparent",
                    borderLeft: isActive ? `3px solid ${cat.color}` : "3px solid transparent",
                    borderTop: "none",
                    borderRight: "none",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 500,
                      color: "#222",
                      lineHeight: 1.35,
                      marginBottom: 3,
                    }}
                  >
                    {page.title}
                  </div>
                  <div style={{ fontSize: 11, color: cat.color, fontWeight: 600 }}>
                    {cat.label} · {page.audience}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Preview panel */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 40px" }}>
          {selectedPage && (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 24, justifyContent: "flex-end" }}>
                <button
                  onClick={() => copy(generateMarkdown(selectedPage), `page-md-${selectedPage.slug}`)}
                  style={{
                    padding: "5px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    border: "1px solid #d0d0cc",
                    borderRadius: 4,
                    background: "transparent",
                    color: "#666",
                    cursor: "pointer",
                  }}
                >
                  {copiedKey === `page-md-${selectedPage.slug}` ? "✓ Copied" : "Copy MD"}
                </button>
                <button
                  onClick={() => copy(generateHTML(selectedPage), `page-html-${selectedPage.slug}`)}
                  style={{
                    padding: "5px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    border: "1px solid #d0d0cc",
                    borderRadius: 4,
                    background: "transparent",
                    color: "#666",
                    cursor: "pointer",
                  }}
                >
                  {copiedKey === `page-html-${selectedPage.slug}` ? "✓ Copied" : "Copy HTML"}
                </button>
              </div>
              <PagePreview page={selectedPage} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
