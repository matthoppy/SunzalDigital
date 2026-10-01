export interface UptimeResult {
  ok: boolean;
  status_code: number | null;
  response_ms: number | null;
  error: string | null;
}

export async function checkUrl(url: string, timeoutMs = 10_000): Promise<UptimeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "SunzalSEODashboard/1.0 (+uptime check)" },
    });
    await res.body?.cancel();
    return {
      ok: res.status < 400,
      status_code: res.status,
      response_ms: Date.now() - started,
      error: res.status < 400 ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, status_code: null, response_ms: null, error: timedOut ? "Timed out" : String(err) };
  }
}
