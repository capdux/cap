-- Migration 0002: Platform Ed25519 signature, security scan report, and declarative capabilities (permissions)
ALTER TABLE package_versions ADD COLUMN security_status TEXT NOT NULL DEFAULT 'verified';
ALTER TABLE package_versions ADD COLUMN security_report_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE package_versions ADD COLUMN platform_sig TEXT NOT NULL DEFAULT '';
ALTER TABLE package_versions ADD COLUMN signing_key_id TEXT NOT NULL DEFAULT 'capdux-ed25519-v1';
ALTER TABLE package_versions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';
