import type { Env } from "../env";
import { fetchJson } from "../util";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken: { token: string; expires: number } | null = null;

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** OAuth access token for the service account (JWT bearer grant), cached until shortly before expiry. */
async function accessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "");
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetchJson<{ access_token: string; expires_in: number }>(
    tokenUri,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
    },
    "Google OAuth",
  );
  cachedToken = { token: res.access_token, expires: Date.now() + res.expires_in * 1000 };
  return res.access_token;
}

export interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(
  env: Env,
  property: string,
  body: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number },
): Promise<SearchRow[]> {
  const token = await accessToken(env);
  const res = await fetchJson<{ rows?: SearchRow[] }>(
    `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    "Search Console",
  );
  return res.rows ?? [];
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  errors?: string;
  warnings?: string;
  contents?: { type: string; submitted?: string; indexed?: string }[];
}

export async function listSitemaps(env: Env, property: string): Promise<Sitemap[]> {
  const token = await accessToken(env);
  const res = await fetchJson<{ sitemap?: Sitemap[] }>(
    `${API}/sites/${encodeURIComponent(property)}/sitemaps`,
    { headers: { authorization: `Bearer ${token}` } },
    "Search Console sitemaps",
  );
  return res.sitemap ?? [];
}

export interface IndexStatus {
  verdict: string | null;
  coverage_state: string | null;
  last_crawl_at: string | null;
}

/** Google's index status for one URL (Search Console URL Inspection API, 2,000 per property per day). */
export async function inspectUrl(env: Env, property: string, url: string): Promise<IndexStatus> {
  const token = await accessToken(env);
  const res = await fetchJson<{
    inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string } };
  }>(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: property }),
    },
    "URL Inspection",
  );
  const r = res.inspectionResult?.indexStatusResult ?? {};
  return { verdict: r.verdict ?? null, coverage_state: r.coverageState ?? null, last_crawl_at: r.lastCrawlTime ?? null };
}
