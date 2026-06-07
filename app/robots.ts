import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api", "/profile", "/billing", "/onboarding", "/login", "/login/"],
      },
    ],
    sitemap: "https://convergepanel.com/sitemap.xml",
  };
}
