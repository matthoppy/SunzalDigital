import { configured, intVar, type Env, type Keyword, type Site } from "./env";
import { fetchWebAnalytics, fetchZoneTraffic, type TrafficDay, type VitalsDay } from "./integrations/cloudflare";
import { postRankTasks } from "./integrations/dataforseo";
import { listSitemaps, searchAnalytics } from "./integrations/google";
import { checkUrl } from "./integrations/uptime";
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
  rankTasks: number;
  pagesChecked: number;
  errors: string[];
}

/** Pulls everything for one site and stores it. Each source fails independently. */
export async function syncSite(env: Env, site: Site): Promise<SyncReport> {
  const have = configured(env);
  const report: SyncReport = { site: site.domain, traffic: 0, searchDays: 0, rankTasks: 0, pagesChecked: 0, errors: [] };
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
      const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM traffic_daily WHERE site_id = ?")
        .bind(site.id)
        .first<{ n: number }>();
      // First sync backfills 90 days in 30-day windows; later syncs refresh the last week.
      const windows: [string, string][] = existing?.n
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
        await saveTraffic(env, site.id, traffic, vitals, site.cf_site_tag ? "web-analytics" : "zone");
        report.traffic += traffic.length;
      }
    });
  }

  if (have.searchConsole && site.gsc_property) {
    const property = site.gsc_property;
    await step("Search Console", async () => {
      const end = isoDate(-1);
      const daily = await searchAnalytics(env, property, {
        startDate: isoDate(-90),
        endDate: end,
        dimensions: ["date"],
        rowLimit: 500,
      });
      const snapshot = { startDate: isoDate(-28), endDate: end };
      const [queries, pages] = await Promise.all([
        searchAnalytics(env, property, { ...snapshot, dimensions: ["query"], rowLimit: 500 }),
        searchAnalytics(env, property, { ...snapshot, dimensions: ["page"], rowLimit: 200 }),
      ]);
      const db = env.DB;
      await db.batch([
        ...daily.map((r) =>
          db
            .prepare("INSERT OR REPLACE INTO gsc_daily (site_id, date, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(site.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position),
        ),
        db.prepare("DELETE FROM gsc_queries WHERE site_id = ?").bind(site.id),
        ...queries.map((r) =>
          db
            .prepare("INSERT INTO gsc_queries (site_id, query, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(site.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position),
        ),
        // Keep previously checked status codes for pages that are still listed.
        db.prepare("UPDATE gsc_pages SET clicks = 0, impressions = 0 WHERE site_id = ?").bind(site.id),
        ...pages.map((r) =>
          db
            .prepare(
              `INSERT INTO gsc_pages (site_id, page, clicks, impressions, ctr, position) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (site_id, page) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
               ctr = excluded.ctr, position = excluded.position`,
            )
            .bind(site.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position),
        ),
        db.prepare("DELETE FROM gsc_pages WHERE site_id = ? AND clicks = 0 AND impressions = 0").bind(site.id),
      ]);
      report.searchDays = daily.length;
    });

    await step("sitemaps", async () => {
      const sitemaps = await listSitemaps(env, property);
      if (!sitemaps.length) {
        issues.push({ severity: "warning", kind: "sitemap", message: "No sitemap submitted to Google Search Console" });
      }
      for (const sm of sitemaps) {
        const errors = Number(sm.errors ?? 0);
        const warnings = Number(sm.warnings ?? 0);
        if (errors) issues.push({ severity: "critical", kind: "sitemap", message: `Sitemap has ${errors} error(s)`, url: sm.path });
        if (warnings) issues.push({ severity: "warning", kind: "sitemap", message: `Sitemap has ${warnings} warning(s)`, url: sm.path });
        if (sm.lastDownloaded && daysBetween(sm.lastDownloaded.slice(0, 10), isoDate(0)) > 14) {
          issues.push({
            severity: "info",
            kind: "sitemap",
            message: `Google last read this sitemap ${daysBetween(sm.lastDownloaded.slice(0, 10), isoDate(0))} days ago`,
            url: sm.path,
          });
        }
      }
    });
  }

  await step("page checks", async () => {
    const limit = intVar(env.PAGE_CHECKS_PER_SITE, 5);
    const top = await env.DB.prepare("SELECT page FROM gsc_pages WHERE site_id = ? ORDER BY clicks DESC, impressions DESC LIMIT ?")
      .bind(site.id, limit)
      .all<{ page: string }>();
    const urls = [...new Set([`https://${site.domain}/`, ...top.results.map((r) => r.page)])].slice(0, limit + 1);
    const results = await Promise.all(urls.map(async (url) => ({ url, result: await checkUrl(url) })));
    const now = new Date().toISOString();
    await env.DB.batch(
      results.map(({ url, result }) =>
        env.DB.prepare("UPDATE gsc_pages SET status_code = ?, checked_at = ? WHERE site_id = ? AND page = ?").bind(
          result.status_code,
          now,
          site.id,
          url,
        ),
      ),
    );
    for (const { url, result } of results) {
      if (!result.ok) {
        issues.push({
          severity: "critical",
          kind: "broken-page",
          message: result.status_code ? `Page returns HTTP ${result.status_code}` : `Page didn't load (${result.error})`,
          url,
        });
      }
    }
    report.pagesChecked = results.length;
  });

  const today = isoDate(0);
  const interval = intVar(env.RANK_CHECK_INTERVAL_DAYS, 1);
  const rankDue = !site.ranks_requested_on || daysBetween(site.ranks_requested_on, today) >= interval;
  if (have.rankTracking && rankDue) {
    await step("rank tracking", async () => {
      const { results: keywords } = await env.DB.prepare("SELECT * FROM keywords WHERE site_id = ?").bind(site.id).all<Keyword>();
      if (!keywords.length) return;
      report.rankTasks += await postRankTasks(env, "organic", keywords, today);
      report.rankTasks += await postRankTasks(env, "maps", keywords.filter((k) => k.track_maps), today);
      await env.DB.prepare("UPDATE sites SET ranks_requested_on = ? WHERE id = ?").bind(today, site.id).run();
    });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM seo_issues WHERE site_id = ?").bind(site.id),
    ...issues.map((i) =>
      env.DB.prepare("INSERT INTO seo_issues (site_id, severity, kind, message, url) VALUES (?, ?, ?, ?, ?)").bind(
        site.id,
        i.severity,
        i.kind,
        i.message,
        i.url ?? null,
      ),
    ),
    env.DB.prepare("UPDATE sites SET last_synced_at = ?, last_sync_error = ? WHERE id = ?").bind(
      new Date().toISOString(),
      report.errors.length ? report.errors.join("\n") : null,
      site.id,
    ),
  ]);
  return report;
}

async function saveTraffic(env: Env, siteId: number, traffic: TrafficDay[], vitals: VitalsDay[], source: string) {
  const db = env.DB;
  const statements = [
    ...traffic.map((t) =>
      db
        .prepare("INSERT OR REPLACE INTO traffic_daily (site_id, date, visits, pageviews, source) VALUES (?, ?, ?, ?, ?)")
        .bind(siteId, t.date, t.visits, t.pageviews, source),
    ),
    ...vitals.map((v) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO vitals_daily (site_id, date, samples, lcp_ms, inp_ms, cls, ttfb_ms, fcp_ms, page_load_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(siteId, v.date, v.samples, v.lcp_ms, v.inp_ms, v.cls, v.ttfb_ms, v.fcp_ms, v.page_load_ms),
    ),
  ];
  if (statements.length) await db.batch(statements);
}

/** Hourly cron: refresh the sites that haven't been synced today, oldest first. */
export async function syncDueSites(env: Env): Promise<SyncReport[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM sites WHERE last_synced_at IS NULL OR substr(last_synced_at, 1, 10) < ?
     ORDER BY last_synced_at IS NOT NULL, last_synced_at LIMIT ?`,
  )
    .bind(isoDate(0), intVar(env.SITES_PER_RUN, 2))
    .all<Site>();
  const reports: SyncReport[] = [];
  for (const site of results) reports.push(await syncSite(env, site));
  return reports;
}

/** Every 10 minutes: check each site's home page responds. */
export async function runUptimeChecks(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, domain FROM sites ORDER BY id LIMIT 45").all<Pick<Site, "id" | "domain">>();
  const checkedAt = new Date().toISOString();
  const checks = await Promise.all(results.map(async (s) => ({ s, r: await checkUrl(`https://${s.domain}/`) })));
  await env.DB.batch([
    ...checks.map(({ s, r }) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO uptime_checks (site_id, checked_at, ok, status_code, response_ms, error) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(s.id, checkedAt, r.ok ? 1 : 0, r.status_code, r.response_ms, r.error),
    ),
    env.DB.prepare("DELETE FROM uptime_checks WHERE checked_at < ?").bind(new Date(Date.now() - 90 * 86_400_000).toISOString()),
  ]);
}
