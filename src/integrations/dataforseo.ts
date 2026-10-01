import type { Env, Keyword } from "../env";
import { intVar } from "../env";
import { domainMatches, fetchJson } from "../util";

const API = "https://api.dataforseo.com/v3/serp/google";

export type RankKind = "organic" | "maps";

/**
 * Queues one SERP task per keyword. DataForSEO POSTs each result to our webhook
 * when it is ready, so a site with 100 keywords costs one request here.
 */
export async function postRankTasks(env: Env, kind: RankKind, keywords: Keyword[], date: string): Promise<number> {
  if (!keywords.length) return 0;
  const auth = btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const callback = new URL("/api/webhooks/dataforseo", env.PUBLIC_URL);
  callback.searchParams.set("kind", kind);
  callback.searchParams.set("token", env.WEBHOOK_SECRET ?? "");
  const postbackUrl = callback.toString();

  let created = 0;
  for (let i = 0; i < keywords.length; i += 100) {
    const tasks = keywords.slice(i, i + 100).map((k) => ({
      keyword: k.keyword,
      location_name: k.location,
      language_code: env.RANK_LANGUAGE_CODE || "en",
      device: "mobile",
      depth: intVar(env.RANK_DEPTH, 30),
      tag: `${k.id}:${date}`,
      postback_url: postbackUrl,
      postback_data: "advanced",
    }));
    const res = await fetchJson<{
      status_code: number;
      status_message: string;
      tasks?: { status_code: number; status_message: string }[];
    }>(
      `${API}/${kind}/task_post`,
      {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
        body: JSON.stringify(tasks),
      },
      "DataForSEO",
    );
    if (res.status_code !== 20000) throw new Error(`DataForSEO: ${res.status_message}`);
    const failed = (res.tasks ?? []).filter((t) => t.status_code !== 20100);
    created += tasks.length - failed.length;
    if (failed.length) throw new Error(`DataForSEO: ${failed.length} ${kind} task(s) rejected: ${failed[0].status_message}`);
  }
  return created;
}

interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  domain?: string;
  url?: string;
  title?: string;
}

export interface PostbackTask {
  id: string;
  status_code: number;
  status_message: string;
  data?: { tag?: string; keyword?: string };
  result?: { items?: SerpItem[] | null }[] | null;
}

/** Reads a postback body, which DataForSEO sends gzip-compressed. */
export async function readPostback(request: Request): Promise<{ tasks?: PostbackTask[] }> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return JSON.parse(text);
}

/** Finds the site's position in a SERP. Returns null position when it isn't in the results. */
export function findPosition(
  kind: RankKind,
  items: SerpItem[],
  domain: string,
  businessName: string | null,
): { position: number | null; url: string | null } {
  const wanted = kind === "organic" ? "organic" : "maps_search";
  const name = businessName?.trim().toLowerCase();
  for (const item of items) {
    if (item.type !== wanted) continue;
    const byDomain = domainMatches(item.domain ?? item.url, domain);
    const byName = kind === "maps" && name && item.title?.toLowerCase().includes(name);
    if (byDomain || byName) {
      return { position: item.rank_group ?? item.rank_absolute ?? null, url: item.url ?? null };
    }
  }
  return { position: null, url: null };
}
