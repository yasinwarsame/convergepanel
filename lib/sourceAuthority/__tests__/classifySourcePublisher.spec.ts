/**
 * Order 4 — Source Publisher Class v1: the classifier, host hygiene, registry
 * integrity, strict-contract parity and architectural boundaries.
 *
 * Publisher class is DESCRIPTIVE: it says what kind of publisher/namespace a
 * cited web address belongs to — never that the page exists, supports a claim
 * or is accurate. Every assertion below is about that narrow contract.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { classifySourcePublisher, registryEntryMatches } from "@/lib/sourceAuthority/classifySourcePublisher";
import { normalizeAuthorityHost, NON_PUBLIC_HOST_SUFFIXES, MAX_AUTHORITY_SOURCE_URL_LENGTH } from "@/lib/sourceAuthority/normalizeAuthorityHost";
import { REGISTRY_ENTRIES, RESTRICTED_NAMESPACE_RULES } from "@/lib/sourceAuthority/registry";
import { SOURCE_PUBLISHER_CLASSIFIER_VERSION, type SourcePublisherReasonCode } from "@/lib/sourceAuthority/types";
import { normalizeEvidenceSourceReferences } from "@/lib/verification/evidenceSourceExtraction";

const c = classifySourcePublisher;
const cls = (raw: unknown) => c(raw).publisherClass;
const reason = (raw: unknown) => c(raw).reasonCode;

describe("restricted namespaces", () => {
  it.each([
    ["https://sec.gov/cgi-bin/browse-edgar", "GOVERNMENT", "gov"],
    ["https://www.sec.gov/Archives/x", "GOVERNMENT", "gov"],
    ["https://a.b.c.cdc.gov/page", "GOVERNMENT", "gov"],
    ["https://example.gov/", "GOVERNMENT", "gov"],
    ["https://www.army.mil/article", "GOVERNMENT", "mil"],
    ["https://www.who.int/news", "INTERGOVERNMENTAL_ORGANIZATION", "int"],
    ["https://www.gov.uk/guidance/x", "GOVERNMENT", "gov.uk"],
    ["https://hmrc.gov.uk/x", "GOVERNMENT", "gov.uk"],
  ])("%s → %s via namespace %s", (url, expected, ns) => {
    expect(c(url)).toEqual({ publisherClass: expected, reasonCode: "matched_restricted_namespace", matchedRule: { kind: "namespace", value: ns }, host: new URL(url).hostname, classifierVersion: 1 });
  });

  it("MUTATION B: a namespace label inside a longer host never matches (gov.example.com, cdc.gov.example.com, gov.uk.example.com)", () => {
    for (const url of ["https://gov.example.com/", "https://cdc.gov.example.com/", "https://www.gov.uk.example.com/", "https://mygov.uk/", "https://notgov/", "https://gov.evil.co/"]) {
      expect({ url, cls: cls(url) }).toEqual({ url, cls: "UNCLASSIFIED" });
    }
  });

  it("MUTATION A: who.int.example.com is not WHO / .int", () => {
    expect(c("https://who.int.example.com/news")).toEqual({ publisherClass: "UNCLASSIFIED", reasonCode: "no_rule_matched", matchedRule: null, host: "who.int.example.com", classifierVersion: 1 });
    expect(cls("https://who.int/news")).toBe("INTERGOVERNMENTAL_ORGANIZATION"); // positive control
  });

  it(".edu is NOT a v1 rule (its official eligibility policy could not be verified) — no ACADEMIC_INSTITUTION result is produced", () => {
    expect(c("https://www.harvard.edu/")).toMatchObject({ publisherClass: "UNCLASSIFIED", reasonCode: "no_rule_matched" });
    expect(RESTRICTED_NAMESPACE_RULES.map((r) => r.namespace)).not.toContain("edu");
  });

  it("unrestricted TLDs are never namespace rules (no TLD reputation)", () => {
    for (const tld of ["org", "com", "net", "uk", "ca", "io", "info", "edu"]) expect(RESTRICTED_NAMESPACE_RULES.map((r) => r.namespace)).not.toContain(tld);
    for (const url of ["https://redcross.org/", "https://example.com/", "https://bbc.co.uk/"]) expect(cls(url)).toBe("UNCLASSIFIED");
  });
});

describe("registry", () => {
  it.each([
    ["https://www.canada.ca/en/health-canada.html", "GOVERNMENT", "canada.ca"],
    ["https://canada.ca/", "GOVERNMENT", "canada.ca"],
    ["https://www.un.org/en/about-us", "INTERGOVERNMENTAL_ORGANIZATION", "un.org"],
    ["https://en.wikipedia.org/wiki/Inflation", "OPEN_CONTRIBUTION_PLATFORM", "wikipedia.org"],
    ["https://someone.substack.com/p/post", "OPEN_CONTRIBUTION_PLATFORM", "substack.com"],
    ["https://www.youtube.com/watch?v=x", "OPEN_CONTRIBUTION_PLATFORM", "youtube.com"],
  ])("%s → %s via registry %s", (url, expected, domain) => {
    expect(c(url)).toMatchObject({ publisherClass: expected, reasonCode: "matched_registry_entry", matchedRule: { kind: "registry", value: domain }, classifierVersion: 1 });
  });

  it("registryEntryMatches: exact domain always; subdomains ONLY when includeSubdomains is true; never a bare suffix", () => {
    const exactOnly = { domain: "example-agency.org", includeSubdomains: false };
    const withSubs = { domain: "example-agency.org", includeSubdomains: true };
    expect(registryEntryMatches("example-agency.org", exactOnly)).toBe(true);
    expect(registryEntryMatches("www.example-agency.org", exactOnly)).toBe(false);
    expect(registryEntryMatches("www.example-agency.org", withSubs)).toBe(true);
    expect(registryEntryMatches("deep.sub.example-agency.org", withSubs)).toBe(true);
    for (const entry of [exactOnly, withSubs]) {
      expect(registryEntryMatches("evilexample-agency.org", entry)).toBe(false);
      expect(registryEntryMatches("example-agency.org.evil.com", entry)).toBe(false);
    }
  });

  it("the classifier routes every registry decision through registryEntryMatches (no second, divergent matcher)", () => {
    const src = readFileSync(join(__dirname, "..", "classifySourcePublisher.ts"), "utf8");
    expect(src).toMatch(/REGISTRY_ENTRIES\.find\(\(e\) => registryEntryMatches\(host, e\)\)/);
  });

  it("registry matching is label-boundary safe (no naïve endsWith)", () => {
    for (const url of ["https://notcanada.ca/", "https://canada.ca.evil.com/", "https://wikipedia.org.example.com/", "https://evilyoutube.com/", "https://un.org.attacker.net/"]) {
      expect({ url, cls: cls(url) }).toEqual({ url, cls: "UNCLASSIFIED" });
    }
  });
});

describe("fail closed: labels, malformed and unsafe inputs (MUTATIONS C, D, I, L)", () => {
  const cases: Array<[string, unknown, SourcePublisherReasonCode]> = [
    ["plain label 'official government report'", "official government report", "not_a_url"],
    ["plain label 'NIST glossary'", "NIST glossary", "not_a_url"],
    ["plain label 'peer-reviewed source'", "peer-reviewed source", "not_a_url"],
    ["plain label 'official record'", "official record", "not_a_url"],
    ["missing scheme", "www.nist.gov/glossary", "not_a_url"],
    ["empty", "   ", "not_a_url"],
    ["non-string", 42, "not_a_url"],
    ["null", null, "not_a_url"],
    ["javascript:", "javascript:alert(1)", "unsupported_protocol"],
    ["data:", "data:text/html,<b>x</b>", "unsupported_protocol"],
    ["ftp:", "ftp://ftp.nasa.gov/pub", "unsupported_protocol"],
    ["userinfo on an official host", "https://user:pw@www.cdc.gov/", "credential_bearing_url"],
    ["username-only userinfo", "https://www.cdc.gov@evil.example/", "credential_bearing_url"],
    ["over 2048 chars", `https://www.cdc.gov/${"a".repeat(MAX_AUTHORITY_SOURCE_URL_LENGTH)}`, "over_length"],
  ];
  it.each(cases)("%s → UNCLASSIFIED / %s", (_l, raw, code) => {
    expect(c(raw)).toEqual({ publisherClass: "UNCLASSIFIED", reasonCode: code, matchedRule: null, host: null, classifierVersion: 1 });
  });

  it("exactly 2048 chars is still parsed (the bound is > 2048, matching the durable contract)", () => {
    const url = `https://www.cdc.gov/${"a".repeat(MAX_AUTHORITY_SOURCE_URL_LENGTH - "https://www.cdc.gov/".length)}`;
    expect(url).toHaveLength(MAX_AUTHORITY_SOURCE_URL_LENGTH);
    expect(cls(url)).toBe("GOVERNMENT");
  });

  it.each([
    "http://localhost/",
    "http://intranet/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://[::1]/",
    "http://[2001:db8::1]/report",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://169.254.169.254/latest",
    "https://example.local/",
    "https://agency.gov.local/",
    "https://example.internal/",
    "https://example.test/",
    "https://example.example/",
    "https://example.invalid/",
    "https://printer.home.arpa/",
    "https://app.localhost/",
  ])("non-public host %s → UNCLASSIFIED / non_public_host", (url) => {
    expect(c(url)).toEqual({ publisherClass: "UNCLASSIFIED", reasonCode: "non_public_host", matchedRule: null, host: null, classifierVersion: 1 });
  });

  it("the non-public suffix list is pinned", () => {
    expect([...NON_PUBLIC_HOST_SUFFIXES]).toEqual(["localhost", "local", "internal", "test", "example", "invalid", "home.arpa"]);
  });

  it("an ordinary public host with no rule → UNCLASSIFIED / no_rule_matched, with its host recorded", () => {
    expect(c("https://www.reuters.com/world/x")).toEqual({ publisherClass: "UNCLASSIFIED", reasonCode: "no_rule_matched", matchedRule: null, host: "www.reuters.com", classifierVersion: 1 });
  });
});

describe("canonical host handling (MUTATIONS J, K)", () => {
  it("uppercase hosts are canonicalized", () => {
    expect(c("https://WWW.SEC.GOV/Archives")).toMatchObject({ publisherClass: "GOVERNMENT", host: "www.sec.gov" });
  });

  it("MUTATION K: one trailing dot is stripped before matching — it neither bypasses nor misroutes a rule", () => {
    expect(c("https://www.sec.gov./x")).toMatchObject({ publisherClass: "GOVERNMENT", host: "www.sec.gov", matchedRule: { kind: "namespace", value: "gov" } });
    expect(c("https://who.int.example.com./x")).toMatchObject({ publisherClass: "UNCLASSIFIED", host: "who.int.example.com" });
    expect(c("https://en.wikipedia.org./wiki/X")).toMatchObject({ publisherClass: "OPEN_CONTRIBUTION_PLATFORM", host: "en.wikipedia.org" });
    expect(normalizeAuthorityHost("https://localhost./")).toEqual({ ok: false, reasonCode: "non_public_host" });
    // Exactly ONE dot is stripped: a second trailing dot leaves an empty label → never a public host, never a match.
    expect(c("https://www.sec.gov../x")).toEqual({ publisherClass: "UNCLASSIFIED", reasonCode: "non_public_host", matchedRule: null, host: null, classifierVersion: 1 });
    expect(c("https://who.int.../x")).toMatchObject({ publisherClass: "UNCLASSIFIED", reasonCode: "non_public_host" });
  });

  it("MUTATION J: a Unicode look-alike becomes a different punycode host and is NOT classified by appearance", () => {
    const lookalike = "https://wһo.int/news"; // Cyrillic small letter shha in place of 'h'
    const result = c(lookalike);
    expect(result.host).toMatch(/^xn--/);
    expect(result.host).not.toBe("who.int");
    // It is still under .int (a real IANA-restricted namespace), so it is classed by THAT namespace, not as WHO —
    // and a look-alike of a non-namespace registry entry is UNCLASSIFIED:
    expect(result.matchedRule).toEqual({ kind: "namespace", value: "int" });
    expect(c("https://wikipеdia.org/wiki/X")).toMatchObject({ publisherClass: "UNCLASSIFIED", reasonCode: "no_rule_matched" });
    expect(c("https://wikipеdia.org/wiki/X").host).toMatch(/^xn--/);
    expect(c("https://canadа.ca/")).toMatchObject({ publisherClass: "UNCLASSIFIED" });
  });

  it("fullwidth characters WHATWG folds to the same DNS host are the same canonical host", () => {
    expect(c("https://ｗｉｋｉｐｅｄｉａ.org/wiki/X")).toMatchObject({ publisherClass: "OPEN_CONTRIBUTION_PLATFORM", host: "wikipedia.org" });
  });

  it("only the host is read — a URL-shaped query string or path cannot borrow another host's class", () => {
    expect(cls("https://evil.com/?u=https://www.who.int")).toBe("UNCLASSIFIED");
    expect(cls("https://evil.com/www.cdc.gov/")).toBe("UNCLASSIFIED");
    expect(cls("https://cdc.gov%2eevil.com/")).toBe("UNCLASSIFIED");
  });
});

describe("strict-contract parity: never more permissive than the durable Evidence Workspace contract", () => {
  const fixtures = [
    "https://www.sec.gov/x",
    "https://who.int/news",
    "https://www.reuters.com/x",
    "https://user:pw@www.cdc.gov/",
    "https://www.cdc.gov@evil.example/",
    "javascript:alert(1)",
    "ftp://ftp.nasa.gov/pub",
    "NIST glossary",
    "www.nist.gov",
    `https://www.cdc.gov/${"a".repeat(3000)}`,
    "http://localhost/",
    "http://127.1/",
    "https://www.sec.gov./x",
    "https://wһo.int/",
    "  https://en.wikipedia.org/wiki/X  ",
  ];
  it.each(fixtures)("%s: accepted by the classifier ⇒ accepted by normalizeEvidenceSourceReferences with the same host", (raw) => {
    const host = normalizeAuthorityHost(raw);
    const durable = normalizeEvidenceSourceReferences([raw]);
    if (host.ok) {
      expect(durable).toHaveLength(1);
      expect(durable[0].hostname.replace(/\.$/, "")).toBe(host.host);
    }
  });
  it("the classifier's acceptance is a strict subset on this fixture set (and it is stricter somewhere)", () => {
    const accepted = fixtures.filter((f) => normalizeAuthorityHost(f).ok);
    const durable = fixtures.filter((f) => normalizeEvidenceSourceReferences([f]).length === 1);
    for (const f of accepted) expect(durable).toContain(f);
    expect(durable.length).toBeGreaterThan(accepted.length); // localhost / IP are durable references but never classified
  });
});

describe("registry and namespace integrity", () => {
  const SHARED_HOSTING = ["github.io", "blogspot.com", "vercel.app", "appspot.com", "pages.dev", "cloudfront.net", "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com", "workers.dev", "s3.amazonaws.com", "azurewebsites.net", "wordpress.com", "sites.google.com", "notion.site", "gitlab.io", "glitch.me", "onrender.com", "fly.dev"];
  const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

  it("namespace rules: lowercase ASCII, no dots at the ends, valid syntax, unique, cited official policy, non-empty rationale", () => {
    const seen = new Set<string>();
    for (const r of RESTRICTED_NAMESPACE_RULES) {
      expect(r.namespace).toMatch(HOSTNAME);
      expect(seen.has(r.namespace)).toBe(false);
      seen.add(r.namespace);
      expect(r.policyUrls.length).toBeGreaterThan(0);
      for (const u of r.policyUrls) expect(new URL(u).protocol).toBe("https:");
      expect(r.rationale.trim().length).toBeGreaterThan(20);
    }
    expect([...seen].sort()).toEqual(["gov", "gov.uk", "int", "mil"]);
  });

  it("namespace policy citations are official sources only (registry operators, IETF, IANA, the governments themselves)", () => {
    const allowedPolicyHosts = new Set(["get.gov", "www.rfc-editor.org", "www.iana.org", "www.gov.uk"]);
    for (const r of RESTRICTED_NAMESPACE_RULES) for (const u of r.policyUrls) expect({ ns: r.namespace, host: new URL(u).hostname, ok: allowedPolicyHosts.has(new URL(u).hostname) }).toMatchObject({ ok: true });
  });

  it("registry entries: ≥ 2 labels, lowercase ASCII, unique, explicit includeSubdomains, evidence + rationale, no conflicting classes, small", () => {
    const seen = new Set<string>();
    expect(REGISTRY_ENTRIES.length).toBeLessThanOrEqual(30);
    for (const e of REGISTRY_ENTRIES) {
      expect(e.domain).toMatch(HOSTNAME);
      expect(e.domain.split(".").length).toBeGreaterThanOrEqual(2);
      expect(seen.has(e.domain)).toBe(false);
      seen.add(e.domain);
      expect(typeof e.includeSubdomains).toBe("boolean");
      expect(new URL(e.evidenceUrl).protocol).toBe("https:");
      expect(e.rationale.trim().length).toBeGreaterThan(20);
      // A registry entry must not sit inside (or contain) a namespace rule — it would conflict with it.
      for (const r of RESTRICTED_NAMESPACE_RULES) expect(e.domain === r.namespace || e.domain.endsWith(`.${r.namespace}`)).toBe(false);
    }
  });

  it("no registry entry is, sits inside, or contains a multi-tenant / shared-hosting domain (namespace rules are a separate concept)", () => {
    for (const e of REGISTRY_ENTRIES) {
      for (const s of SHARED_HOSTING) {
        expect({ entry: e.domain, shared: s, conflict: e.domain === s || e.domain.endsWith(`.${s}`) || s.endsWith(`.${e.domain}`) }).toMatchObject({ conflict: false });
      }
    }
    for (const s of SHARED_HOSTING) expect(cls(`https://someone.${s}/`)).toBe("UNCLASSIFIED");
  });
});

describe("versioning, ordering and scope", () => {
  it.each(["https://www.sec.gov/", "https://en.wikipedia.org/wiki/X", "NIST glossary", "http://localhost/"])("classifierVersion is pinned at 1 (%s)", (raw) => {
    expect(SOURCE_PUBLISHER_CLASSIFIER_VERSION).toBe(1);
    expect(c(raw).classifierVersion).toBe(1);
  });

  it("MUTATION B (ordering): no numeric rank, score, weight, tier or confidence appears in any result or module export", () => {
    for (const raw of ["https://www.sec.gov/", "https://who.int/", "https://en.wikipedia.org/wiki/X", "NIST glossary"]) {
      const r = c(raw) as Record<string, unknown>;
      expect(Object.keys(r).sort()).toEqual(["classifierVersion", "host", "matchedRule", "publisherClass", "reasonCode"]);
      expect(Object.values(r).filter((v) => typeof v === "number")).toEqual([1]); // only classifierVersion
    }
    const dir = join(__dirname, "..");
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).join("\n");
    expect(src).not.toMatch(/\b(score|rank|ranking|weight|priority|tier|confidence|trust|reliab|quality)\w*\s*[:=]/i);
  });

  it("MUTATIONS G/H: the classifier reads only the web address — no claim, evidenceType, sourceBacked or label input exists", () => {
    expect(classifySourcePublisher.length).toBe(1);
    const dir = join(__dirname, "..");
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["evidenceType", "sourceBacked", "classifyGrounding", "keyAuthority", "dataBasis", "hasVerifiedSourceData", "evidenceStrength"]) expect({ forbidden, present: src.includes(forbidden) }).toEqual({ forbidden, present: false });
  });

  it("no runtime network: the sourceAuthority modules import nothing but each other and call no network API", () => {
    const dir = join(__dirname, "..");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const m of code.matchAll(/from\s+"([^"]+)"/g)) expect({ f, imp: m[1], ok: m[1].startsWith("./") }).toMatchObject({ ok: true });
      for (const banned of ["fetch(", "axios", "XMLHttpRequest", "require(", "dns", "http.request", "https.request", "net.connect", "whois", "process.env"]) expect({ f, banned, present: code.includes(banned) }).toEqual({ f, banned, present: false });
    }
  });

  it("MUTATION E (import boundary): production code imports lib/sourceAuthority only from the approved read-side path", () => {
    const root = join(__dirname, "..", "..", "..");
    // Order 4 Slice 2a: sourceStanding/sourceIdentity.ts reuses ONLY the host-hygiene primitive (pinned in lib/sourceStanding/__tests__/boundaries.spec.ts).
    const allowed = new Set(["lib/workspaces/reviewContext.ts", "lib/client/workspaceReviewClient.ts", "components/workspace/DecisionReceiptSection.tsx", "lib/sourceStanding/sourceIdentity.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", "__tests__", "coverage"].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(spec|test)\.tsx?$/.test(name)) {
          const rel = relative(root, p);
          if (rel.startsWith("lib/sourceAuthority/")) continue;
          const text = readFileSync(p, "utf8");
          // Any import form — "@/lib/sourceAuthority/…", a relative "../sourceAuthority/…", require() or import() — counts.
          const importsIt = /(?:from|import|require)\s*\(?\s*["'][^"']*sourceAuthority(?:\/|["'])/.test(text);
          // Nor may another production file reach the classifier through the approved importers' exports.
          const usesHelper = /\b(decisionReceiptSourceLinks|classifySourcePublisher|registryEntryMatches|PUBLISHER_CLASS_LABELS)\b/.test(text);
          if ((importsIt || usesHelper) && !allowed.has(rel)) offenders.push(rel);
        }
      }
    };
    for (const top of ["lib", "app", "components", "hooks"]) walk(join(root, top));
    expect(offenders).toEqual([]);
    // Non-vacuity: the approved importers really do import it.
    for (const f of allowed) expect(readFileSync(join(root, f), "utf8")).toMatch(/@\/lib\/sourceAuthority\//);
  });
});
