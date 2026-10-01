export interface Env {
  ASSETS: Fetcher;

  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  ANTHROPIC_API_KEY?: string;

  DASHBOARD_PASSWORD?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;
  WEBHOOK_SECRET?: string;

  PUBLIC_URL?: string;
  SITES_PER_RUN?: string;
  PAGE_CHECKS_PER_SITE?: string;
  RANK_CHECK_INTERVAL_DAYS?: string;
  RANK_DEPTH?: string;
  RANK_LANGUAGE_CODE?: string;
  INDEX_CHECKS_PER_SITE?: string;
  DAILY_AI_SUMMARY?: string;
}

export interface Site {
  id: number;
  name: string;
  domain: string;
  gsc_property: string | null;
  cf_site_tag: string | null;
  cf_zone_id: string | null;
  default_location: string | null;
  business_name: string | null;
  created_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  ranks_requested_on: string | null;
}

export interface Keyword {
  id: number;
  site_id: number;
  keyword: string;
  area: string | null;
  location: string;
  track_maps: boolean;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const configured = (env: Env) => ({
  cloudflare: Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
  searchConsole: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
  rankTracking: Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD && env.WEBHOOK_SECRET && env.PUBLIC_URL),
  aiSummary: Boolean(env.ANTHROPIC_API_KEY),
});
