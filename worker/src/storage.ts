// R2 storage, archive magic verification (.cap Zstd & .tgz), SRI integrity, and Sparse Index writer
import { sha256Hex } from "./auth";
import type { Env, PackageRow, SparseIndexDoc, VersionRow } from "./types";

export type ArchiveFormat = "cap" | "zst" | "tgz";

/**
 * Inspects archive magic bytes matching `cap/src/project/archive.zig`:
 * - Zstd (`.cap` / `.tar.zst`): 28 B5 2F FD (preferred high-compression format)
 * - Gzip (`.tgz`):              1F 8B       (npm-compatible fallback)
 */
export function detectArchiveFormat(bytes: Uint8Array): ArchiveFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return "cap";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "tgz";
  }
  return null;
}

export function splitPackageName(fullName: string): { scope: string; shortName: string } | null {
  const trimmed = fullName.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 2 || slash >= trimmed.length - 1) return null;
    const scope = trimmed.slice(0, slash);
    const shortName = trimmed.slice(slash + 1);
    if (!/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(scope)) return null;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(shortName)) return null;
    return { scope, shortName };
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed)) return null;
  return { scope: "", shortName: trimmed };
}

export function isValidSemver(ver: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(ver);
}

/**
 * Canonical R2 key for stored packages:
 * - Zstd high-compression archives use unified `.cap` suffix (`pkg/@cap/lru/1.0.0/cap-lru-1.0.0.cap`)
 * - Legacy npm-compatible gzip archives use `.tgz`
 */
export function archiveR2Key(pkgName: string, version: string, format: ArchiveFormat): string {
  const ext = format === "tgz" ? "tgz" : "cap";
  const safeBase = pkgName.replace(/^@/, "").replace(/\//g, "-");
  return `pkg/${pkgName}/${version}/${safeBase}-${version}.${ext}`;
}

export function sparseIndexR2Key(pkgName: string): string {
  return `index/${pkgName}.json`;
}

export async function computeSha256Integrity(bytes: Uint8Array): Promise<string> {
  const hex = await sha256Hex(bytes);
  return `sha256-${hex}`;
}

export async function verifyIntegrity(bytes: Uint8Array, expected: string): Promise<boolean> {
  if (expected.startsWith("sha256-")) {
    const actual = await computeSha256Integrity(bytes);
    return actual.toLowerCase() === expected.toLowerCase();
  }
  if (expected.startsWith("sha512-")) {
    const digest = await crypto.subtle.digest("SHA-512", bytes);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return `sha512-${b64}` === expected;
  }
  return false;
}

/**
 * Rebuilds and writes the static Sparse Index JSON for a package to R2 (`index/<pkg>.json`),
 * embedding SHA-256 integrity, security scan status, and capdux.org Ed25519 platform signature.
 */
export async function syncSparseIndex(env: Env, pkg: PackageRow): Promise<SparseIndexDoc> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM package_versions WHERE package_id = ? ORDER BY published_at DESC`,
  )
    .bind(pkg.id)
    .all<VersionRow>();

  const dlOrigin = env.DOWNLOAD_ORIGIN || "https://dl.capdux.org";
  const doc: SparseIndexDoc = {
    name: pkg.name,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    latest: pkg.latest_version,
    updated_at: pkg.updated_at,
    versions: (results || []).map((v) => {
      let deps: Record<string, string> = {};
      try {
        deps = JSON.parse(v.deps_json || "{}");
      } catch {}
      let permissions: Record<string, unknown> | undefined;
      try {
        const p = JSON.parse(v.permissions_json || "{}");
        if (p && Object.keys(p).length > 0) permissions = p;
      } catch {}
      let prebuilt: Record<string, { url: string; integrity: string; size: number }> | undefined;
      try {
        const parsed = JSON.parse(v.prebuilt_json || "{}");
        if (parsed && Object.keys(parsed).length > 0) {
          prebuilt = {};
          for (const [target, info] of Object.entries(parsed) as [string, any][]) {
            prebuilt[target] = {
              url: `${dlOrigin}/${info.r2_key}`,
              integrity: info.integrity,
              size: info.size,
            };
          }
        }
      } catch {}
      return {
        ver: v.version,
        deps,
        format: v.archive_format,
        integrity: v.integrity,
        size: v.archive_size,
        unpacked_size: v.unpacked_size,
        url: `${dlOrigin}/${v.r2_key}`,
        security_status: v.security_status || "verified",
        platform_sig: v.platform_sig || "",
        signing_key_id: v.signing_key_id || "capdux-ed25519-v1",
        ...(permissions ? { permissions } : {}),
        ...(prebuilt ? { prebuilt } : {}),
        ...(v.yanked ? { yanked: true } : {}),
        published_at: v.published_at,
      };
    }),
  };

  await env.BUCKET.put(sparseIndexR2Key(pkg.name), JSON.stringify(doc), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=60, stale-while-revalidate=300",
    },
  });

  return doc;
}
