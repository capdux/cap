-- capdux.org D1 (SQLite) Schema v1
-- Supports scoped (@cap/*, @web/*, @user/*) & unscoped packages,
-- Zstd (.tar.zst) & npm-compat (.tgz) archives, prebuilt binary matrices,
-- SHA-256/SHA-512 SRI integrity, Sparse Index caching, and npm/crates.io deduplication registry.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'maintainer' | 'user'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, -- SHA-256 hex of bearer token (raw token never stored)
  scope TEXT NOT NULL DEFAULT 'publish', -- 'read' | 'publish' | 'admin'
  last_used_at TEXT,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, -- e.g. "@cap/lru", "@web/jwt", "my-pkg"
  scope TEXT NOT NULL DEFAULT '', -- e.g. "@cap", "@web", ""
  short_name TEXT NOT NULL, -- e.g. "lru", "jwt", "my-pkg"
  description TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT 'MIT',
  repository TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  owner_id INTEGER NOT NULL REFERENCES users(id),
  latest_version TEXT NOT NULL DEFAULT '',
  total_downloads INTEGER NOT NULL DEFAULT 0,
  deprecated TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_packages_scope ON packages(scope);
CREATE INDEX IF NOT EXISTS idx_packages_downloads ON packages(total_downloads DESC);
CREATE INDEX IF NOT EXISTS idx_packages_updated ON packages(updated_at DESC);

CREATE TABLE IF NOT EXISTS package_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL, -- full cap.json
  deps_json TEXT NOT NULL DEFAULT '{}', -- runtime dependencies
  readme_md TEXT NOT NULL DEFAULT '',
  types_dcp TEXT NOT NULL DEFAULT '', -- compact .d.cp AI interface stub
  archive_format TEXT NOT NULL DEFAULT 'zst', -- 'zst' (.tar.zst) | 'tgz' (.tgz)
  r2_key TEXT NOT NULL, -- e.g. "pkg/@cap/lru/1.0.0/lru-1.0.0.tar.zst"
  archive_size INTEGER NOT NULL DEFAULT 0,
  unpacked_size INTEGER NOT NULL DEFAULT 0,
  integrity TEXT NOT NULL, -- "sha256-<64hex>" or "sha512-<b64>"
  prebuilt_json TEXT NOT NULL DEFAULT '{}', -- { "linux-x86_64": { r2_key, size, integrity }, ... }
  dist_tag TEXT NOT NULL DEFAULT 'latest',
  yanked INTEGER NOT NULL DEFAULT 0,
  yank_reason TEXT,
  downloads INTEGER NOT NULL DEFAULT 0,
  published_by INTEGER NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(package_id, version)
);

CREATE INDEX IF NOT EXISTS idx_versions_pkg ON package_versions(package_id, published_at DESC);

-- Global npm / crates.io deduplication mapping table (backs /v1/registry.json for `cap from -npm/-crate`)
CREATE TABLE IF NOT EXISTS upstream_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_registry TEXT NOT NULL, -- 'npm' | 'crates.io'
  source_name TEXT NOT NULL,
  source_repo TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT 'MIT',
  cp_target TEXT NOT NULL, -- 'cap:bytes' | '@cap/lru'
  kind TEXT NOT NULL DEFAULT 'package', -- 'stdlib' | 'package'
  aliases_json TEXT NOT NULL DEFAULT '[]',
  absorbed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
  UNIQUE(source_registry, source_name)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
