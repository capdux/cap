// End-to-end unit tests for capdux.org Cloudflare Worker Registry API
// Uses bun:sqlite (executing migrations/0001_init.sql) as Mock D1 and Map as Mock R2.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "../src/index";
import { computeSha256Integrity } from "../src/storage";
import type { Env } from "../src/types";

// ---------------------------------------------------------------------------
// Lightweight Mock D1 backed by bun:sqlite
// ---------------------------------------------------------------------------
class MockD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): MockD1Statement {
    this.params = values;
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.query(this.sql);
    const row = stmt.get(...(this.params as any[])) as Record<string, unknown> | null;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
    const stmt = this.db.query(this.sql);
    const rows = stmt.all(...(this.params as any[])) as T[];
    return { results: rows, success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown> }> {
    const stmt = this.db.query(this.sql);
    const info = stmt.run(...(this.params as any[]));
    return {
      success: true,
      meta: {
        changes: (info as any)?.changes ?? 0,
        last_row_id: (info as any)?.lastInsertRowid ?? 0,
      },
    };
  }
}

class MockD1Database {
  public readonly sqlite: Database;

  constructor(schemaSql: string) {
    this.sqlite = new Database(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec(schemaSql);
  }

  prepare(query: string): MockD1Statement {
    return new MockD1Statement(this.sqlite, query);
  }
}

// ---------------------------------------------------------------------------
// Lightweight Mock R2 backed by Map
// ---------------------------------------------------------------------------
interface StoredR2Entry {
  data: Uint8Array;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  etag: string;
}

class MockR2Bucket {
  public readonly store = new Map<string, StoredR2Entry>();

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      const ab = await new Response(value).arrayBuffer();
      bytes = new Uint8Array(ab);
    }

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const etag = Array.from(new Uint8Array(digest).slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    this.store.set(key, {
      data: bytes,
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
      etag,
    });
  }

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const copy = new Uint8Array(entry.data);
    return {
      key,
      size: copy.byteLength,
      etag: entry.etag,
      httpEtag: `"${entry.etag}"`,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
      },
      async text() {
        return new TextDecoder().decode(copy);
      },
      async json<T = unknown>() {
        return JSON.parse(new TextDecoder().decode(copy)) as T;
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class MockExecutionContext {
  private pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  passThroughOnException(): void {}

  async flush(): Promise<void> {
    await Promise.all(this.pending);
    this.pending = [];
  }
}

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------
function makeFakeZstdPayload(tag = "cap-zstd-payload"): Uint8Array {
  const payload = new TextEncoder().encode(tag);
  const out = new Uint8Array(4 + payload.length);
  // Real Zstd magic number: 28 B5 2F FD
  out[0] = 0x28;
  out[1] = 0xb5;
  out[2] = 0x2f;
  out[3] = 0xfd;
  out.set(payload, 4);
  return out;
}

function makeFakeGzipPayload(tag = "cap-gzip-payload"): Uint8Array {
  const payload = new TextEncoder().encode(tag);
  const out = new Uint8Array(2 + payload.length);
  // Real Gzip magic number: 1F 8B
  out[0] = 0x1f;
  out[1] = 0x8b;
  out.set(payload, 2);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// End-to-End Test Suite
// ---------------------------------------------------------------------------
describe("capdux.org Cloudflare Worker Registry API", () => {
  let db: MockD1Database;
  let bucket: MockR2Bucket;
  let env: Env;
  let ctx: MockExecutionContext;

  let adminToken = "";
  let userToken = "";
  let publishedR2Key = "";
  let publishedBytes: Uint8Array;

  beforeAll(() => {
    const schemaPath = resolve(import.meta.dir, "../../migrations/0001_init.sql");
    const schemaSql = readFileSync(schemaPath, "utf8");
    db = new MockD1Database(schemaSql);
    bucket = new MockR2Bucket();
    ctx = new MockExecutionContext();
    env = {
      DB: db as unknown as D1Database,
      BUCKET: bucket as unknown as R2Bucket,
      REGISTRY_ORIGIN: "https://registry.capdux.org",
      DOWNLOAD_ORIGIN: "https://dl.capdux.org",
      INDEX_ORIGIN: "https://index.capdux.org",
      WEB_ORIGIN: "https://capdux.org",
      MAX_TARBALL_BYTES: "1048576",
    };
  });

  async function req(path: string, init?: RequestInit, host = "registry.capdux.org"): Promise<Response> {
    const url = path.startsWith("http") ? path : `https://${host}${path}`;
    return worker.fetch(new Request(url, init), env, ctx as unknown as ExecutionContext);
  }

  test("GET /health returns 200 ok with CORS headers", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("capdux-registry");
  });

  test("Auth: first user becomes admin, second becomes regular user, login & whoami & token lifecycle work", async () => {
    // 1. Register first user -> auto-promoted to admin
    const regAdmin = await req("/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "founder",
        email: "founder@capdux.org",
        password: "super-secret-password",
      }),
    });
    expect(regAdmin.status).toBe(201);
    const adminBody = (await regAdmin.json()) as any;
    expect(adminBody.user.role).toBe("admin");
    expect(adminBody.token).toMatch(/^capdux_[0-9a-f]{48}$/);
    adminToken = adminBody.token;

    // 2. Duplicate registration -> 409
    const dupReg = await req("/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "founder",
        email: "founder2@capdux.org",
        password: "another-password",
      }),
    });
    expect(dupReg.status).toBe(409);

    // 3. Register second user -> regular 'user'
    const regUser = await req("/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        email: "alice@example.com",
        password: "alice-password-123",
      }),
    });
    expect(regUser.status).toBe(201);
    const userBody = (await regUser.json()) as any;
    expect(userBody.user.role).toBe("user");
    userToken = userBody.token;

    // 4. Login with wrong password -> 401
    const badLogin = await req("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "founder", password: "wrong-password" }),
    });
    expect(badLogin.status).toBe(401);

    // 5. Login with correct password -> new capdux_* token
    const goodLogin = await req("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "founder", password: "super-secret-password" }),
    });
    expect(goodLogin.status).toBe(200);
    const loginBody = (await goodLogin.json()) as any;
    expect(loginBody.token).toMatch(/^capdux_/);
    expect(loginBody.token).not.toBe(adminToken);

    // 6. Whoami with Bearer token
    const whoami = await req("/v1/auth/whoami", {
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    expect(whoami.status).toBe(200);
    const whoBody = (await whoami.json()) as any;
    expect(whoBody.username).toBe("founder");
    expect(whoBody.role).toBe("admin");

    // 7. Create & revoke token
    const createTok = await req("/v1/auth/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "ci-bot", scope: "read" }),
    });
    expect(createTok.status).toBe(201);
    const tokData = (await createTok.json()) as any;
    expect(tokData.token).toMatch(/^capdux_/);
    expect(tokData.id).toBeGreaterThan(0);

    // Verify new token works
    const checkTok = await req("/v1/auth/whoami", {
      headers: { Authorization: `Bearer ${tokData.token}` },
    });
    expect(checkTok.status).toBe(200);

    // Revoke token
    const revokeRes = await req(`/v1/auth/tokens/${tokData.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(revokeRes.status).toBe(200);

    // Revoked token must now fail with 401
    const checkRevoked = await req("/v1/auth/whoami", {
      headers: { Authorization: `Bearer ${tokData.token}` },
    });
    expect(checkRevoked.status).toBe(401);
  });

  test("Publish valid .tar.zst (28 B5 2F FD) via multipart/form-data & fetch package metadata", async () => {
    publishedBytes = makeFakeZstdPayload("lru-cache-v1.0.0-source");
    const integrity = await computeSha256Integrity(publishedBytes);

    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        name: "@cap/lru",
        version: "1.0.0",
        description: "Zero-allocation O(1) LRU cache for CP",
        license: "MIT",
        repository: "https://github.com/cp-lang/cp",
        keywords: ["lru", "cache", "datastructure"],
        dependencies: { "@cap/hash": "^1.0.0" },
        integrity,
        unpacked_size: 4096,
      }),
    );
    form.set("archive", new Blob([publishedBytes], { type: "application/zstd" }), "cap-lru-1.0.0.tar.zst");
    form.set("readme", "# @cap/lru\nFast LRU cache.");
    form.set("types_dcp", "pub class LruCache<K, V> {}");

    const pubRes = await req("/v1/publish", {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    expect(pubRes.status).toBe(201);
    const pubBody = (await pubRes.json()) as any;
    expect(pubBody.ok).toBe(true);
    expect(pubBody.name).toBe("@cap/lru");
    expect(pubBody.version).toBe("1.0.0");
    expect(pubBody.format).toBe("zst");
    expect(pubBody.integrity).toBe(integrity);
    expect(pubBody.r2_key).toBe("pkg/@cap/lru/1.0.0/cap-lru-1.0.0.tar.zst");
    publishedR2Key = pubBody.r2_key;

    // Fetch package metadata
    const metaRes = await req("/v1/packages/@cap/lru");
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as any;
    expect(meta.name).toBe("@cap/lru");
    expect(meta["dist-tags"].latest).toBe("1.0.0");
    expect(meta.versions.length).toBe(1);
    expect(meta.versions[0].version).toBe("1.0.0");
    expect(meta.versions[0].format).toBe("zst");
    expect(meta.versions[0].readme_md).toContain("Fast LRU cache");
    expect(meta.versions[0].types_dcp).toContain("LruCache");
  });

  test("Publish rejects invalid magic bytes (400), mismatched SRI (400), duplicate version (409), and unauthorized scope (403)", async () => {
    // 1. Invalid magic bytes -> 400
    const badBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const badMagicRes = await req("/v1/publish", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "bad-magic-pkg",
        version: "0.1.0",
        archive_base64: toBase64(badBytes),
      }),
    });
    expect(badMagicRes.status).toBe(400);

    // 2. Wrong SRI integrity -> 400
    const validZst = makeFakeZstdPayload("sri-mismatch-test");
    const badSriRes = await req("/v1/publish", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "sri-test-pkg",
        version: "0.1.0",
        integrity: "sha256-0000000000000000000000000000000000000000000000000000000000000000",
        archive_base64: toBase64(validZst),
      }),
    });
    expect(badSriRes.status).toBe(400);

    // 3. Duplicate version @cap/lru@1.0.0 -> 409 Conflict
    const dupVerRes = await req("/v1/publish", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "@cap/lru",
        version: "1.0.0",
        archive_base64: toBase64(validZst),
      }),
    });
    expect(dupVerRes.status).toBe(409);

    // 4. Regular user cannot publish to official @cap scope -> 403 Forbidden
    const forbiddenRes = await req("/v1/publish", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "@cap/hijack",
        version: "1.0.0",
        archive_base64: toBase64(validZst),
      }),
    });
    expect(forbiddenRes.status).toBe(403);

    // 5. Regular user CAN publish an unscoped .tgz package via JSON base64
    const tgzBytes = makeFakeGzipPayload("alice-util-tgz");
    const okUserPub = await req("/v1/publish", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "alice-util",
        version: "0.2.0",
        description: "Community utility package",
        archive_base64: toBase64(tgzBytes),
      }),
    });
    expect(okUserPub.status).toBe(201);
    const okUserBody = (await okUserPub.json()) as any;
    expect(okUserBody.format).toBe("tgz");
  });

  test("Sparse Index hits R2 cache, falls back to D1 on miss, and repopulates R2", async () => {
    // 1. After publish, R2 already has index/@cap/lru.json -> X-Cache: HIT
    const hitRes = await req("/index/@cap/lru.json");
    expect(hitRes.status).toBe(200);
    expect(hitRes.headers.get("X-Cache")).toBe("HIT");
    expect(hitRes.headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=300");
    const doc1 = (await hitRes.json()) as any;
    expect(doc1.name).toBe("@cap/lru");
    expect(doc1.latest).toBe("1.0.0");
    expect(doc1.versions.length).toBe(1);
    expect(doc1.versions[0].format).toBe("zst");

    // 2. Evict from R2 to force D1 fallback -> X-Cache: MISS
    await bucket.delete("index/@cap/lru.json");
    const missRes = await req("/index/@cap/lru.json");
    expect(missRes.status).toBe(200);
    expect(missRes.headers.get("X-Cache")).toBe("MISS");
    const doc2 = (await missRes.json()) as any;
    expect(doc2.name).toBe("@cap/lru");
    expect(doc2.versions[0].ver).toBe("1.0.0");

    // 3. Subsequent request hits newly populated R2 cache -> X-Cache: HIT
    const hitAgain = await req("/index/@cap/lru.json");
    expect(hitAgain.status).toBe(200);
    expect(hitAgain.headers.get("X-Cache")).toBe("HIT");
  });

  test("GET /dl/<r2_key> streams archive with immutable cache headers & increments download counts", async () => {
    const dlRes = await req(`/dl/${publishedR2Key}`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(dlRes.headers.get("ETag")).toBeTruthy();

    const received = new Uint8Array(await dlRes.arrayBuffer());
    expect(received).toEqual(publishedBytes);

    // Flush ctx.waitUntil so async download counter updates finish
    await ctx.flush();

    const metaRes = await req("/v1/packages/@cap/lru");
    const meta = (await metaRes.json()) as any;
    expect(meta.total_downloads).toBe(1);
    expect(meta.versions[0].downloads).toBe(1);
  });

  test("Yank and unyank version updates D1 and refreshes R2 Sparse Index", async () => {
    // Yank
    const yankRes = await req("/v1/packages/@cap/lru/1.0.0/yank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "critical bug in eviction" }),
    });
    expect(yankRes.status).toBe(200);
    const yankBody = (await yankRes.json()) as any;
    expect(yankBody.yanked).toBe(true);

    // Sparse Index in R2 should immediately reflect yanked: true
    const idxAfterYank = await req("/index/@cap/lru.json");
    expect(idxAfterYank.headers.get("X-Cache")).toBe("HIT");
    const idxDoc1 = (await idxAfterYank.json()) as any;
    expect(idxDoc1.versions[0].yanked).toBe(true);

    // Unyank
    const unyankRes = await req("/v1/packages/@cap/lru/1.0.0/unyank", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(unyankRes.status).toBe(200);

    const idxAfterUnyank = await req("/index/@cap/lru.json");
    const idxDoc2 = (await idxAfterUnyank.json()) as any;
    expect(idxDoc2.versions[0].yanked).toBeUndefined();
  });

  test("Search, Stats, and Global Deduplication Registry sync (/v1/registry/sync & /v1/registry.json)", async () => {
    // Search
    const searchRes = await req("/v1/search?q=lru&scope=@cap&sort=downloads");
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as any;
    expect(searchBody.total).toBe(1);
    expect(searchBody.packages[0].name).toBe("@cap/lru");

    // Non-admin cannot sync registry -> 403
    const nonAdminSync = await req("/v1/registry/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: [] }),
    });
    expect(nonAdminSync.status).toBe(403);

    // Admin syncs npm & crates.io deduplication entries
    const syncRes = await req("/v1/registry/sync", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entries: [
          {
            source_registry: "npm",
            source_name: "lru-cache",
            source_repo: "https://github.com/isaacs/node-lru-cache",
            license: "ISC",
            cp_target: "@cap/lru",
            kind: "package",
            aliases: ["quick-lru"],
          },
          {
            source_registry: "crates.io",
            source_name: "bytes",
            source_repo: "https://github.com/tokio-rs/bytes",
            license: "MIT",
            cp_target: "cap:bytes",
            kind: "stdlib",
            aliases: ["bytesize"],
          },
        ],
      }),
    });
    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as any;
    expect(syncBody.ok).toBe(true);
    expect(syncBody.synced).toBe(2);
    expect(syncBody.total).toBe(2);

    // GET /v1/registry.json & GET /registry.json
    const regV1 = await req("/v1/registry.json");
    expect(regV1.status).toBe(200);
    const regV1Doc = (await regV1.json()) as any;
    expect(regV1Doc.version).toBe("1.0.0");
    expect(regV1Doc.entries.length).toBe(2);
    expect(regV1Doc.entries.some((e: any) => e.source_name === "lru-cache" && e.cp_target === "@cap/lru")).toBe(true);

    const regRoot = await req("/registry.json");
    expect(regRoot.status).toBe(200);
    const regRootDoc = (await regRoot.json()) as any;
    expect(regRootDoc.entries.length).toBe(2);

    // GET /v1/stats
    const statsRes = await req("/v1/stats");
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as any;
    expect(stats.packages).toBe(2); // @cap/lru + alice-util
    expect(stats.versions).toBe(2);
    expect(stats.total_downloads).toBe(1);
    expect(stats.mappings).toBe(2);
  });
});
