import { handleApi, handleRankWebhook } from "./api";
import type { Env } from "./env";
import { runUptimeChecks, syncDueSites } from "./sync";
import { timingSafeEqual } from "./util";

async function authorized(req: Request, env: Env): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(password, env.DASHBOARD_PASSWORD!);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    // DataForSEO results arrive here, authenticated by WEBHOOK_SECRET instead of the password.
    if (url.pathname === "/api/webhooks/dataforseo" && req.method === "POST") {
      return handleRankWebhook(req, env, url);
    }

    if (!env.DASHBOARD_PASSWORD) {
      return new Response("Set a DASHBOARD_PASSWORD secret before using the dashboard: npx wrangler secret put DASHBOARD_PASSWORD", {
        status: 503,
      });
    }
    if (!(await authorized(req, env))) {
      return new Response("Sign in with the dashboard password.", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="SEO dashboard", charset="UTF-8"' },
      });
    }

    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx): Promise<void> {
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(runUptimeChecks(env));
    } else {
      ctx.waitUntil(
        syncDueSites(env).then((reports) => {
          for (const r of reports) console.log(JSON.stringify(r));
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;
