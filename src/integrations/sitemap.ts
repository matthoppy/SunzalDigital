const locs = (xml: string) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));

async function fetchXml(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "SunzalSEODashboard/1.0" } });
  if (!res.ok) throw new Error(`Sitemap ${url} returned HTTP ${res.status}`);
  return res.text();
}

/**
 * Page URLs listed in a sitemap. For a sitemap index, reads the first child sitemaps
 * (each one is an outbound request, so `maxChildren` keeps the count bounded).
 */
export async function sitemapUrls(sitemapUrl: string, limit = 500, maxChildren = 2): Promise<string[]> {
  const xml = await fetchXml(sitemapUrl);
  if (!/<sitemapindex/i.test(xml)) return locs(xml).slice(0, limit);
  const urls: string[] = [];
  for (const child of locs(xml).slice(0, maxChildren)) {
    urls.push(...locs(await fetchXml(child)));
    if (urls.length >= limit) break;
  }
  return urls.slice(0, limit);
}
