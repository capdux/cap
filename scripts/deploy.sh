#!/usr/bin/env bash
# One-click Cloudflare deployment script for capdux.org (Workers + D1 + R2)
# Usage:
#   export CLOUDFLARE_API_TOKEN="your_api_token"
#   export CLOUDFLARE_ACCOUNT_ID="your_account_id"
#   bash scripts/deploy.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "[ERROR] Missing CLOUDFLARE_API_TOKEN. Create a Scoped API Token in Cloudflare Dashboard (Workers Scripts:Edit, Workers Routes:Edit, D1:Edit, Workers R2 Storage:Edit, Zone:Read)."
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "[ERROR] Missing CLOUDFLARE_ACCOUNT_ID. Copy it from Cloudflare Dashboard -> Workers & Pages -> Account ID."
  exit 1
fi

WRANGLER="npx --yes wrangler@latest"

echo "[1/5] Ensuring Cloudflare D1 database 'capdux-db' exists..."
DB_LIST=$($WRANGLER d1 list --json 2>/dev/null || echo "[]")
DB_ID=$(printf '%s' "$DB_LIST" | node -e '
  const fs = require("fs");
  const list = JSON.parse(fs.readFileSync(0, "utf8") || "[]");
  const hit = list.find((d) => d.name === "capdux-db");
  if (hit) process.stdout.write(hit.uuid);
')

if [[ -z "$DB_ID" ]]; then
  echo "  -> Creating D1 database 'capdux-db'..."
  CREATE_OUT=$($WRANGLER d1 create capdux-db 2>&1)
  DB_ID=$(printf '%s' "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1)
fi

if [[ -z "$DB_ID" ]]; then
  echo "[ERROR] Failed to resolve D1 database_id for capdux-db."
  exit 1
fi
echo "  -> D1 capdux-db ID: $DB_ID"

# Patch database_id into wrangler.toml idempotently
sed -i "s/database_id = \".*\"/database_id = \"${DB_ID}\"/" wrangler.toml

echo "[2/5] Ensuring Cloudflare R2 bucket 'capdux-packages' exists..."
if ! $WRANGLER r2 bucket list 2>/dev/null | grep -q "capdux-packages"; then
  $WRANGLER r2 bucket create capdux-packages
fi
echo "  -> R2 bucket 'capdux-packages' ready."

echo "[3/5] Applying remote D1 migrations..."
$WRANGLER d1 migrations apply capdux-db --remote

if [[ -n "${CAPDUX_ADMIN_BOOTSTRAP_KEY:-}" ]]; then
  echo "[4/5] Configuring ADMIN_BOOTSTRAP_KEY secret..."
  printf '%s' "$CAPDUX_ADMIN_BOOTSTRAP_KEY" | $WRANGLER secret put ADMIN_BOOTSTRAP_KEY
else
  echo "[4/5] Skipping ADMIN_BOOTSTRAP_KEY secret (set CAPDUX_ADMIN_BOOTSTRAP_KEY to enable bot seeding)."
fi

echo "[5/5] Deploying capdux-registry Worker to Cloudflare (capdux.org / registry.capdux.org / index.capdux.org / dl.capdux.org)..."
$WRANGLER deploy

echo ""
echo "[CAPDUX_DEPLOY_OK] https://capdux.org is live!"
echo "  - Web Portal:    https://capdux.org"
echo "  - Registry API:  https://registry.capdux.org/health"
echo "  - Sparse Index:  https://index.capdux.org/index/@cap/lru.json"
echo "  - Zero-Egress:   https://dl.capdux.org"
