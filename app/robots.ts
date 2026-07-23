import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/utils";
import { isIndexingEnabled } from "@/lib/site-indexing";

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  // When indexing is disabled (default until EdgeOne production domain passes
  // acceptance), we disallow all crawling. The sitemap may still be generated
  // for future use, but robots.txt must NOT advertise it — otherwise search
  // engines would be encouraged to discover and index unfinished pages.
  if (!isIndexingEnabled()) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
      // Intentionally omit `sitemap` so robots.txt does not advertise it,
      // preventing search engines from discovering unfinished pages.
    };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
