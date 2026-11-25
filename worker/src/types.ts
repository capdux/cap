// Shared types for capdux.org Cloudflare Worker

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  REGISTRY_ORIGIN: string;
  DOWNLOAD_ORIGIN: string;
  INDEX_ORIGIN: string;
  WEB_ORIGIN: string;
  MAX_TARBALL_BYTES: string;
  ADMIN_BOOTSTRAP_KEY?: string;
  /** Optional base64-encoded PKCS8 Ed25519 private key stored as Cloudflare Worker Secret. */
  CAPDUX_SIGNING_PRIVATE_KEY?: string;
  /** Optional base64-encoded SPKI Ed25519 public key matching CAPDUX_SIGNING_PRIVATE_KEY. */
  CAPDUX_SIGNING_PUBLIC_KEY?: string;
  CAPDUX_SIGNING_KEY_ID?: string;
}

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: "admin" | "maintainer" | "user";
  tokenScope: "read" | "publish" | "admin";
}

export interface PackageRow {
  id: number;
  name: string;
  scope: string;
  short_name: string;
  description: string;
  license: string;
  repository: string;
  homepage: string;
  keywords_json: string;
  owner_id: number;
  latest_version: string;
  total_downloads: number;
  deprecated: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  package_id: number;
  version: string;
  manifest_json: string;
  deps_json: string;
  readme_md: string;
  types_dcp: string;
  archive_format: "cap" | "zst" | "tgz";
  r2_key: string;
  archive_size: number;
  unpacked_size: number;
  integrity: string;
  prebuilt_json: string;
  dist_tag: string;
  yanked: number;
  yank_reason: string | null;
  downloads: number;
  published_by: number;
  published_at: string;
  security_status?: string;
  security_report_json?: string;
  platform_sig?: string;
  signing_key_id?: string;
  permissions_json?: string;
}

export interface SecurityScanReport {
  passed: boolean;
  status: "verified" | "rejected";
  checks: {
    archive_magic: boolean;
    compression_ratio_ok: boolean;
    license_compliant: boolean;
    no_suspicious_hooks: boolean;
  };
  warnings: string[];
  errors: string[];
  scanned_at: string;
}

export interface SparseIndexVersion {
  ver: string;
  deps: Record<string, string>;
  format: "cap" | "zst" | "tgz";
  integrity: string;
  size: number;
  unpacked_size: number;
  url: string;
  security_status: string;
  platform_sig: string;
  signing_key_id: string;
  permissions?: Record<string, unknown>;
  prebuilt?: Record<string, { url: string; integrity: string; size: number }>;
  yanked?: boolean;
  published_at: string;
}

export interface SparseIndexDoc {
  name: string;
  description: string;
  license: string;
  repository: string;
  latest: string;
  updated_at: string;
  versions: SparseIndexVersion[];
}
