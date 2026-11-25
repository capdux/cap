#!/usr/bin/env bash
# Zero-data-loss backup script for capdux.org Cloudflare D1 database
# Exports a full point-in-time SQL snapshot locally so user accounts, package metadata,
# download counts, and audit logs can be restored or migrated anywhere in minutes.

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
OUT_FILE="${BACKUP_DIR}/capdux-db-${STAMP}.sql"

echo "[backup] Exporting Cloudflare D1 'capdux-db' -> ${OUT_FILE} ..."
npx --yes wrangler@latest d1 export capdux-db --remote --output="$OUT_FILE"
gzip -f "$OUT_FILE"
echo "[backup] OK -> ${OUT_FILE}.gz ($(du -h "${OUT_FILE}.gz" | cut -f1))"
