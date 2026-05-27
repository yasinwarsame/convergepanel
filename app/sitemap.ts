import type { MetadataRoute } from "next";
import { PAGES } from "@/lib/pseo/pages";

const BASE = "https://convergepanel.com";

const STATIC_ROUTES: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "",          priority: 1.0, changeFrequency: "weekly"  },
  { path: "/pricing",  priority: 0.9, changeFrequency: "monthly" },
  { path: "/about",    priority: 0.7, changeFrequency: "monthly" },
  { path: "/contact",  priority: 0.6, changeFrequency: "yearly"  },
  { path: "/help",     priority: 0.6, changeFrequency: "monthly" },
  { path: "/use-cases",priority: 0.8, changeFrequency: "monthly" },
  { path: "/terms",    priority: 0.4, changeFrequency: "yearly"  },
  { path: "/privacy",  priority: 0.4, changeFrequency: "yearly"  },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: `${BASE}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  }));

  const useCaseEntries: MetadataRoute.Sitemap = PAGES.map((page) => ({
    url: `${BASE}/use-cases/${page.slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [...staticEntries, ...useCaseEntries];
}
