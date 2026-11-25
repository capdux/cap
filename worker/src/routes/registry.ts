// Core Registry API routes: package metadata, Sparse Index, publish, yank/unyank, R2 download
import { authenticateRequest, canPublishPackage } from "../auth";
import {
  archiveR2Key,
  computeSha256Integrity,
  detectArchiveFormat,
  isValidSemver,
  sparseIndexR2Key,
  splitPackageName,
  syncSparseIndex,
  verifyIntegrity,
} from "../storage";
import type { Env, PackageRow, VersionRow } from "../types";

const SPARSE_INDEX_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const ARCHIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(extraHeaders || {}),
    },
  });
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const cleaned = b64.replace(/\s+/g, "");
    const bin = atob(cleaned);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * GET /v1/packages/<name>
 * Supports both scoped (@scope/name) and unscoped (name) packages.
 */
export async function handleGetPackage(env: Env, rawName: string): Promise<Response> {
  const pkgName = safeDecode(rawName).replace(/^\/+|\/+$/g, "");
  if (!splitPackageName(pkgName)) {
    return json({ error: "Invalid package name" }, 400);
  }

  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(pkgName)
    .first<PackageRow>();

  if (!pkg) {
    return json({ error: `Package '${pkgName}' not found` }, 404);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM package_versions WHERE package_id = ? ORDER BY published_at DESC, id DESC`,
  )
    .bind(pkg.id)
    .all<VersionRow>();

  const rows = results || [];
  const dlOrigin = env.DOWNLOAD_ORIGIN || "https://dl.capdux.org";

  const distTags: Record<string, string> = {};
  if (pkg.latest_version) {
    distTags.latest = pkg.latest_version;
  }
  for (const v of rows) {
    if (!v.yanked && v.dist_tag && !(v.dist_tag in distTags)) {
      distTags[v.dist_tag] = v.version;
    }
  }

  return json({
    id: pkg.id,
    name: pkg.name,
    scope: pkg.scope,
    short_name: pkg.short_name,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    homepage: pkg.homepage,
    keywords: safeJsonParse<string[]>(pkg.keywords_json, []),
    latest_version: pkg.latest_version,
    total_downloads: pkg.total_downloads,
    deprecated: pkg.deprecated,
    created_at: pkg.created_at,
    updated_at: pkg.updated_at,
    "dist-tags": distTags,
    versions: rows.map((v) => ({
      version: v.version,
      format: v.archive_format,
      r2_key: v.r2_key,
      url: `${dlOrigin}/${v.r2_key}`,
      archive_size: v.archive_size,
      unpacked_size: v.unpacked_size,
      integrity: v.integrity,
      deps: safeJsonParse<Record<string, string>>(v.deps_json, {}),
      manifest: safeJsonParse<Record<string, unknown>>(v.manifest_json, {}),
      prebuilt: safeJsonParse<Record<string, unknown>>(v.prebuilt_json, {}),
      readme_md: v.readme_md,
      types_dcp: v.types_dcp,
      dist_tag: v.dist_tag,
      yanked: Boolean(v.yanked),
      yank_reason: v.yank_reason,
      downloads: v.downloads,
      published_at: v.published_at,
    })),
  });
}

/**
 * GET /index/<name>.json
 * Sparse Index: reads R2 edge cache first, falls back to D1 + writes back to R2.
 */
export async function handleSparseIndex(env: Env, rawName: string): Promise<Response> {
  const pkgName = safeDecode(rawName).replace(/^\/+|\/+$/g, "");
  if (!splitPackageName(pkgName)) {
    return json({ error: "Invalid package name" }, 400);
  }

  const r2Key = sparseIndexR2Key(pkgName);
  const cached = await env.BUCKET.get(r2Key);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": SPARSE_INDEX_CACHE_CONTROL,
        "X-Cache": "HIT",
      },
    });
  }

  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(pkgName)
    .first<PackageRow>();

  if (!pkg) {
    return json({ error: `Package '${pkgName}' not found` }, 404);
  }

  const doc = await syncSparseIndex(env, pkg);
  return json(doc, 200, {
    "Cache-Control": SPARSE_INDEX_CACHE_CONTROL,
    "X-Cache": "MISS",
  });
}

/**
 * PUT /v1/publish (and POST /v1/publish)
 * Accepts multipart/form-data (metadata + archive + optional readme/types_dcp)
 * or JSON base64 payload.
 */
export async function handlePublish(req: Request, env: Env): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized: Bearer token required" }, 401);
  }

  const contentType = (req.headers.get("Content-Type") || "").toLowerCase();
  let metadata: Record<string, any> | null = null;
  let archiveBytes: Uint8Array | null = null;
  let readmeMd = "";
  let typesDcp = "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "Malformed multipart/form-data payload" }, 400);
    }

    const metaField = form.get("metadata");
    if (typeof metaField === "string") {
      metadata = safeJsonParse<Record<string, any> | null>(metaField, null);
    } else if (metaField && typeof (metaField as Blob).text === "function") {
      metadata = safeJsonParse<Record<string, any> | null>(await (metaField as Blob).text(), null);
    }

    const archiveField = form.get("archive") ?? form.get("tarball");
    if (archiveField && typeof (archiveField as Blob).arrayBuffer === "function") {
      archiveBytes = new Uint8Array(await (archiveField as Blob).arrayBuffer());
    } else if (typeof archiveField === "string") {
      archiveBytes = decodeBase64(archiveField);
    }

    const readmeField = form.get("readme");
    if (typeof readmeField === "string") {
      readmeMd = readmeField;
    } else if (readmeField && typeof (readmeField as Blob).text === "function") {
      readmeMd = await (readmeField as Blob).text();
    }

    const typesField = form.get("types_dcp");
    if (typeof typesField === "string") {
      typesDcp = typesField;
    } else if (typesField && typeof (typesField as Blob).text === "function") {
      typesDcp = await (typesField as Blob).text();
    }
  } else {
    let body: Record<string, any>;
    try {
      body = (await req.json()) as Record<string, any>;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (body.metadata && typeof body.metadata === "object") {
      metadata = body.metadata;
    } else {
      metadata = body;
    }

    const b64 =
      typeof body.archive_base64 === "string"
        ? body.archive_base64
        : typeof body.tarball_base64 === "string"
          ? body.tarball_base64
          : typeof body.archive === "string"
            ? body.archive
            : "";
    if (b64) {
      archiveBytes = decodeBase64(b64);
    }

    if (typeof body.readme === "string") readmeMd = body.readme;
    else if (typeof body.readme_md === "string") readmeMd = body.readme_md;
    if (typeof body.types_dcp === "string") typesDcp = body.types_dcp;
  }

  if (!metadata || typeof metadata !== "object") {
    return json({ error: "Missing or invalid metadata JSON" }, 400);
  }

  const pkgName = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const version = typeof metadata.version === "string" ? metadata.version.trim() : "";

  const nameParts = splitPackageName(pkgName);
  if (!nameParts) {
    return json({ error: `Invalid package name: '${pkgName}'` }, 400);
  }
  if (!isValidSemver(version)) {
    return json({ error: `Invalid semver version: '${version}'` }, 400);
  }

  // Check existing package & publish permissions
  const existingPkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(pkgName)
    .first<PackageRow>();

  if (!canPublishPackage(user, nameParts.scope, existingPkg ? existingPkg.owner_id : null)) {
    return json({ error: `Forbidden: you do not have permission to publish '${pkgName}'` }, 403);
  }

  // Validate archive presence, size, magic bytes, and integrity
  if (!archiveBytes || archiveBytes.byteLength === 0) {
    return json({ error: "Missing archive payload" }, 400);
  }

  const maxBytes = Number(env.MAX_TARBALL_BYTES || "52428800");
  if (Number.isFinite(maxBytes) && archiveBytes.byteLength > maxBytes) {
    return json(
      { error: `Archive exceeds maximum allowed size (${maxBytes} bytes)` },
      413,
    );
  }

  const format = detectArchiveFormat(archiveBytes);
  if (!format) {
    return json(
      { error: "Invalid archive magic bytes: expected Zstd (.tar.zst: 28 B5 2F FD) or Gzip (.tgz: 1F 8B)" },
      400,
    );
  }

  const computedIntegrity = await computeSha256Integrity(archiveBytes);
  const clientIntegrity = typeof metadata.integrity === "string" ? metadata.integrity.trim() : "";
  if (clientIntegrity) {
    const valid = await verifyIntegrity(archiveBytes, clientIntegrity);
    if (!valid) {
      return json(
        { error: `Integrity verification failed: expected ${clientIntegrity}, computed ${computedIntegrity}` },
        400,
      );
    }
  }
  const integrity = clientIntegrity || computedIntegrity;

  // Reject overwriting an already-published version
  if (existingPkg) {
    const dup = await env.DB.prepare(
      `SELECT id FROM package_versions WHERE package_id = ? AND version = ? LIMIT 1`,
    )
      .bind(existingPkg.id, version)
      .first<{ id: number }>();

    if (dup) {
      return json(
        { error: `Version ${pkgName}@${version} already exists; published versions are immutable` },
        409,
      );
    }
  }

  // Extract optional metadata fields
  const description = typeof metadata.description === "string" ? metadata.description : existingPkg?.description || "";
  const license = typeof metadata.license === "string" && metadata.license.trim() ? metadata.license.trim() : existingPkg?.license || "MIT";
  const repository = typeof metadata.repository === "string" ? metadata.repository : existingPkg?.repository || "";
  const homepage = typeof metadata.homepage === "string" ? metadata.homepage : existingPkg?.homepage || "";
  const keywords = Array.isArray(metadata.keywords)
    ? metadata.keywords.filter((k: unknown) => typeof k === "string")
    : existingPkg
      ? safeJsonParse<string[]>(existingPkg.keywords_json, [])
      : [];
  const deps =
    metadata.dependencies && typeof metadata.dependencies === "object"
      ? metadata.dependencies
      : metadata.deps && typeof metadata.deps === "object"
        ? metadata.deps
        : {};
  const prebuilt = metadata.prebuilt && typeof metadata.prebuilt === "object" ? metadata.prebuilt : {};
  const distTag = typeof metadata.dist_tag === "string" && metadata.dist_tag.trim() ? metadata.dist_tag.trim() : "latest";
  const unpackedSize = typeof metadata.unpacked_size === "number" && metadata.unpacked_size >= 0 ? Math.floor(metadata.unpacked_size) : 0;

  if (!readmeMd && typeof metadata.readme === "string") readmeMd = metadata.readme;
  if (!typesDcp && typeof metadata.types_dcp === "string") typesDcp = metadata.types_dcp;

  // Upload archive to R2
  const r2Key = archiveR2Key(pkgName, version, format);
  const archiveContentType = format === "zst" ? "application/zstd" : "application/gzip";
  await env.BUCKET.put(r2Key, archiveBytes, {
    httpMetadata: {
      contentType: archiveContentType,
      cacheControl: ARCHIVE_CACHE_CONTROL,
    },
    customMetadata: {
      package: pkgName,
      version,
      integrity,
      format,
    },
  });

  // Upsert package row in D1
  if (!existingPkg) {
    await env.DB.prepare(
      `INSERT INTO packages (name, scope, short_name, description, license, repository, homepage, keywords_json, owner_id, latest_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        pkgName,
        nameParts.scope,
        nameParts.shortName,
        description,
        license,
        repository,
        homepage,
        JSON.stringify(keywords),
        user.id,
        version,
      )
      .run();
  } else {
    const newLatest = distTag === "latest" || !existingPkg.latest_version ? version : existingPkg.latest_version;
    await env.DB.prepare(
      `UPDATE packages
       SET description = ?, license = ?, repository = ?, homepage = ?, keywords_json = ?,
           latest_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`,
    )
      .bind(description, license, repository, homepage, JSON.stringify(keywords), newLatest, existingPkg.id)
      .run();
  }

  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(pkgName)
    .first<PackageRow>();

  if (!pkg) {
    return json({ error: "Failed to persist package metadata" }, 500);
  }

  // Insert version row in D1
  await env.DB.prepare(
    `INSERT INTO package_versions
     (package_id, version, manifest_json, deps_json, readme_md, types_dcp, archive_format, r2_key,
      archive_size, unpacked_size, integrity, prebuilt_json, dist_tag, published_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      pkg.id,
      version,
      JSON.stringify(metadata),
      JSON.stringify(deps),
      readmeMd,
      typesDcp,
      format,
      r2Key,
      archiveBytes.byteLength,
      unpackedSize,
      integrity,
      JSON.stringify(prebuilt),
      distTag,
      user.id,
    )
    .run();

  // Record audit log
  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(
      user.id,
      "package.publish",
      `${pkgName}@${version}`,
      JSON.stringify({ format, size: archiveBytes.byteLength, integrity, r2_key: r2Key }),
    )
    .run()
    .catch(() => {});

  // Rebuild & push Sparse Index to R2
  await syncSparseIndex(env, pkg);

  const dlOrigin = env.DOWNLOAD_ORIGIN || "https://dl.capdux.org";
  const indexOrigin = env.INDEX_ORIGIN || "https://index.capdux.org";

  return json(
    {
      ok: true,
      name: pkgName,
      version,
      format,
      integrity,
      size: archiveBytes.byteLength,
      r2_key: r2Key,
      url: `${dlOrigin}/${r2Key}`,
      index_url: `${indexOrigin}/${pkgName}.json`,
    },
    201,
  );
}

/**
 * POST /v1/packages/<name>/<version>/yank
 * POST /v1/packages/<name>/<version>/unyank
 */
export async function handleYank(
  req: Request,
  env: Env,
  rawName: string,
  rawVersion: string,
  yanked: boolean,
): Promise<Response> {
  const user = await authenticateRequest(req, env);
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const pkgName = safeDecode(rawName).replace(/^\/+|\/+$/g, "");
  const version = safeDecode(rawVersion).trim();

  if (!splitPackageName(pkgName) || !isValidSemver(version)) {
    return json({ error: "Invalid package name or version" }, 400);
  }

  const pkg = await env.DB.prepare(`SELECT * FROM packages WHERE name = ? LIMIT 1`)
    .bind(pkgName)
    .first<PackageRow>();

  if (!pkg) {
    return json({ error: `Package '${pkgName}' not found` }, 404);
  }

  if (!canPublishPackage(user, pkg.scope, pkg.owner_id)) {
    return json({ error: "Forbidden" }, 403);
  }

  const verRow = await env.DB.prepare(
    `SELECT id FROM package_versions WHERE package_id = ? AND version = ? LIMIT 1`,
  )
    .bind(pkg.id, version)
    .first<{ id: number }>();

  if (!verRow) {
    return json({ error: `Version ${pkgName}@${version} not found` }, 404);
  }

  let reason: string | null = null;
  if (yanked) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (body && typeof body.reason === "string" && body.reason.trim()) {
        reason = body.reason.trim().slice(0, 256);
      }
    } catch {}
  }

  await env.DB.prepare(`UPDATE package_versions SET yanked = ?, yank_reason = ? WHERE id = ?`)
    .bind(yanked ? 1 : 0, reason, verRow.id)
    .run();

  await env.DB.prepare(
    `UPDATE packages SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
  )
    .bind(pkg.id)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES (?, ?, ?, ?)`,
  )
    .bind(user.id, yanked ? "package.yank" : "package.unyank", `${pkgName}@${version}`, reason || "")
    .run()
    .catch(() => {});

  const updatedPkg = await env.DB.prepare(`SELECT * FROM packages WHERE id = ? LIMIT 1`)
    .bind(pkg.id)
    .first<PackageRow>();

  if (updatedPkg) {
    await syncSparseIndex(env, updatedPkg);
  }

  return json({
    ok: true,
    name: pkgName,
    version,
    yanked,
    reason,
  });
}

/**
 * GET /dl/<r2_key>
 * Streams archive from R2 with immutable cache headers, ETag, and async download count increment.
 */
export async function handleDownload(
  env: Env,
  ctx: ExecutionContext | undefined,
  rawKey: string,
): Promise<Response> {
  const r2Key = safeDecode(rawKey).replace(/^\/+/, "");
  if (!r2Key || r2Key.includes("..")) {
    return json({ error: "Invalid archive key" }, 400);
  }

  const obj = await env.BUCKET.get(r2Key);
  if (!obj) {
    return json({ error: "Archive not found" }, 404);
  }

  // Increment download counters asynchronously
  const incrementPromise = (async () => {
    const ver = await env.DB.prepare(
      `SELECT id, package_id FROM package_versions WHERE r2_key = ? LIMIT 1`,
    )
      .bind(r2Key)
      .first<{ id: number; package_id: number }>();

    if (ver) {
      await env.DB.prepare(`UPDATE package_versions SET downloads = downloads + 1 WHERE id = ?`)
        .bind(ver.id)
        .run();
      await env.DB.prepare(`UPDATE packages SET total_downloads = total_downloads + 1 WHERE id = ?`)
        .bind(ver.package_id)
        .run();
    }
  })().catch(() => {});

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(incrementPromise);
  }

  const headers = new Headers();
  const contentType =
    obj.httpMetadata?.contentType ||
    (r2Key.endsWith(".zst") ? "application/zstd" : r2Key.endsWith(".tgz") ? "application/gzip" : "application/octet-stream");
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", ARCHIVE_CACHE_CONTROL);
  if (obj.httpEtag) {
    headers.set("ETag", obj.httpEtag);
  } else if (obj.etag) {
    headers.set("ETag", `"${obj.etag}"`);
  }
  if (typeof obj.size === "number") {
    headers.set("Content-Length", String(obj.size));
  }

  return new Response(obj.body, {
    status: 200,
    headers,
  });
}
