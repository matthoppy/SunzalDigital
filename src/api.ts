import { Db, DbError } from "./db";
import { configured, type Env, type Site } from "./env";
import { findPosition, readPostback } from "./integrations/dataforseo";
import { writeSummary } from "./summary";
import { syncSite } from "./sync";
import { errorMessage, HttpError, json, normalizeDomain, timingSafeEqual } from "./util";

type Handler = (req: Request, env: Env, db: Db, params: string[], url: URL) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/status$/, status],
  ["GET", /^\/api\/sites$/, listSites],
  ["POST", /^\/api\/sites$/, createSite],
  ["PUT", /^\/api\/sites\/(\d+)$/, updateSite],
  ["DELETE", /^\/api\/sites\/(\d+)$/, deleteSite],
  ["GET", /^\/api\/sites\/(\d+)\/dashboard$/, dashboard],
  ["POST", /^\/api\/sites\/(\d+)\/sync$/, syncNow],
  ["POST", /^\/api\/sites\/(\d+)\/summary$/, summarise],
  ["POST", /^\/api\/sites\/(\d+)\/keywords$/, addKeywords],
  ["DELETE", /^\/api\/keywords\/(\d+)$/, deleteKeyword],
];

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (match && req.method === method) {
      try {
        return await handler(req, env, new Db(env), match.slice(1), url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        const message = err instanceof DbError || /SUPABASE/.test(errorMessage(err)) ? errorMessage(err) : "Something went wrong on the server. Check the worker logs.";
        return json({ error: message }, 500);
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

async function getSite(db: Db, id: string | number): Promise<Site> {
  const site = await db.first<Site>("sites", `select=*&id=eq.${Number(id)}`);
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

async function createSite(req: Request, _env: Env, db: Db) {
  const s = cleanSite(await readBody<SiteInput>(req));
  if (await db.first("sites", `select=id&domain=eq.${encodeURIComponent(s.domain)}`)) {
    throw new HttpError(409, `${s.domain} is already on the dashboard`);
  }
  const [row] = await db.insert<Site>("sites", s);
  return json(row, 201);
}

async function updateSite(req: Request, _env: Env, db: Db, [id]: string[]) {
  await getSite(db, id);
  const [row] = await db.update<Site>("sites", `id=eq.${Number(id)}`, cleanSite(await readBody<SiteInput>(req)));
  return json(row);
}

async function deleteSite(_req: Request, _env: Env, db: Db, [id]: string[]) {
  await getSite(db, id);
  await db.delete("sites", `id=eq.${Number(id)}`);
  return json({ deleted: true });
}

async function syncNow(_req: Request, env: Env, db: Db, [id]: string[]) {
  return json(await syncSite(env, db, await getSite(db, id)));
}

async function summarise(_req: Request, env: Env, db: Db, [id]: string[], url: URL) {
  await getSite(db, id);
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(400, "Add an ANTHROPIC_API_KEY secret to the worker to turn on AI summaries");
  return json(await writeSummary(env, db, Number(id), clampDays(url)), 201);
}

// ---------- keywords ----------

interface KeywordInput {
  keyword: string;
  area?: string | null;
  location?: string | null;
  track_maps?: boolean;
}

async function addKeywords(req: Request, _env: Env, db: Db, [id]: string[]) {
  const site = await getSite(db, id);
  const body = await readBody<{ keywords: KeywordInput[] }>(req);
  const list = (body.keywords ?? []).filter((k) => k.keyword?.trim());
  if (!list.length) throw new HttpError(400, "Add at least one keyword");
  if (list.length > 200) throw new HttpError(400, "Add up to 200 keywords at a time");
  const rows = list.map((k) => {
    const location = k.location?.trim() || site.default_location;
    if (!location) throw new HttpError(400, `Set a location for "${k.keyword}" or a default location for the site`);
    return { site_id: site.id, keyword: k.keyword.trim().toLowerCase(), area: k.area?.trim() || null, location, track_maps: k.track_maps !== false };
  });
  await db.upsert("keywords", rows, "site_id,keyword,location", true);
  // New keywords should be checked on the next sync rather than waiting for the interval.
  await db.update("sites", `id=eq.${site.id}`, { ranks_requested_on: null });
  return json({ added: rows.length }, 201);
}

async function deleteKeyword(_req: Request, _env: Env, db: Db, [id]: string[]) {
  await db.delete("keywords", `id=eq.${Number(id)}`);
  return json({ deleted: true });
}

// ---------- read models ----------

function clampDays(url: URL) {
  const d = Number(url.searchParams.get("days"));
  return [7, 30, 90].includes(d) ? d : 30;
}

async function listSites(_req: Request, _env: Env, db: Db, _p: string[], url: URL) {
  const days = clampDays(url);
  return json({ days, sites: await db.rpc("sites_overview", { p_days: days }) });
}

async function dashboard(_req: Request, env: Env, db: Db, [id]: string[], url: URL) {
  const days = clampDays(url);
  const data = await db.rpc<Record<string, unknown> | null>("site_dashboard", { p_site_id: Number(id), p_days: days });
  if (!data) throw new HttpError(404, "Site not found");
  return json({ days, configured: configured(env), ...data });
}

// ---------- DataForSEO callback ----------

export async function handleRankWebhook(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!env.WEBHOOK_SECRET || !(await timingSafeEqual(token, env.WEBHOOK_SECRET))) return json({ error: "Forbidden" }, 403);
  const kind = url.searchParams.get("kind");
  if (kind !== "organic" && kind !== "maps") return json({ error: "Unknown kind" }, 400);

  const db = new Db(env);
  const payload = await readPostback(req);
  for (const task of payload.tasks ?? []) {
    const [keywordId, date] = (task.data?.tag ?? "").split(":");
    if (!/^\d+$/.test(keywordId ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    if (task.status_code !== 20000) {
      console.warn(`DataForSEO task ${task.id} failed: ${task.status_message}`);
      continue;
    }
    const kw = await db.first<{ sites: Pick<Site, "domain" | "business_name"> }>("keywords", `select=sites(domain,business_name)&id=eq.${keywordId}`);
    if (!kw?.sites) continue;
    const items = task.result?.[0]?.items ?? [];
    const { position, url: rankingUrl } = findPosition(kind, items, kw.sites.domain, kw.sites.business_name);
    await db.upsert("rank_checks", [{ keyword_id: Number(keywordId), date, kind, position, url: rankingUrl, checked_at: new Date().toISOString() }], "keyword_id,date,kind");
  }
  return json({ ok: true });
}
