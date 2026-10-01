import type { Env } from "./env";

/**
 * Minimal Supabase (PostgREST) client. The worker uses the project's secret key, which
 * bypasses row-level security; the tables have no public policies.
 */
export class Db {
  private base: string;
  private headers: Record<string, string>;

  constructor(env: Env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      throw new Error("Set SUPABASE_URL and the SUPABASE_SECRET_KEY secret");
    }
    this.base = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1`;
    const key = env.SUPABASE_SECRET_KEY;
    // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys go in apikey only.
    this.headers = { apikey: key, ...(key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {}) };
  }

  private async request<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await fetch(`${this.base}/${path}`, {
      method,
      headers: {
        ...this.headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(prefer ? { prefer } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const err = JSON.parse(text) as { message?: string; code?: string };
        message = `${err.code ?? res.status}: ${err.message ?? message}`;
      } catch {}
      throw new DbError(res.status, `Supabase: ${message}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /** `query` is a PostgREST query string, e.g. "select=*&site_id=eq.1&order=date". */
  select<T>(table: string, query = "select=*"): Promise<T[]> {
    return this.request<T[]>("GET", `${table}?${query}`);
  }

  async first<T>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, `${query}&limit=1`);
    return rows[0] ?? null;
  }

  async insert<T>(table: string, rows: object | object[]): Promise<T[]> {
    return this.request<T[]>("POST", table, rows, "return=representation");
  }

  /** Insert or update on the given conflict columns. ignore=true skips existing rows instead. */
  async upsert(table: string, rows: object[], onConflict: string, ignore = false): Promise<void> {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 1000) {
      await this.request(
        "POST",
        `${table}?on_conflict=${onConflict}`,
        rows.slice(i, i + 1000),
        `resolution=${ignore ? "ignore" : "merge"}-duplicates,return=minimal`,
      );
    }
  }

  async update<T>(table: string, filter: string, values: object): Promise<T[]> {
    return this.request<T[]>("PATCH", `${table}?${filter}`, values, "return=representation");
  }

  async delete(table: string, filter: string): Promise<void> {
    await this.request("DELETE", `${table}?${filter}`, undefined, "return=minimal");
  }

  rpc<T>(fn: string, args: object): Promise<T> {
    return this.request<T>("POST", `rpc/${fn}`, args);
  }
}

export class DbError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
