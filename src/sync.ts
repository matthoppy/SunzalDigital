import { Db } from "./db";
import { configured, intVar, type Env, type Keyword, type Site } from "./env";
import { fetchWebAnalytics, fetchZoneTraffic, type TrafficDay, type VitalsDay } from "./integrations/cloudflare";
import { postRankTasks } from "./integrations/dataforseo";
import { inspectUrl, listSitemaps, searchAnalytics } from "./integrations/google";
import { sitemapUrls } from "./integrations/sitemap";
import { checkUrl } from "./integrations/uptime";
import { writeSummary } from "./summary";
import { daysBetween, errorMessage, isoDate } from "./util";

interface Issue {
  severity: "critical" | "warning" | "info";
  kind: string;
  message: string;
  url?: string | null;
}

export interface SyncReport {
  site: string;
  traffic: number;
  searchDays: number;
  indexChecked: number;
  rankTasks: number;
  pagesChecked: number;
  summary: boolean;
  errors: string[];
}

/** Pulls everything for one site and stores it. Each source fails independently. */
export async function syncSite(env: Env, db: Db, site: Site, opts: { summary?: boolean } = {}): Promise<SyncReport> {
  const have = configured(env);
  const report: SyncReport = { site: site.domain, traffic: 0, searchDays: 0, indexChecked: 0, rankTasks: 0, pagesChecked: 0, summary: false, errors: [] };
  const issues: Issue[] = [];
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report.errors.push(`${label}: ${errorMessage(err)}`);
      issues.push({ severity: "warning", kind: "sync", message: `Couldn't refresh ${label}: ${errorMessage(err)}` });
    }
  };

  if (have.cloudflare && (site.cf_site_tag || site.cf_zone_id)) {
    await step("Cloudflare analytics", async () => {
      const existing = await db.first("traffic_daily", `select=date&site_id=eq.${site.id}`);
      // First sync backfills 90 days in 30-day windows; later syncs refresh the last week.
      const windows: [string, string][] = existing
        ? [[isoDate(-7), isoDate(0)]]
        : [
            [isoDate(-89), isoDate(-60)],
            [isoDate(-59), isoDate(-30)],
            [isoDate(-29), isoDate(0)],
          ];
      for (const [start, end] of windows) {
        let traffic: TrafficDay[];
        let vitals: VitalsDay[] = [];
        if (site.cf_site_tag) {
          ({ traffic, vitals } = await fetchWebAnalytics(env, site.cf_site_tag, start, end));
        } else {
          traffic = await fetchZoneTraffic(env, site.cf_zone_id!, start, end);
        }
        const source = site.cf_site_tag ? "web-analytics" : "zone";
        await db.upsert("traffic_daily", traffic.map((t) => ({ site_id: site.id, ...t, source })), "site_id,date");
        await db.upsert("vitals_daily", vitals.map((v) => ({ site_id: site.id, ...v })), "site_id,date");
        report.traffic += traffic.length;
      }
    });
  }

  let sitemapPaths: string[] = [];
  if (have.searchConsole && site.gsc_property) {
    const property = site.gsc_property;
    await step("Search Console", async () => {
      const end = isoDate(-1);
      const snapshot = { startDate: isoDate(-28), endDate: end };
      const [daily, queries, pages] = await Promise.all([
        searchAnalytics(env, property, { startDate: isoDate(-90), endDate: end, dimensions: ["date"], rowLimit: 500 }),
        searchAnalytics(env, property, { ...snapshot, dimensions: ["query"], rowLimit: 500 }),
        searchAnalytics(env, property, { ...snapshot, dimensions: ["page"], rowLimit: 200 }),
      ]);
      const row = (r: { clicks: number; impressions: number; ctr: number; position: number }) => ({
        site_id: site.id,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      });
      await db.upsert("gsc_daily", daily.map((r) => ({ ...row(r), date: r.keys[0] })), "site_id,date");
      await db.delete("gsc_queries", `site_id=eq.${site.id}`);
      await db.upsert("gsc_queries", queries.map((r) => ({ ...row(r), query: r.keys[0] })), "site_id,query");

      // Check the pages that bring in the most Google traffic still load.
      const toCheck = pages.slice(0, intVar(env.PAGE_CHECKS_PER_SITE, 5)).map((r) => r.keys[0]);
      const checkedAt = new Date().toISOString();
      const status = new Map(await Promise.all(toCheck.map(async (url) => [url, await checkUrl(url)] as const)));
      for (const [url, result] of status) {
        if (!result.ok) {
          issues.push({
            severity: "critical",
            kind: "broken-page",
            message: result.status_code ? `Page returns HTTP ${result.status_code}` : `Page didn't load (${result.error})`,
            url,
          });
        }
      }
      await db.delete("gsc_pages", `site_id=eq.${site.id}`);
      await db.upsert(
        "gsc_pages",
        pages.map((r) => {
          const checked = status.get(r.keys[0]);
          return { ...row(r), page: r.keys[0], status_code: checked?.status_code ?? null, checked_at: checked ? checkedAt : null };
        }),
        "site_id,page",
      );
      report.searchDays = daily.length;
      report.pagesChecked = status.size;
    });

    await step("sitemaps", async () => {
      const sitemaps = await listSitemaps(env, property);
      sitemapPaths = sitemaps.map((s) => s.path);
      if (!sitemaps.length) {
        issues.push({ severity: "warning", kind: "sitemap", message: "No sitemap submitted to Google Search Console" });
      }
      for (const sm of sitemaps) {
        const errors = Number(sm.errors ?? 0);
        const warnings = Number(sm.warnings ?? 0);
        if (errors) issues.push({ severity: "critical", kind: "sitemap", message: `Sitemap has ${errors} error(s)`, url: sm.path });
        if (warnings) issues.push({ severity: "warning", kind: "sitemap", message: `Sitemap has ${warnings} warning(s)`, url: sm.path });
        const age = sm.lastDownloaded ? daysBetween(sm.lastDownloaded.slice(0, 10), isoDate(0)) : null;
        if (age != null && age > 14) {
          issues.push({ severity: "info", kind: "sitemap", message: `Google last read this sitemap ${age} days ago`, url: sm.path });
        }
      }
    });

    if (sitemapPaths.length) {
      await step("index checks", async () => {
        // Add any new sitemap URLs, then inspect the ones checked longest ago.
        const urls = await sitemapUrls(sitemapPaths[0]);
        await db.upsert("page_index", urls.map((url) => ({ site_id: site.id, url })), "site_id,url", true);
        const due = await db.select<{ url: string }>(
          "page_index",
          `select=url&site_id=eq.${site.id}&order=checked_at.asc.nullsfirst&limit=${intVar(env.INDEX_CHECKS_PER_SITE, 5)}`,
        );
        const now = new Date().toISOString();
        const results = await Promise.all(due.map(async ({ url }) => ({ site_id: site.id, url, ...(await inspectUrl(env, property, url)), checked_at: now })));
        await db.upsert("page_index", results, "site_id,url");
        report.indexChecked = results.length;
      });
    }
  }

  const today = isoDate(0);
  const interval = intVar(env.RANK_CHECK_INTERVAL_DAYS, 1);
  const rankDue = !site.ranks_requested_on || daysBetween(site.ranks_requested_on, today) >= interval;
  if (have.rankTracking && rankDue) {
    await step("rank tracking", async () => {
      const keywords = await db.select<Keyword>("keywords", `select=*&site_id=eq.${site.id}`);
      if (!keywords.length) return;
      report.rankTasks += await postRankTasks(env, "organic", keywords, today);
      report.rankTasks += await postRankTasks(env, "maps", keywords.filter((k) => k.track_maps), today);
      await db.update("sites", `id=eq.${site.id}`, { ranks_requested_on: today });
    });
  }

  await db.delete("seo_issues", `site_id=eq.${site.id}`);
  if (issues.length) await db.insert("seo_issues", issues.map((i) => ({ site_id: site.id, ...i, url: i.url ?? null })));
  await db.update("sites", `id=eq.${site.id}`, {
    last_synced_at: new Date().toISOString(),
    last_sync_error: report.errors.length ? report.errors.join("\n") : null,
  });

  if (opts.summary && have.aiSummary) {
    try {
      await writeSummary(env, db, site.id);
      report.summary = true;
    } catch (err) {
      report.errors.push(`AI summary: ${errorMessage(err)}`);
    }
  }
  return report;
}

/** Hourly cron: refresh the sites that haven't been synced today, oldest first. */
export async function syncDueSites(env: Env): Promise<SyncReport[]> {
  const db = new Db(env);
  const sites = await db.select<Site>(
    "sites",
    `select=*&or=(last_synced_at.is.null,last_synced_at.lt.${isoDate(0)})&order=last_synced_at.asc.nullsfirst&limit=${intVar(env.SITES_PER_RUN, 1)}`,
  );
  const reports: SyncReport[] = [];
  for (const site of sites) reports.push(await syncSite(env, db, site, { summary: env.DAILY_AI_SUMMARY !== "false" }));
  return reports;
}

/** Every 10 minutes: check each site's home page responds. */
export async function runUptimeChecks(env: Env): Promise<void> {
  const db = new Db(env);
  const sites = await db.select<Pick<Site, "id" | "domain">>("sites", "select=id,domain&order=id&limit=45");
  const checkedAt = new Date().toISOString();
  const checks = await Promise.all(sites.map(async (s) => ({ site_id: s.id, checked_at: checkedAt, ...(await checkUrl(`https://${s.domain}/`)) })));
  await db.upsert("uptime_checks", checks, "site_id,checked_at");
  await db.delete("uptime_checks", `checked_at=lt.${new Date(Date.now() - 90 * 86_400_000).toISOString()}`);
}
