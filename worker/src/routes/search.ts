// Search, stats, and global npm/crates.io deduplication registry.json routes
import { authenticateRequest } from "../auth";
import type { Env, PackageRow } from "../types";

const REGISTRY_JSON_R2_KEY = "registry.json";
const REGISTRY_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

interface UpstreamMappingRow {
  id: number;
  source_registry: string;
  source_name: string;
  source_repo: string;
  license: string;
  cp_target: string;
  kind: string;
  aliases_json: string;
  absorbed_at: string;
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(extraHeaders || {}),
    },
  });
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * GET /v1/search?q=&scope=&sort=downloads|updated&limit=20&offset=0
 */
export async function handleSearch(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") || "").trim();
  const scope = (url.searchParams.get("scope") || "").trim();
  const sort = url.searchParams.get("sort") === "updated" ? "updated" : "downloads";
  const rawLimit = Number(url.searchParams.get("limit") || "20");
  const rawOffset = Number(url.searchParams.get("offset") || "0");
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (q) {
    const like = `%${q}%`;
    whereClauses.push(
      `(name LIKE ? OR description LIKE ? OR keywords_json LIKE ? OR EXISTS (SELECT 1 FROM upstream_mappings um WHERE um.cp_target = packages.name AND (um.source_name LIKE ? OR um.aliases_json LIKE ?)))`,
    );
    params.push(like, like, like, like, like);
  }
  if (scope) {
    if (scope === "unscoped") {
      whereClauses.push(`scope = ''`);
    } else {
      whereClauses.push(`scope = ?`);
      params.push(scope);
    }
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const orderSql =
    sort === "updated"
      ? `ORDER BY updated_at DESC, total_downloads DESC`
      : `ORDER BY total_downloads DESC, updated_at DESC`;

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM packages ${whereSql}`)
    .bind(...params)
    .first<{ total: number }>();

  const { results } = await env.DB.prepare(
    `SELECT * FROM packages ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<PackageRow>();

  const pkgRows = results || [];
  const sourceMap = new Map<string, Array<{ registry: string; name: string; repo: string; renamed: boolean }>>();
  if (pkgRows.length > 0) {
    const placeholders = pkgRows.map(() => "?").join(",");
    const mapRes = await env.DB.prepare(
      `SELECT cp_target, source_registry, source_name, source_repo FROM upstream_mappings WHERE cp_target IN (${placeholders}) ORDER BY source_registry ASC, source_name ASC`,
    )
      .bind(...pkgRows.map((p) => p.name))
      .all<{ cp_target: string; source_registry: string; source_name: string; source_repo: string }>();
    for (const m of mapRes.results || []) {
      const list = sourceMap.get(m.cp_target) || [];
      const shortTarget = m.cp_target.replace(/^@[^/]+\//, "");
      list.push({
        registry: m.source_registry,
        name: m.source_name,
        repo: m.source_repo || "",
        renamed: m.source_name !== shortTarget,
      });
      sourceMap.set(m.cp_target, list);
    }
  }

  return json({
    total: Number(countRow?.total ?? 0),
    limit,
    offset,
    packages: pkgRows.map((p) => ({
      name: p.name,
      scope: p.scope,
      short_name: p.short_name,
      description: p.description,
      license: p.license,
      repository: p.repository,
      homepage: p.homepage,
      keywords: safeJsonParse<string[]>(p.keywords_json, []),
      upstream_sources: sourceMap.get(p.name) || [],
      latest_version: p.latest_version,
      total_downloads: p.total_downloads,
      deprecated: p.deprecated,
      created_at: p.created_at,
      updated_at: p.updated_at,
    })),
  });
}

/**
 * GET /v1/stats
 */
export async function handleStats(env: Env): Promise<Response> {
  const pkgStats = await env.DB.prepare(
    `SELECT COUNT(*) AS packages, COALESCE(SUM(total_downloads), 0) AS total_downloads FROM packages`,
  ).first<{ packages: number; total_downloads: number }>();

  const verStats = await env.DB.prepare(`SELECT COUNT(*) AS versions FROM package_versions`).first<{
    versions: number;
  }>();

  const mapStats = await env.DB.prepare(`SELECT COUNT(*) AS mappings FROM upstream_mappings`).first<{
    mappings: number;
  }>();

  return json({
    packages: Number(pkgStats?.packages ?? 0),
    versions: Number(verStats?.versions ?? 0),
    total_downloads: Number(pkgStats?.total_downloads ?? 0),
    mappings: Number(mapStats?.mappings ?? 0),
  });
}

async function buildRegistryJsonDoc(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM upstream_mappings ORDER BY kind ASC, source_registry ASC, source_name ASC`,
  ).all<UpstreamMappingRow>();

  const rows = results || [];
  const today = new Date().toISOString().slice(0, 10);

  return {
    version: "1.0.0",
    description:
      "Global deduplication & mapping registry for CP stdlib (cap:*) and @cap/* packages absorbed from npm and crates.io.",
    github_raw_url: "https://raw.githubusercontent.com/cp-lang/cp/main/packages/@cap/registry.json",
    updated_at: today,
    entries: rows.map((r) => ({
      source_registry: r.source_registry,
      source_name: r.source_name,
      source_repo: r.source_repo,
      license: r.license,
      cp_target: r.cp_target,
      kind: r.kind,
      aliases: safeJsonParse<string[]>(r.aliases_json, []),
      absorbed_at: r.absorbed_at,
    })),
  };
}

/**
 * GET /v1/registry.json and GET /registry.json
 * Compatible with packages/@cap/registry.json format.
 */
export async function handleGetRegistryJson(env: Env): Promise<Response> {
  const cached = await env.BUCKET.get(REGISTRY_JSON_R2_KEY);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": REGISTRY_CACHE_CONTROL,
        "X-Cache": "HIT",
      },
    });
  }

  const doc = await buildRegistryJsonDoc(env);
  await env.BUCKET.put(REGISTRY_JSON_R2_KEY, JSON.stringify(doc, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: REGISTRY_CACHE_CONTROL,
    },
  });

  return json(doc, 200, {
    "Cache-Control": REGISTRY_CACHE_CONTROL,
    "X-Cache": "MISS",
  });
}

/**
 * POST /v1/registry/sync (admin only)
 * Batch-upserts upstream_mappings (npm / crates.io deduplication entries) and updates R2 registry.json.
 */
export async function handleSyncRegistry(req: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (user.role !== "admin" && user.tokenScope !== "admin") {
    return json({ error: "Forbidden: admin role required" }, 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const entries = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).entries)
      ? ((body as Record<string, unknown>).entries as unknown[])
      : null;

  if (!entries) {
    return json({ error: "Expected JSON array or { entries: [...] }" }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  let synced = 0;

  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const sourceRegistry = typeof e.source_registry === "string" ? e.source_registry.trim() : "";
    const sourceName = typeof e.source_name === "string" ? e.source_name.trim() : "";
    const cpTarget = typeof e.cp_target === "string" ? e.cp_target.trim() : "";
    if (!sourceRegistry || !sourceName || !cpTarget) continue;

    const sourceRepo = typeof e.source_repo === "string" ? e.source_repo.trim() : "";
    const license = typeof e.license === "string" && e.license.trim() ? e.license.trim() : "MIT";
    const kind = e.kind === "stdlib" ? "stdlib" : "package";
    const aliases = Array.isArray(e.aliases)
      ? e.aliases.filter((a): a is string => typeof a === "string")
      : [];
    const absorbedAt =
      typeof e.absorbed_at === "string" && e.absorbed_at.trim() ? e.absorbed_at.trim() : today;

    await env.DB.prepare(
      `INSERT INTO upstream_mappings
       (source_registry, source_name, source_repo, license, cp_target, kind, aliases_json, absorbed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_registry, source_name) DO UPDATE SET
         source_repo = excluded.source_repo,
         license = excluded.license,
         cp_target = excluded.cp_target,
         kind = excluded.kind,
         aliases_json = excluded.aliases_json,
         absorbed_at = excluded.absorbed_at`,
    )
      .bind(
        sourceRegistry,
        sourceName,
        sourceRepo,
        license,
        cpTarget,
        kind,
        JSON.stringify(aliases),
        absorbedAt,
      )
      .run();

    synced++;
  }

  const doc = await buildRegistryJsonDoc(env);
  await env.BUCKET.put(REGISTRY_JSON_R2_KEY, JSON.stringify(doc, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: REGISTRY_CACHE_CONTROL,
    },
  });

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, "registry.sync", REGISTRY_JSON_R2_KEY, JSON.stringify({ synced, total: doc.entries.length }))
    .run()
    .catch(() => {});

  return json({
    ok: true,
    synced,
    total: doc.entries.length,
  });
}

/**
 * POST /v1/requests
 * Anonymous viral ecosystem absorption queue endpoint for `cap from -npm/-crate`.
 * Clients submit only upstream package metadata (never untrusted binaries);
 * capdux.org's clean-room CI bot verifies, builds, signs (Ed25519), and publishes to `@cap/*`.
 */
export async function handleSubmitAbsorptionRequest(req: Request, env: Env): Promise<Response> {
  let body: { ecosystem?: string; name?: string; version?: string };
  try {
    body = (await req.json()) as { ecosystem?: string; name?: string; version?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const rawEco = (body.ecosystem || "").trim().toLowerCase();
  const ecosystem = rawEco === "npm" ? "npm" : rawEco === "crates.io" || rawEco === "crate" || rawEco === "cargo" ? "crates.io" : "";
  const pkgName = (body.name || "").trim();
  const version = (body.version || "").trim().slice(0, 64);

  if (!ecosystem) {
    return json({ error: "ecosystem must be 'npm' or 'crates.io'" }, 400);
  }
  if (!pkgName || pkgName.length > 128 || !/^[@a-zA-Z0-9._/-]+$/.test(pkgName)) {
    return json({ error: "Invalid package name" }, 400);
  }

  // 1. Check if already absorbed in upstream_mappings
  const existing = await env.DB.prepare(
    `SELECT cp_target, kind FROM upstream_mappings WHERE lower(source_name) = lower(?) LIMIT 1`,
  )
    .bind(pkgName)
    .first<{ cp_target: string; kind: string }>();

  if (existing) {
    return json({
      ok: true,
      status: "already_absorbed",
      cp_target: existing.cp_target,
      kind: existing.kind,
    });
  }

  // 2. Upsert into absorption_requests queue and increment popularity counter
  await env.DB.prepare(
    `INSERT INTO absorption_requests (ecosystem, package_name, requested_version, request_count, status)
     VALUES (?, ?, ?, 1, 'queued')
     ON CONFLICT(ecosystem, package_name) DO UPDATE SET
       request_count = absorption_requests.request_count + 1,
       requested_version = CASE WHEN excluded.requested_version != '' THEN excluded.requested_version ELSE absorption_requests.requested_version END,
       last_requested_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  )
    .bind(ecosystem, pkgName, version)
    .run();

  const row = await env.DB.prepare(
    `SELECT id, ecosystem, package_name, requested_version, request_count, status FROM absorption_requests WHERE ecosystem = ? AND package_name = ? LIMIT 1`,
  )
    .bind(ecosystem, pkgName)
    .first<{
      id: number;
      ecosystem: string;
      package_name: string;
      requested_version: string;
      request_count: number;
      status: string;
    }>();

  return json(
    {
      ok: true,
      status: row?.status || "queued",
      request: row,
    },
    202,
  );
}

/**
 * GET /v1/requests?status=queued&limit=50
 * Lists most-requested npm/crates.io packages for official clean-room CI absorption.
 */
export async function handleListAbsorptionRequests(env: Env, url: URL): Promise<Response> {
  const status = (url.searchParams.get("status") || "queued").trim();
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "50") || 50));

  const { results } = await env.DB.prepare(
    `SELECT id, ecosystem, package_name, requested_version, request_count, status, cp_target, first_requested_at, last_requested_at
     FROM absorption_requests
     WHERE status = ?
     ORDER BY request_count DESC, first_requested_at ASC
     LIMIT ?`,
  )
    .bind(status, limit)
    .all();

  return json({
    status,
    requests: results || [],
  });
}
