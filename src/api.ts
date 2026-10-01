import { configured, type Env, type Keyword, type Site } from "./env";
import { findPosition, readPostback, type RankKind } from "./integrations/dataforseo";
import { syncSite } from "./sync";
import { HttpError, isoDate, json, normalizeDomain, timingSafeEqual } from "./util";

type Handler = (req: Request, env: Env, params: string[], url: URL) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/status$/, status],
  ["GET", /^\/api\/sites$/, listSites],
  ["POST", /^\/api\/sites$/, createSite],
  ["PUT", /^\/api\/sites\/(\d+)$/, updateSite],
  ["DELETE", /^\/api\/sites\/(\d+)$/, deleteSite],
  ["GET", /^\/api\/sites\/(\d+)\/dashboard$/, dashboard],
  ["POST", /^\/api\/sites\/(\d+)\/sync$/, syncNow],
  ["POST", /^\/api\/sites\/(\d+)\/keywords$/, addKeywords],
  ["DELETE", /^\/api\/keywords\/(\d+)$/, deleteKeyword],
];

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (match && req.method === method) {
      try {
        return await handler(req, env, match.slice(1), url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: "Something went wrong on the server. Check the worker logs." }, 500);
      }
    }
  }
  return json({ error: "Not found" }, 404);
}

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

async function getSite(env: Env, id: string | number): Promise<Site> {
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<Site>();
  if (!site) throw new HttpError(404, "Site not found");
  return site;
}

async function status(_req: Request, env: Env) {
  return json({ mode: "live", configured: configured(env) });
}

// ---------- sites ----------

type SiteInput = Partial<Pick<Site, "name" | "domain" | "gsc_property" | "cf_site_tag" | "cf_zone_id" | "default_location" | "business_name">>;

function cleanSite(input: SiteInput) {
  const opt = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const name = input.name?.trim();
  const domain = input.domain ? normalizeDomain(input.domain) : "";
  if (!name) throw new HttpError(400, "Give the site a name");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new HttpError(400, "Enter a domain like customshowers.co.uk");
  const siteTag = opt(input.cf_site_tag);
  if (siteTag && !/^[0-9a-f]{32}$/i.test(siteTag)) throw new HttpError(400, "Cloudflare site tag should be 32 hex characters");
  const zoneId = opt(input.cf_zone_id);
  if (zoneId && !/^[0-9a-f]{32}$/i.test(zoneId)) throw new HttpError(400, "Cloudflare zone ID should be 32 hex characters");
  return {
    name,
    domain,
    gsc_property: opt(input.gsc_property),
    cf_site_tag: siteTag,
    cf_zone_id: zoneId,
    default_location: opt(input.default_location),
    business_name: opt(input.business_name),
  };
}

async function createSite(req: Request, env: Env) {
  const s = cleanSite(await readBody<SiteInput>(req));
  const exists = await env.DB.prepare("SELECT id FROM sites WHERE domain = ?").bind(s.domain).first();
  if (exists) throw new HttpError(409, `${s.domain} is already on the dashboard`);
  const row = await env.DB.prepare(
    `INSERT INTO sites (name, domain, gsc_property, cf_site_tag, cf_zone_id, default_location, business_name)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(s.name, s.domain, s.gsc_property, s.cf_site_tag, s.cf_zone_id, s.default_location, s.business_name)
    .first<Site>();
  return json(row, 201);
}

async function updateSite(req: Request, env: Env, [id]: string[]) {
  await getSite(env, id);
  const s = cleanSite(await readBody<SiteInput>(req));
  const row = await env.DB.prepare(
    `UPDATE sites SET name = ?, domain = ?, gsc_property = ?, cf_site_tag = ?, cf_zone_id = ?, default_location = ?,
     business_name = ? WHERE id = ? RETURNING *`,
  )
    .bind(s.name, s.domain, s.gsc_property, s.cf_site_tag, s.cf_zone_id, s.default_location, s.business_name, id)
    .first<Site>();
  return json(row);
}

async function deleteSite(_req: Request, env: Env, [id]: string[]) {
  await getSite(env, id);
  await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

async function syncNow(_req: Request, env: Env, [id]: string[]) {
  const site = await getSite(env, id);
  return json(await syncSite(env, site));
}

// ---------- keywords ----------

interface KeywordInput {
  keyword: string;
  area?: string | null;
  location?: string | null;
  track_maps?: boolean;
}

async function addKeywords(req: Request, env: Env, [id]: string[]) {
  const site = await getSite(env, id);
  const body = await readBody<{ keywords: KeywordInput[] }>(req);
  const list = (body.keywords ?? []).filter((k) => k.keyword?.trim());
  if (!list.length) throw new HttpError(400, "Add at least one keyword");
  if (list.length > 200) throw new HttpError(400, "Add up to 200 keywords at a time");
  const rows = list.map((k) => {
    const location = k.location?.trim() || site.default_location;
    if (!location) throw new HttpError(400, `Set a location for "${k.keyword}" or a default location for the site`);
    return { keyword: k.keyword.trim().toLowerCase(), area: k.area?.trim() || null, location, track_maps: k.track_maps === false ? 0 : 1 };
  });
  await env.DB.batch(
    rows.map((k) =>
      env.DB.prepare("INSERT OR IGNORE INTO keywords (site_id, keyword, area, location, track_maps) VALUES (?, ?, ?, ?, ?)").bind(
        site.id,
        k.keyword,
        k.area,
        k.location,
        k.track_maps,
      ),
    ),
  );
  // New keywords should be checked on the next sync rather than waiting for the interval.
  await env.DB.prepare("UPDATE sites SET ranks_requested_on = NULL WHERE id = ?").bind(site.id).run();
  return json({ added: rows.length }, 201);
}

async function deleteKeyword(_req: Request, env: Env, [id]: string[]) {
  await env.DB.prepare("DELETE FROM keywords WHERE id = ?").bind(id).run();
  return json({ deleted: true });
}

// ---------- read models ----------

const clampDays = (url: URL) => {
  const d = Number(url.searchParams.get("days"));
  return [7, 30, 90].includes(d) ? d : 30;
};

async function listSites(_req: Request, env: Env, _p: string[], url: URL) {
  const days = clampDays(url);
  const start = isoDate(-(days * 2) + 1);
  const db = env.DB;
  const { results: sites } = await db.prepare("SELECT * FROM sites ORDER BY name").all<Site>();
  const out = await Promise.all(
    sites.map(async (site) => {
      const [traffic, gsc, ranks, uptime, issues] = await db.batch([
        db.prepare("SELECT date, visits, pageviews FROM traffic_daily WHERE site_id = ? AND date >= ? ORDER BY date").bind(site.id, start),
        db.prepare("SELECT date, clicks, impressions, position FROM gsc_daily WHERE site_id = ? AND date >= ? ORDER BY date").bind(site.id, start),
        db.prepare(latestRanksSql).bind(site.id),
        db.prepare("SELECT COUNT(*) AS checks, SUM(ok) AS up FROM uptime_checks WHERE site_id = ? AND checked_at >= ?").bind(
          site.id,
          new Date(Date.now() - days * 86_400_000).toISOString(),
        ),
        db.prepare("SELECT severity, COUNT(*) AS n FROM seo_issues WHERE site_id = ? GROUP BY severity").bind(site.id),
      ]);
      return {
        site,
        traffic: traffic.results,
        gsc: gsc.results,
        ranks: ranks.results,
        uptime: uptime.results[0] ?? { checks: 0, up: 0 },
        issues: issues.results,
      };
    }),
  );
  return json({ days, sites: out });
}

// Latest organic + maps position per keyword, plus the earliest position inside the window for change.
const latestRanksSql = `
  SELECT k.id, k.keyword, k.area,
    (SELECT position FROM rank_checks r WHERE r.keyword_id = k.id AND r.kind = 'organic' ORDER BY date DESC LIMIT 1) AS organic,
    (SELECT position FROM rank_checks r WHERE r.keyword_id = k.id AND r.kind = 'maps' ORDER BY date DESC LIMIT 1) AS maps
  FROM keywords k WHERE k.site_id = ?`;

async function dashboard(_req: Request, env: Env, [id]: string[], url: URL) {
  const site = await getSite(env, id);
  const days = clampDays(url);
  const start = isoDate(-(days * 2) + 1);
  const db = env.DB;
  const [traffic, vitals, gsc, keywords, ranks, queries, pages, issues, uptime] = await db.batch([
    db.prepare("SELECT date, visits, pageviews FROM traffic_daily WHERE site_id = ? AND date >= ? ORDER BY date").bind(site.id, start),
    db.prepare("SELECT * FROM vitals_daily WHERE site_id = ? AND date >= ? ORDER BY date").bind(site.id, isoDate(-days + 1)),
    db.prepare("SELECT date, clicks, impressions, ctr, position FROM gsc_daily WHERE site_id = ? AND date >= ? ORDER BY date").bind(site.id, start),
    db.prepare("SELECT * FROM keywords WHERE site_id = ? ORDER BY area, keyword").bind(site.id),
    db.prepare(
      `SELECT r.keyword_id, r.date, r.kind, r.position, r.url FROM rank_checks r JOIN keywords k ON k.id = r.keyword_id
       WHERE k.site_id = ? AND r.date >= ? ORDER BY r.date`,
    ).bind(site.id, isoDate(-days)),
    db.prepare("SELECT query, clicks, impressions, ctr, position FROM gsc_queries WHERE site_id = ? ORDER BY clicks DESC, impressions DESC LIMIT 200").bind(site.id),
    db.prepare("SELECT page, clicks, impressions, ctr, position, status_code, checked_at FROM gsc_pages WHERE site_id = ? ORDER BY clicks DESC, impressions DESC LIMIT 50").bind(site.id),
    db.prepare("SELECT severity, kind, message, url, detected_at FROM seo_issues WHERE site_id = ?").bind(site.id),
    db.prepare(
      `SELECT substr(checked_at, 1, 10) AS date, COUNT(*) AS checks, SUM(ok) AS up, CAST(AVG(response_ms) AS INTEGER) AS avg_ms
       FROM uptime_checks WHERE site_id = ? AND checked_at >= ? GROUP BY date ORDER BY date`,
    ).bind(site.id, isoDate(-days + 1)),
  ]);
  const lastCheck = await db
    .prepare("SELECT checked_at, ok, status_code, response_ms, error FROM uptime_checks WHERE site_id = ? ORDER BY checked_at DESC LIMIT 1")
    .bind(site.id)
    .first();

  type RankRow = { keyword_id: number; date: string; kind: RankKind; position: number | null; url: string | null };
  const queryPos = new Map((queries.results as { query: string; position: number }[]).map((q) => [q.query.toLowerCase(), q.position]));
  const kw = (keywords.results as Keyword[]).map((k) => {
    const rows = (ranks.results as RankRow[]).filter((r) => r.keyword_id === k.id);
    const series = (kind: RankKind) => rows.filter((r) => r.kind === kind).map((r) => ({ date: r.date, position: r.position }));
    const latestUrl = [...rows].reverse().find((r) => r.kind === "organic" && r.url)?.url ?? null;
    return { ...k, track_maps: Boolean(k.track_maps), url: latestUrl, gsc_position: queryPos.get(k.keyword) ?? null, organic: series("organic"), maps: series("maps") };
  });

  return json({
    days,
    site,
    configured: configured(env),
    traffic: traffic.results,
    vitals: vitals.results,
    gsc: gsc.results,
    keywords: kw,
    queries: queries.results,
    pages: pages.results,
    issues: issues.results,
    uptime: { daily: uptime.results, last: lastCheck },
  });
}

// ---------- DataForSEO callback ----------

export async function handleRankWebhook(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!env.WEBHOOK_SECRET || !(await timingSafeEqual(token, env.WEBHOOK_SECRET))) return json({ error: "Forbidden" }, 403);
  const kind = url.searchParams.get("kind");
  if (kind !== "organic" && kind !== "maps") return json({ error: "Unknown kind" }, 400);

  const payload = await readPostback(req);
  for (const task of payload.tasks ?? []) {
    const [keywordId, date] = (task.data?.tag ?? "").split(":");
    if (!keywordId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    if (task.status_code !== 20000) {
      console.warn(`DataForSEO task ${task.id} failed: ${task.status_message}`);
      continue;
    }
    const site = await env.DB.prepare("SELECT s.domain, s.business_name FROM keywords k JOIN sites s ON s.id = k.site_id WHERE k.id = ?")
      .bind(keywordId)
      .first<Pick<Site, "domain" | "business_name">>();
    if (!site) continue;
    const items = task.result?.[0]?.items ?? [];
    const { position, url: rankingUrl } = findPosition(kind, items, site.domain, site.business_name);
    await env.DB.prepare("INSERT OR REPLACE INTO rank_checks (keyword_id, date, kind, position, url) VALUES (?, ?, ?, ?, ?)")
      .bind(keywordId, date, kind, position, rankingUrl)
      .run();
  }
  return json({ ok: true });
}
