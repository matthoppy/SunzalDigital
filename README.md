# Sunzal SEO Control Centre

One dashboard for every website Sunzal Digital builds. For each site it shows:

| Section | What you see | Data source |
|---|---|---|
| Visitors | Visits and page views per day | Cloudflare Web Analytics (or zone analytics) |
| Speed | Core Web Vitals (LCP, INP, CLS, TTFB) from real visitors | Cloudflare Web Analytics |
| Google Search | Clicks, impressions, CTR, average position, top searches, top pages | Google Search Console API |
| Local rankings | Google position for a keyword searched from a specific town or area | DataForSEO SERP API |
| Google Maps | Maps position for the same keyword and area | DataForSEO Maps API |
| SEO issues | Sitemap errors, broken pages, ranking drops, slow pages, click drops | Search Console + the worker's own checks |
| Uptime | Home page checked every 10 minutes | The worker |
| Trends | Everything above over 7, 30 or 90 days | Stored daily in Cloudflare D1 |

It runs as a single Cloudflare Worker with a D1 database. Open `public/index.html` straight in a browser
to preview it with example data.

## How it works

- **Hourly** (`20 * * * *`): syncs the sites not yet refreshed today, two per run by default. A sync pulls
  Cloudflare analytics (backfilling 90 days the first time), Search Console data and sitemaps, checks the
  home page and top pages for errors, and queues rank checks with DataForSEO.
- **Rank results** don't need polling. DataForSEO posts each result to `/api/webhooks/dataforseo` when it
  is ready, and the worker records the site's position (matched by domain, or by business name on Maps).
- **Every 10 minutes**: uptime check of each site's home page (up to 45 sites).
- **Sync now** on a site page runs a full sync immediately.

The defaults stay within the Workers free plan's 50 outbound requests per run. On Workers Paid you can
raise `SITES_PER_RUN` in `wrangler.jsonc`.

## Setup

1. Install and create the database:

   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create seo-dashboard
   ```

   Put the printed `database_id` into `wrangler.jsonc`, then:

   ```sh
   npm run db:migrate
   ```

2. Deploy once to get the worker URL, then set `PUBLIC_URL` in `wrangler.jsonc` to it and deploy again:

   ```sh
   npm run deploy
   ```

3. Add the secrets (`npx wrangler secret put NAME` for each):

   | Secret | Where to get it |
   |---|---|
   | `DASHBOARD_PASSWORD` | Make one up. The browser asks for it; any username works. |
   | `CF_API_TOKEN` | Cloudflare → My Profile → API Tokens. Permission: *Account Analytics: Read* (plus *Zone Analytics: Read* if you use zone IDs). |
   | `CF_ACCOUNT_ID` | Cloudflare dashboard sidebar → Account ID. |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud → enable *Google Search Console API* → create a service account → Keys → add JSON key. Paste the whole file. Then in Search Console, add the service account's email as a user on each property. |
   | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | https://app.dataforseo.com/api-access |
   | `WEBHOOK_SECRET` | Any long random string, e.g. `openssl rand -hex 24`. |

   Any source you leave out is skipped; the dashboard shows which ones are connected under **Settings**.

4. Open the worker URL, sign in, and **Add website**:
   - **Search Console property**: `sc-domain:customshowers.co.uk` for a domain property, or the full URL
     prefix (`https://www.customshowers.co.uk/`).
   - **Cloudflare Web Analytics site tag**: Web Analytics → the site → *Manage site*; the 32-character
     `siteTag`. If the site is proxied through Cloudflare but has no Web Analytics, use the zone ID instead
     (visitors only, no Core Web Vitals).
   - **Default rank location**: a DataForSEO location name such as `London,England,United Kingdom`.
     Look up names in DataForSEO's
     [locations list](https://docs.dataforseo.com/v3/serp/google/locations/).
   - **Google Business Profile name**: how the business appears on Maps, used when the listing has no
     website link.

5. Add keywords on the site page under **Settings**, one per line:

   ```
   frameless shower doors fulham | Fulham
   frameless showers putney | Putney
   glass shower screens chelsea | Chelsea | Chelsea,England,United Kingdom
   ```

   The third part is optional and overrides the default location for that keyword.

## Costs

- Cloudflare Workers and D1: the free plan is enough for a handful of sites.
- Search Console API: free.
- DataForSEO: pay as you go. Each keyword gets one Google check and one Maps check per day
  (`RANK_CHECK_INTERVAL_DAYS`). Results are read to `RANK_DEPTH` (30 by default); deeper checks cost
  more. See their pricing page for current rates.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill in what you have
npm run db:migrate:local
npm run dev
```

Rank callbacks need a public URL, so test them against a deployed worker or a tunnel
(`cloudflared tunnel --url http://localhost:8787`).

## Not included yet

- Google Business Profile insights (calls, direction requests). The Business Profile Performance API
  needs Google to approve API access for your project first.
- Indexing status per URL (Search Console URL Inspection API) for sites with many pages.
