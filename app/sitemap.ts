import type { MetadataRoute } from "next";
import { PAGES } from "@/lib/pseo/pages";
import { PILLARS } from "@/lib/solutions/pages";
import { LEARN_PAGES } from "@/lib/learn/pages";

const BASE = "https://convergepanel.com";

const STATIC_ROUTES: { path: string; lastModified: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }[] = [
  { path: "",           lastModified: "2026-05-28", priority: 1.0, changeFrequency: "weekly"  },
  { path: "/pricing",   lastModified: "2026-05-28", priority: 0.9, changeFrequency: "monthly" },
  { path: "/about",     lastModified: "2026-05-28", priority: 0.7, changeFrequency: "monthly" },
  { path: "/contact",   lastModified: "2026-05-28", priority: 0.6, changeFrequency: "yearly"  },
  { path: "/help",      lastModified: "2026-05-28", priority: 0.6, changeFrequency: "monthly" },
  { path: "/use-cases", lastModified: "2026-05-29", priority: 0.8, changeFrequency: "monthly" },
  { path: "/terms",     lastModified: "2026-05-28", priority: 0.4, changeFrequency: "yearly"  },
  { path: "/privacy",   lastModified: "2026-05-28", priority: 0.4, changeFrequency: "yearly"  },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map(({ path, lastModified, priority, changeFrequency }) => ({
    url: `${BASE}${path}`,
    lastModified: new Date(lastModified),
    changeFrequency,
    priority,
  }));

  const useCaseEntries: MetadataRoute.Sitemap = PAGES.map((page) => ({
    url: `${BASE}/use-cases/${page.slug}`,
    lastModified: new Date(page.publishedAt ?? "2026-05-28"),
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  const solutionEntries: MetadataRoute.Sitemap = PILLARS.map((page) => ({
    url: `${BASE}/solutions/${page.slug}`,
    lastModified: new Date(page.publishedAt),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const learnEntries: MetadataRoute.Sitemap = LEARN_PAGES.map((page) => ({
    url: `${BASE}/learn/${page.slug}`,
    lastModified: new Date(page.publishedAt),
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [...staticEntries, ...useCaseEntries, ...solutionEntries, ...learnEntries];
}
