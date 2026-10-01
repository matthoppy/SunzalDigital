CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  gsc_property TEXT,
  cf_site_tag TEXT,
  cf_zone_id TEXT,
  default_location TEXT,
  business_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT,
  last_sync_error TEXT,
  ranks_requested_on TEXT
);

CREATE TABLE keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  area TEXT,
  location TEXT NOT NULL,
  track_maps INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, keyword, location)
);

-- One row per keyword per day per result type. position NULL = not found within RANK_DEPTH.
CREATE TABLE rank_checks (
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organic', 'maps')),
  position INTEGER,
  url TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (keyword_id, date, kind)
);

CREATE TABLE traffic_daily (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  PRIMARY KEY (site_id, date)
);

-- Core Web Vitals p75 (ms, CLS unitless) and median page load time
CREATE TABLE vitals_daily (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  lcp_ms REAL,
  inp_ms REAL,
  cls REAL,
  ttfb_ms REAL,
  fcp_ms REAL,
  page_load_ms REAL,
  PRIMARY KEY (site_id, date)
);

CREATE TABLE gsc_daily (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (site_id, date)
);

-- Latest 28-day Search Console snapshot, replaced on every sync
CREATE TABLE gsc_queries (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (site_id, query)
);

CREATE TABLE gsc_pages (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  status_code INTEGER,
  checked_at TEXT,
  PRIMARY KEY (site_id, page)
);

-- Issues found during the last sync (sitemaps, broken pages, sync errors)
CREATE TABLE seo_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX seo_issues_site ON seo_issues (site_id);

CREATE TABLE uptime_checks (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  response_ms INTEGER,
  error TEXT,
  PRIMARY KEY (site_id, checked_at)
);
