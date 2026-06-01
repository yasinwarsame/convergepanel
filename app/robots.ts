import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/api", "/profile", "/billing", "/onboarding", "/login", "/signup"],
      },
    ],
    sitemap: "https://convergepanel.com/sitemap.xml",
  };
}
