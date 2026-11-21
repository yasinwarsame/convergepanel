/**
 * Structural telemetry hardening: the route manifest the telemetry sanitizer matches against must be exactly the
 * application's real routes (app/, public/, framework paths) and the SEO slug data. A new route, a renamed dynamic
 * segment or a new slug fails here until `npm run generate:telemetry-routes` is run and the result committed.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { buildManifestSource, collectRoutes, loadSlugs, MANIFEST_RELATIVE_PATH } from "../scripts/telemetryRouteManifest";
import { TELEMETRY_ROUTE_PATTERNS, TELEMETRY_SLUG_ALLOWLIST } from "@/lib/privacy/telemetryRouteManifest.generated";
import { matchRouteTemplate } from "@/lib/privacy/routeTemplates";

const ROOT = join(__dirname, "..");

describe("telemetry route manifest", () => {
  it("the committed manifest is exactly what the generator produces from app/, public/ and the slug data", () => {
    const committed = readFileSync(join(ROOT, MANIFEST_RELATIVE_PATH), "utf8");
    expect(committed).toBe(buildManifestSource({ root: ROOT, slugs: loadSlugs() }));
  });

  it("covers every page and API route, with their real dynamic segment names", () => {
    const routes = collectRoutes(ROOT);
    // Spot checks that pin the generator to the real tree (each exists as app/**/page.tsx or route.ts).
    for (const r of [
      "/",
      "/workspace-invitations/accept",
      "/api/workspace-invitations/[invitationId]/accept",
      "/workspace/team/[workspaceId]/projects/[projectId]/research/[runId]",
      "/workspace/team/[workspaceId]/claims/new",
      "/api/workspaces/[workspaceId]/members/[uid]/remove",
      "/learn/[slug]",
      "/robots.txt",
      "/sitemap.xml",
      "/favicon.ico",
      "/ingest/[...path]",
      "/monitoring",
    ]) {
      expect(routes).toContain(r);
    }
    expect(routes.length).toBeGreaterThan(150);
    expect(TELEMETRY_ROUTE_PATTERNS).toEqual(routes);
  });

  it("every route pattern templates to itself (a template is a fixed point)", () => {
    for (const pattern of TELEMETRY_ROUTE_PATTERNS) expect([pattern, matchRouteTemplate(pattern)]).toEqual([pattern, pattern]);
  });

  it("slug allowlists are non-empty, kebab-case, and match only their own route", () => {
    expect(Object.keys(TELEMETRY_SLUG_ALLOWLIST).sort()).toEqual(["/learn/[slug]", "/solutions/[slug]", "/use-cases/[slug]"]);
    for (const [route, slugs] of Object.entries(TELEMETRY_SLUG_ALLOWLIST)) {
      expect(slugs.length).toBeGreaterThan(0);
      for (const slug of slugs) {
        expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(matchRouteTemplate(route.replace("[slug]", slug))).toBe(route.replace("[slug]", slug));
      }
    }
    const learn = TELEMETRY_SLUG_ALLOWLIST["/learn/[slug]"][0];
    const otherCluster = ["/solutions/[slug]", "/use-cases/[slug]"].find((r) => !TELEMETRY_SLUG_ALLOWLIST[r].includes(learn))!;
    expect(matchRouteTemplate(otherCluster.replace("[slug]", learn))).toBe(otherCluster);
  });
});
