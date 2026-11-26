-- Migration 0003: Viral ecosystem absorption request queue (`POST /v1/requests`)
-- Allows anonymous `cap from -npm/-crate` users to submit package absorption requests
-- for clean-room official CI verification & Ed25519-signed publication to `@cap/*`.

CREATE TABLE IF NOT EXISTS absorption_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ecosystem TEXT NOT NULL, -- 'npm' | 'crates.io'
  package_name TEXT NOT NULL,
  requested_version TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'building' | 'published' | 'rejected'
  cp_target TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  first_requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(ecosystem, package_name)
);

CREATE INDEX IF NOT EXISTS idx_absorption_requests_hot ON absorption_requests(status, request_count DESC);
