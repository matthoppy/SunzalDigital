export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** YYYY-MM-DD in UTC, `offsetDays` from today. */
export function isoDate(offsetDays = 0, from = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** "https://www.Example.co.uk/path" -> "example.co.uk" */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  return s.replace(/^www\./, "").replace(/\.$/, "");
}

export function domainMatches(candidate: string | null | undefined, domain: string): boolean {
  if (!candidate) return false;
  const c = normalizeDomain(candidate);
  return c === domain || c.endsWith("." + domain);
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: response was not JSON`);
  }
}
