import type { Env } from "../env";
import { fetchJson } from "../util";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

export interface TrafficDay {
  date: string;
  visits: number;
  pageviews: number;
}

export interface VitalsDay {
  date: string;
  samples: number;
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  ttfb_ms: number | null;
  fcp_ms: number | null;
  page_load_ms: number | null;
}

async function graphql<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await fetchJson<{ data: T | null; errors?: { message: string }[] | null }>(
    GRAPHQL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
    "Cloudflare GraphQL",
  );
  if (body.errors?.length) throw new Error(`Cloudflare GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("Cloudflare GraphQL: empty response");
  return body.data;
}

const WEB_ANALYTICS_QUERY = `
query ($account: string!, $siteTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      pageloads: rumPageloadEventsAdaptiveGroups(
        limit: 1000
        orderBy: [date_ASC]
        filter: { siteTag: $siteTag, date_geq: $start, date_leq: $end, bot: 0 }
      ) {
        count
        sum { visits }
        dimensions { date }
      }
      vitals: rumWebVitalsEventsAdaptiveGroups(
        limit: 1000
        orderBy: [date_ASC]
        filter: { siteTag: $siteTag, date_geq: $start, date_leq: $end, bot: 0 }
      ) {
        count
        quantiles {
          largestContentfulPaintP75
          interactionToNextPaintP75
          cumulativeLayoutShiftP75
          timeToFirstByteP75
          firstContentfulPaintP75
        }
        dimensions { date }
      }
      performance: rumPerformanceEventsAdaptiveGroups(
        limit: 1000
        orderBy: [date_ASC]
        filter: { siteTag: $siteTag, date_geq: $start, date_leq: $end, bot: 0 }
      ) {
        quantiles { pageLoadTimeP50 }
        dimensions { date }
      }
    }
  }
}`;

interface WebAnalyticsResult {
  viewer: {
    accounts: {
      pageloads: { count: number; sum: { visits: number }; dimensions: { date: string } }[];
      vitals: {
        count: number;
        quantiles: Record<string, number>;
        dimensions: { date: string };
      }[];
      performance: { quantiles: { pageLoadTimeP50: number }; dimensions: { date: string } }[];
    }[];
  };
}

// Cloudflare reports timings in microseconds; negative values mean "not available".
const usToMs = (v: number | undefined) => (v == null || v < 0 ? null : Math.round(v / 100) / 10);
const orNull = (v: number | undefined) => (v == null || v < 0 ? null : v);

/** Visits, page views and Core Web Vitals from Cloudflare Web Analytics (RUM beacon). */
export async function fetchWebAnalytics(env: Env, siteTag: string, start: string, end: string) {
  const data = await graphql<WebAnalyticsResult>(env, WEB_ANALYTICS_QUERY, {
    account: env.CF_ACCOUNT_ID,
    siteTag,
    start,
    end,
  });
  const account = data.viewer.accounts[0];
  if (!account) throw new Error("Cloudflare: account not found for CF_ACCOUNT_ID");

  const traffic: TrafficDay[] = account.pageloads.map((g) => ({
    date: g.dimensions.date,
    visits: g.sum.visits,
    pageviews: g.count,
  }));

  const pageLoad = new Map(account.performance.map((g) => [g.dimensions.date, usToMs(g.quantiles.pageLoadTimeP50)]));
  const vitals: VitalsDay[] = account.vitals.map((g) => ({
    date: g.dimensions.date,
    samples: g.count,
    lcp_ms: usToMs(g.quantiles.largestContentfulPaintP75),
    inp_ms: usToMs(g.quantiles.interactionToNextPaintP75),
    cls: orNull(g.quantiles.cumulativeLayoutShiftP75),
    ttfb_ms: usToMs(g.quantiles.timeToFirstByteP75),
    fcp_ms: usToMs(g.quantiles.firstContentfulPaintP75),
    page_load_ms: pageLoad.get(g.dimensions.date) ?? null,
  }));
  return { traffic, vitals };
}

const ZONE_QUERY = `
query ($zone: string!, $start: Date!, $end: Date!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequests1dGroups(limit: 100, orderBy: [date_ASC], filter: { date_geq: $start, date_leq: $end }) {
        dimensions { date }
        sum { pageViews }
        uniq { uniques }
      }
    }
  }
}`;

interface ZoneResult {
  viewer: {
    zones: {
      httpRequests1dGroups: { dimensions: { date: string }; sum: { pageViews: number }; uniq: { uniques: number } }[];
    }[];
  };
}

/** Fallback for proxied zones without Web Analytics: unique visitors and HTML page views at the edge. */
export async function fetchZoneTraffic(env: Env, zoneId: string, start: string, end: string): Promise<TrafficDay[]> {
  const data = await graphql<ZoneResult>(env, ZONE_QUERY, { zone: zoneId, start, end });
  const zone = data.viewer.zones[0];
  if (!zone) throw new Error("Cloudflare: zone not found or token lacks Zone Analytics access");
  return zone.httpRequests1dGroups.map((g) => ({
    date: g.dimensions.date,
    visits: g.uniq.uniques,
    pageviews: g.sum.pageViews,
  }));
}
