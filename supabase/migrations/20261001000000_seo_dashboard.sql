-- Sunzal SEO Control Centre schema.
-- Only the Cloudflare Worker reads and writes these tables, using the project's secret
-- (service role) key. RLS is on with no policies, so the public anon/publishable key can't
-- see anything.

create table public.sites (
  id bigint generated always as identity primary key,
  name text not null,
  domain text not null unique,
  gsc_property text,
  cf_site_tag text,
  cf_zone_id text,
  default_location text,
  business_name text,
  created_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_sync_error text,
  ranks_requested_on date
);

create table public.keywords (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites (id) on delete cascade,
  keyword text not null,
  area text,
  location text not null,
  track_maps boolean not null default true,
  created_at timestamptz not null default now(),
  unique (site_id, keyword, location)
);

-- One row per keyword per day per result type. position null = not found within RANK_DEPTH.
create table public.rank_checks (
  keyword_id bigint not null references public.keywords (id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('organic', 'maps')),
  position int,
  url text,
  checked_at timestamptz not null default now(),
  primary key (keyword_id, date, kind)
);

create table public.traffic_daily (
  site_id bigint not null references public.sites (id) on delete cascade,
  date date not null,
  visits int not null default 0,
  pageviews int not null default 0,
  source text not null,
  primary key (site_id, date)
);

-- Core Web Vitals p75 (ms; CLS unitless) and median page load time
create table public.vitals_daily (
  site_id bigint not null references public.sites (id) on delete cascade,
  date date not null,
  samples int not null default 0,
  lcp_ms real,
  inp_ms real,
  cls real,
  ttfb_ms real,
  fcp_ms real,
  page_load_ms real,
  primary key (site_id, date)
);

create table public.gsc_daily (
  site_id bigint not null references public.sites (id) on delete cascade,
  date date not null,
  clicks int not null,
  impressions int not null,
  ctr double precision not null,
  position double precision not null,
  primary key (site_id, date)
);

-- Latest 28-day Search Console snapshot, replaced on every sync
create table public.gsc_queries (
  site_id bigint not null references public.sites (id) on delete cascade,
  query text not null,
  clicks int not null,
  impressions int not null,
  ctr double precision not null,
  position double precision not null,
  primary key (site_id, query)
);

create table public.gsc_pages (
  site_id bigint not null references public.sites (id) on delete cascade,
  page text not null,
  clicks int not null,
  impressions int not null,
  ctr double precision not null,
  position double precision not null,
  status_code int,
  checked_at timestamptz,
  primary key (site_id, page)
);

-- Google index status per sitemap URL (Search Console URL Inspection), checked a few per day
create table public.page_index (
  site_id bigint not null references public.sites (id) on delete cascade,
  url text not null,
  verdict text,
  coverage_state text,
  last_crawl_at timestamptz,
  checked_at timestamptz,
  primary key (site_id, url)
);

-- Issues found during the last sync (sitemaps, broken pages, sync errors)
create table public.seo_issues (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites (id) on delete cascade,
  severity text not null check (severity in ('critical', 'warning', 'info')),
  kind text not null,
  message text not null,
  url text,
  detected_at timestamptz not null default now()
);
create index seo_issues_site_id_idx on public.seo_issues (site_id);

create table public.uptime_checks (
  site_id bigint not null references public.sites (id) on delete cascade,
  checked_at timestamptz not null,
  ok boolean not null,
  status_code int,
  response_ms int,
  error text,
  primary key (site_id, checked_at)
);
create index uptime_checks_checked_at_idx on public.uptime_checks (checked_at);

create table public.ai_summaries (
  id bigint generated always as identity primary key,
  site_id bigint not null references public.sites (id) on delete cascade,
  created_at timestamptz not null default now(),
  days int not null,
  model text not null,
  summary jsonb not null
);
create index ai_summaries_site_created_idx on public.ai_summaries (site_id, created_at desc);

alter table public.sites enable row level security;
alter table public.keywords enable row level security;
alter table public.rank_checks enable row level security;
alter table public.traffic_daily enable row level security;
alter table public.vitals_daily enable row level security;
alter table public.gsc_daily enable row level security;
alter table public.gsc_queries enable row level security;
alter table public.gsc_pages enable row level security;
alter table public.page_index enable row level security;
alter table public.seo_issues enable row level security;
alter table public.uptime_checks enable row level security;
alter table public.ai_summaries enable row level security;

-- Portfolio table: one row per site with what the overview needs.
create or replace function public.sites_overview(p_days int)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'site', to_jsonb(s),
    'traffic', coalesce((
      select jsonb_agg(jsonb_build_object('date', t.date, 'visits', t.visits, 'pageviews', t.pageviews) order by t.date)
      from public.traffic_daily t where t.site_id = s.id and t.date > current_date - p_days * 2), '[]'::jsonb),
    'gsc', coalesce((
      select jsonb_agg(jsonb_build_object('date', g.date, 'clicks', g.clicks, 'impressions', g.impressions, 'position', g.position) order by g.date)
      from public.gsc_daily g where g.site_id = s.id and g.date > current_date - p_days * 2), '[]'::jsonb),
    'ranks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'keyword', k.keyword, 'area', k.area,
        'organic', (select r.position from public.rank_checks r where r.keyword_id = k.id and r.kind = 'organic' order by r.date desc limit 1),
        'maps', (select r.position from public.rank_checks r where r.keyword_id = k.id and r.kind = 'maps' order by r.date desc limit 1)
      ) order by k.id)
      from public.keywords k where k.site_id = s.id), '[]'::jsonb),
    'uptime', (
      select jsonb_build_object('checks', count(*), 'up', count(*) filter (where u.ok))
      from public.uptime_checks u where u.site_id = s.id and u.checked_at > now() - make_interval(days => p_days)),
    'issues', coalesce((
      select jsonb_agg(jsonb_build_object('severity', i.severity, 'n', i.n))
      from (select severity, count(*) as n from public.seo_issues where site_id = s.id group by severity) i), '[]'::jsonb),
    'index', (
      select jsonb_build_object('checked', count(*) filter (where p.verdict is not null), 'indexed', count(*) filter (where p.verdict = 'PASS'))
      from public.page_index p where p.site_id = s.id)
  ) order by s.name), '[]'::jsonb)
  from public.sites s;
$$;

-- Everything one site page needs, for the selected window plus the window before it.
create or replace function public.site_dashboard(p_site_id bigint, p_days int)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'site', to_jsonb(s),
    'traffic', coalesce((
      select jsonb_agg(jsonb_build_object('date', t.date, 'visits', t.visits, 'pageviews', t.pageviews) order by t.date)
      from public.traffic_daily t where t.site_id = s.id and t.date > current_date - p_days * 2), '[]'::jsonb),
    'vitals', coalesce((
      select jsonb_agg(to_jsonb(v) - 'site_id' order by v.date)
      from public.vitals_daily v where v.site_id = s.id and v.date > current_date - p_days), '[]'::jsonb),
    'gsc', coalesce((
      select jsonb_agg(jsonb_build_object('date', g.date, 'clicks', g.clicks, 'impressions', g.impressions, 'ctr', g.ctr, 'position', g.position) order by g.date)
      from public.gsc_daily g where g.site_id = s.id and g.date > current_date - p_days * 2), '[]'::jsonb),
    'keywords', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'site_id', k.site_id, 'keyword', k.keyword, 'area', k.area, 'location', k.location, 'track_maps', k.track_maps,
        'url', (select r.url from public.rank_checks r where r.keyword_id = k.id and r.kind = 'organic' and r.url is not null order by r.date desc limit 1),
        'gsc_position', (select q.position from public.gsc_queries q where q.site_id = k.site_id and lower(q.query) = k.keyword),
        'organic', coalesce((
          select jsonb_agg(jsonb_build_object('date', r.date, 'position', r.position) order by r.date)
          from public.rank_checks r where r.keyword_id = k.id and r.kind = 'organic' and r.date >= current_date - p_days), '[]'::jsonb),
        'maps', coalesce((
          select jsonb_agg(jsonb_build_object('date', r.date, 'position', r.position) order by r.date)
          from public.rank_checks r where r.keyword_id = k.id and r.kind = 'maps' and r.date >= current_date - p_days), '[]'::jsonb)
      ) order by k.area nulls last, k.keyword)
      from public.keywords k where k.site_id = s.id), '[]'::jsonb),
    'queries', coalesce((
      select jsonb_agg(to_jsonb(q) - 'site_id' order by q.clicks desc, q.impressions desc)
      from (select * from public.gsc_queries where site_id = s.id order by clicks desc, impressions desc limit 200) q), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'site_id' order by p.clicks desc, p.impressions desc)
      from (select * from public.gsc_pages where site_id = s.id order by clicks desc, impressions desc limit 50) p), '[]'::jsonb),
    'index', coalesce((
      select jsonb_agg(to_jsonb(p) - 'site_id' order by (p.verdict = 'PASS'), p.url)
      from public.page_index p where p.site_id = s.id and p.verdict is not null), '[]'::jsonb),
    'issues', coalesce((
      select jsonb_agg(to_jsonb(i) - 'site_id' - 'id')
      from public.seo_issues i where i.site_id = s.id), '[]'::jsonb),
    'uptime', jsonb_build_object(
      'daily', coalesce((
        select jsonb_agg(jsonb_build_object('date', d.date, 'checks', d.checks, 'up', d.up, 'avg_ms', d.avg_ms) order by d.date)
        from (
          select (u.checked_at at time zone 'utc')::date as date, count(*) as checks,
                 count(*) filter (where u.ok) as up, round(avg(u.response_ms))::int as avg_ms
          from public.uptime_checks u
          where u.site_id = s.id and u.checked_at >= (current_date - (p_days - 1))::timestamptz
          group by 1
        ) d), '[]'::jsonb),
      'last', (select to_jsonb(u) - 'site_id' from public.uptime_checks u where u.site_id = s.id order by u.checked_at desc limit 1)),
    'summary', (select to_jsonb(a) - 'site_id' from public.ai_summaries a where a.site_id = s.id order by a.created_at desc limit 1)
  )
  from public.sites s
  where s.id = p_site_id;
$$;

revoke execute on function public.sites_overview(int) from public, anon, authenticated;
revoke execute on function public.site_dashboard(bigint, int) from public, anon, authenticated;
grant execute on function public.sites_overview(int) to service_role;
grant execute on function public.site_dashboard(bigint, int) to service_role;
