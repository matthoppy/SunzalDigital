import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Db } from "./db";
import type { Env, Site } from "./env";
import { isoDate } from "./util";

const MODEL = "claude-opus-5-5";

const SummarySchema = z.object({
  headline: z.string().describe("One sentence on how the site is doing overall"),
  points: z
    .array(
      z.object({
        tone: z.enum(["good", "watch", "action"]),
        text: z.string().describe("One or two plain sentences with the specific numbers"),
      }),
    )
    .describe("Three to six points, most important first"),
});
export type Summary = z.infer<typeof SummarySchema>;

const SYSTEM = `You write the SEO summary on a dashboard that a web designer uses to look after small local-business websites in the UK and New Zealand.

You get one site's figures as JSON: traffic and Google Search Console totals for the current and previous period, tracked keywords with their Google and Google Maps positions at the start and end of the period, searches with many impressions but a low click-through rate, pages Google hasn't indexed, Core Web Vitals, uptime, and issues found by automated checks.

Write a headline and three to six points, most important first:
- "good" for wins worth mentioning, "watch" for things to keep an eye on, "action" for a specific change worth making now. Include at least one "action" when the data supports one.
- Quote the real numbers and keyword names. Lower positions are better (1 is the top result). Say which area a keyword is for when it has one.
- Name the strongest and weakest local area when there are several.
- For low click-through searches, suggest improving that page's title and meta description.
- Only use the figures you are given. If a source has no data, leave it out rather than guessing.
- Plain English for a business owner, no jargon beyond terms like "Google Maps" or "click-through rate". Use the spelling of the site's country.`;

interface DashboardData {
  site: Site;
  traffic: { date: string; visits: number; pageviews: number }[];
  gsc: { date: string; clicks: number; impressions: number; position: number }[];
  vitals: { lcp_ms: number | null; inp_ms: number | null; cls: number | null; ttfb_ms: number | null; samples: number }[];
  keywords: {
    keyword: string;
    area: string | null;
    gsc_position: number | null;
    organic: { date: string; position: number | null }[];
    maps: { date: string; position: number | null }[];
  }[];
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  index: { url: string; verdict: string; coverage_state: string | null }[];
  issues: { severity: string; message: string; url: string | null }[];
  uptime: { daily: { checks: number; up: number }[] };
}

const sumOf = <T>(rows: T[], key: keyof T) => rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
const round = (n: number | null, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Condenses the dashboard into the figures the summary is allowed to talk about. */
export function summaryFacts(d: DashboardData, days: number) {
  const start = isoDate(-days + 1);
  const split = <T extends { date: string }>(rows: T[]) => ({ cur: rows.filter((r) => r.date >= start), prev: rows.filter((r) => r.date < start) });
  const t = split(d.traffic);
  const g = split(d.gsc);
  const pos = (rows: typeof d.gsc) => {
    const impr = sumOf(rows, "impressions");
    return impr ? round(rows.reduce((s, r) => s + r.position * r.impressions, 0) / impr) : null;
  };
  const period = (cur: number, prev: number, hasPrev: boolean) => ({ current: cur, previous: hasPrev ? prev : null });
  const vitalsAvg = (key: "lcp_ms" | "inp_ms" | "cls" | "ttfb_ms") => {
    const rows = d.vitals.filter((v) => v[key] != null);
    const w = sumOf(rows, "samples");
    return w ? round(rows.reduce((s, v) => s + (v[key] as number) * v.samples, 0) / w, key === "cls" ? 3 : 0) : null;
  };
  const checks = sumOf(d.uptime.daily, "checks");
  return {
    site: { name: d.site.name, domain: d.site.domain, location: d.site.default_location },
    period_days: days,
    visitors: period(sumOf(t.cur, "visits"), sumOf(t.prev, "visits"), t.prev.length > 0),
    page_views: period(sumOf(t.cur, "pageviews"), sumOf(t.prev, "pageviews"), t.prev.length > 0),
    google_clicks: period(sumOf(g.cur, "clicks"), sumOf(g.prev, "clicks"), g.prev.length > 0),
    google_impressions: period(sumOf(g.cur, "impressions"), sumOf(g.prev, "impressions"), g.prev.length > 0),
    google_average_position: { current: pos(g.cur), previous: pos(g.prev) },
    tracked_keywords: d.keywords.map((k) => ({
      keyword: k.keyword,
      area: k.area,
      google_position_start: k.organic[0]?.position ?? null,
      google_position_now: k.organic.at(-1)?.position ?? null,
      maps_position_start: k.maps[0]?.position ?? null,
      maps_position_now: k.maps.at(-1)?.position ?? null,
      search_console_average_position: round(k.gsc_position),
    })),
    top_searches: d.queries.slice(0, 10).map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr_percent: round(q.ctr * 100), position: round(q.position) })),
    low_click_through_searches: d.queries
      .filter((q) => q.impressions >= 100 && q.ctr < 0.02)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 5)
      .map((q) => ({ query: q.query, impressions: q.impressions, ctr_percent: round(q.ctr * 100), position: round(q.position) })),
    indexing: {
      pages_checked: d.index.length,
      not_indexed: d.index.filter((p) => p.verdict !== "PASS").slice(0, 10).map((p) => ({ url: p.url, reason: p.coverage_state })),
    },
    core_web_vitals_p75: { lcp_ms: vitalsAvg("lcp_ms"), inp_ms: vitalsAvg("inp_ms"), cls: vitalsAvg("cls"), ttfb_ms: vitalsAvg("ttfb_ms") },
    uptime_percent: checks ? round((sumOf(d.uptime.daily, "up") / checks) * 100, 2) : null,
    issues: d.issues.map((i) => ({ severity: i.severity, message: i.message, url: i.url })),
  };
}

/** Writes a fresh summary for one site and stores it. */
export async function writeSummary(env: Env, db: Db, siteId: number, days = 30) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Set the ANTHROPIC_API_KEY secret to turn on AI summaries");
  const data = await db.rpc<DashboardData | null>("site_dashboard", { p_site_id: siteId, p_days: days });
  if (!data) throw new Error("Site not found");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(SummarySchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(summaryFacts(data, days)) }],
  });
  if (response.stop_reason === "refusal") throw new Error("The summary request was declined. Try again later.");
  if (!response.parsed_output) throw new Error(`The summary came back incomplete (${response.stop_reason})`);

  const [row] = await db.insert<{ id: number; created_at: string; days: number; model: string; summary: Summary }>("ai_summaries", {
    site_id: siteId,
    days,
    model: response.model,
    summary: response.parsed_output,
  });
  return row;
}
